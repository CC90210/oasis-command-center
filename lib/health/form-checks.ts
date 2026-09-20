/**
 * lib/health/form-checks.ts — outcome checks for the public form intake.
 *
 * Born from the or() parser crash (#224, 2026-08-18): nine days of public-form
 * submissions destroyed pre-insert with no alert, because nothing watched the
 * intake path itself. The dead-letter table (146_form_submit_failures) now
 * captures every blocked submission; this check is what keeps it LOUD — red on
 * the 15-minute cron until a human closes every open row, recovery announced
 * by the runner like every other check.
 */

import "server-only";
import type { DripCheck } from "./drip-checks";

const iso = (ms: number) => new Date(ms).toISOString();
const OPEN_WINDOW_MS = 48 * 3_600_000;
/**
 * How long a job may sit in a non-terminal state before the consumer that owns
 * it is presumed dead. Generous on purpose: the 15-minute health cron must see
 * two clean passes over a slow job before it says anything, and a false page
 * about a daemon is the fastest way to teach people to ignore pages about it.
 */
const STALLED_AFTER_MS = 30 * 60_000;

export const FORM_CHECKS: DripCheck[] = [
  {
    // A blocked merchant application that nobody has recovered yet. The inline
    // page from captureSubmitFailure is the instant signal; this is the one
    // that cannot be missed or forgotten, because it re-asserts on the ladder
    // until recovered_at is set on every row.
    id: "forms.submit_failures_open",
    severity: "critical",
    // BOTH lanes, because this check is estate-wide by design (see observe()
    // below — it deliberately ignores tenantId). Undeclared it fell to the
    // runner's default, SunBiz's lane, so an OASIS merchant's blocked
    // submission re-asserted into the client's channel every 15 minutes while
    // the person who could recover them never heard. The instant page from
    // captureSubmitFailure now resolves its lane from the tenant; this is the
    // re-assertion that has no tenant to resolve, so it tells everyone.
    lane: ["operator", "sunbiz-ops"],
    rule: { kind: "must_be_zero" },
    // The dead-letter table is estate-wide (tenant_slug is advisory text from
    // the failure itself), so this check deliberately ignores the tenantId the
    // runner passes: a blocked application is a blocked application.
    observe: async (db, _tenantId, endMs) => {
      try {
        const r = await db
          .from("form_submit_failures")
          .select("id", { count: "exact", head: true })
          .is("recovered_at", null)
          .gte("created_at", iso(endMs - OPEN_WINDOW_MS))
          .lt("created_at", iso(endMs));
        if (r.error) return null;
        return r.count ?? 0;
      } catch {
        return null;
      }
    },
    describe: (r) =>
      `${r.observed} blocked form submission(s) in the last 48h with no recovery recorded. ` +
      `Each row in form_submit_failures holds the merchant's answers — contact them, then set recovered_at. ` +
      `This exact silence cost nine days of dotted-email applications.`,
  },
  {
    /**
     * A rep dropped an application PDF into the pipeline and the reader could
     * not process it.
     *
     * Born from the same class of silence as the check above (2026-08-26): the
     * 2026-08-09 Turso/R2 cutover moved object storage, the VPS extraction
     * daemon never got the credentials or the code to read it back, and EVERY
     * drop failed from that day on. The only signal in existence was a red
     * "Couldn't read it (download_failed)" on the rep's own screen. The rep
     * stopped using the feature and went back to JotForm; we found out three
     * weeks later from a WhatsApp screenshot.
     *
     * `document_extraction_jobs` is where that outage was fully recorded the
     * entire time — nothing was ever asked to look. This is that ask. It would
     * have fired at 18:12 on 2026-08-25, the first failed drop.
     */
    id: "forms.extraction_jobs_failed",
    severity: "critical",
    rule: { kind: "must_be_zero" },
    // Tenant-scoped: unlike the estate-wide dead-letter table above, an
    // extraction job carries the real tenant_id it was queued under, so this
    // grades the tenant the runner is actually checking.
    observe: async (db, tenantId, endMs) => {
      try {
        const r = await db
          .from("document_extraction_jobs")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("status", "failed")
          .gte("created_at", iso(endMs - OPEN_WINDOW_MS))
          .lt("created_at", iso(endMs));
        if (r.error) return null;
        return r.count ?? 0;
      } catch {
        return null;
      }
    },
    describe: (r) =>
      `${r.observed} dropped application(s) in the last 48h that the reader could not process. ` +
      `The rep saw a red error and had to fill the deal in by hand. ` +
      `Read the \`error\` column of document_extraction_jobs: a \`blocked:\` prefix means the ` +
      `daemon is misconfigured and a human must fix it — retrying will never clear it.`,
  },
  {
    /**
     * The reader stopped reading.
     *
     * The check above counts jobs that FAILED. A daemon that is dead does not
     * fail anything — it simply stops taking work, and the rows sit in
     * `queued` forever. Failures go to zero, the check above goes green, and
     * the only person who knows is the rep watching a spinner. Absence of
     * failure is not evidence of success; it is the shape a dead consumer
     * makes.
     *
     * That matters more here than anywhere else in this file because the
     * consumer is the ONE part of the intake path that does not run on
     * Cloudflare. It is a PM2 process on srv1723601, deliberately single-
     * instance (two consumers double-process every job), and as of 2026-09-06
     * that box was 82 commits behind main. Work shipped from CC's side reaches
     * the edge in minutes and reaches that host only when a human copies it.
     * Nothing on this side could see whether it was alive.
     *
     * This is that ask, and it needs no SSH: a job that has not reached a
     * terminal state in 30 minutes means the process that owns the queue is
     * not owning it.
     *
     * DELIBERATELY UNBOUNDED IN AGE. Its sibling looks back 48h, which is
     * right for counting failures. Applied here it would be a trap: a daemon
     * dead for three days would see its stuck rows age out of the window and
     * the check would go green while the daemon was still dead. A stuck row
     * stays counted until a human resolves it — by fixing the consumer, or by
     * marking the job failed, which is a truthful statement about a job that
     * is never going to be read.
     */
    id: "forms.extraction_queue_stalled",
    severity: "critical",
    rule: { kind: "must_be_zero" },
    // Explicitly SunBiz's lane, not the runner's default. The "drop an
    // application" feature is SunBiz-only by construction — every row in the
    // table belongs to tenant aa04fa1f — so this names the audience rather
    // than inheriting it. IF extraction is ever offered to a second tenant,
    // this must resolve the lane from the tenant instead: a static lane on a
    // tenant-scoped check is the same defect the rest of this branch fixes.
    lane: "sunbiz-ops",
    observe: async (db, tenantId, endMs) => {
      try {
        const r = await db
          .from("document_extraction_jobs")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          // queued|processing|extracted are the three non-terminal states in
          // 104_document_extraction_jobs.sql. `extracted` counts too: the read
          // succeeded but the apply step never ran, and the rep is still
          // looking at an application that never populated.
          .in("status", ["queued", "processing", "extracted"])
          .lt("created_at", iso(endMs - STALLED_AFTER_MS));
        if (r.error) return null;
        return r.count ?? 0;
      } catch {
        return null;
      }
    },
    describe: (r) =>
      `${r.observed} dropped application(s) have sat unread for over 30 minutes. ` +
      `The extraction consumer is a PM2 process on srv1723601 and it is the only ` +
      `thing that moves these rows; nothing else will. Check it with ` +
      `\`pm2 list\` and \`.venv/bin/python scripts/integrations/extraction_consumer.py doctor\` ` +
      `(the venv is .venv, not venv). Exactly one consumer may run fleet-wide. ` +
      `A row that is never going to be read should be marked failed, not left queued.`,
  },
];
