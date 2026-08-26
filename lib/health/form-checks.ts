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

export const FORM_CHECKS: DripCheck[] = [
  {
    // A blocked merchant application that nobody has recovered yet. The inline
    // page from captureSubmitFailure is the instant signal; this is the one
    // that cannot be missed or forgotten, because it re-asserts on the ladder
    // until recovered_at is set on every row.
    id: "forms.submit_failures_open",
    severity: "critical",
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
];
