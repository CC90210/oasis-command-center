/**
 * /sequences — operator-facing list of tenant drip sequences (Phase 4.4).
 *
 * The bridge-side sequence-runner daemon executes; this page is the
 * operator UX for the drip definitions it consumes.
 */

import { PageHeader } from "@/components/Card";
import { getActiveProfile, getBridgeOnline } from "@/lib/queries";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { safe, isMissingTableError } from "@/lib/api-helpers";
import { SequencesTabs } from "@/components/sequences/SequencesTabs";
import { recentDripActivity, dripFailureSummary } from "@/lib/drips/activity-queries";
import { sequenceScoreboard } from "@/lib/drips/scoreboard";
import { sequenceDailyVolume } from "@/lib/drips/sequence-volume";
import { joinVolumeToSequences } from "@/lib/drips/sequence-volume-core";
import { getChannelLimits } from "@/lib/drips/channel-limits";
import { LIMIT_DEFAULT } from "@/lib/drips/channel-limits-core";

/** The all-zero summary. Named so the "no tenant" case and the "read failed"
 *  case cannot drift into two subtly different sets of zeros. */
const EMPTY_SUMMARY = {
  realSends: 0,
  failed: 0,
  skipped: 0,
  dryRun: 0,
  failureRatePct: null as number | null,
  heldForPolicy: 0,
  truncated: false,
};
import { loadApprovedPool } from "@/lib/drips/template-pool-store";
import { AlertCircle, Cpu, Cloud, Download } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

import type { DripStep } from "@/lib/drips/types";

type SequenceRow = {
  id: string;
  name: string;
  description: string | null;
  trigger_event: string;
  trigger_filter: Record<string, unknown>;
  steps: DripStep[];
  enabled: boolean;
  one_per_lead: boolean;
  email_class?: string;
  daily_email_cap?: number | null;
};

async function loadSequences(tenantId: string | null): Promise<
  | { ok: true; rows: SequenceRow[] }
  | { ok: false; reason: "no_tenant" | "migration_not_applied" | "db_error"; detail?: string }
> {
  if (!tenantId) return { ok: false, reason: "no_tenant" };
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("drip_sequences")
    .select(
      "id, name, description, trigger_event, trigger_filter, steps, enabled, one_per_lead, email_class, daily_email_cap",
    )
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingTableError(error, "public.drip_sequences")) {
      return { ok: false, reason: "migration_not_applied" };
    }
    return { ok: false, reason: "db_error", detail: error.message };
  }
  return { ok: true, rows: (data as SequenceRow[]) || [] };
}

export default async function SequencesPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await safe("sequences.profile", getActiveProfile(), null);
  const tenantId = profile?.tenant_id || null;
  // Activity loads alongside the sequences. `safe` catches a REJECTION per read,
  // so one failing query degrades to its fallback instead of 500-ing the page.
  // It is not a timeout: Promise.all still waits for the slowest read, so a slow
  // activity query does hold the whole page. Saying "cannot take the page down"
  // would be claiming a protection that is not here.
  const [result, bridgeOnline, activityRes, volumeRes, smsVolumeRes, limits, pool, summaryRes, scoreboardRes] = await Promise.all([
    loadSequences(tenantId),
    safe("sequences.bridge_online", getBridgeOnline(tenantId), false),
    // Wrapped so a read FAILURE is distinguishable from an empty window. `safe`
    // swallows the rejection and hands back [], which DripActivityView would
    // render as "no drip steps in this window - that is a finding, not a
    // blank". So a broken query would tell the operator nothing was sent, which
    // is the exact false signal this tab was built to remove.
    safe(
      "sequences.activity",
      tenantId
        ? recentDripActivity(tenantId, { limit: 300 }).then(
            (rows) => ({ rows, error: null as string | null }),
          )
        : Promise.resolve({ rows: [], error: null as string | null }),
      { rows: [], error: "could not read drip activity" },
    ),
    // Per-sequence daily volume. Read failures are carried, never flattened to
    // an empty chart: a blank picture is the most reassuring thing this tab can
    // show, and an operator would set a cap against it.
    safe(
      "sequences.volume",
      tenantId
        ? sequenceDailyVolume(tenantId, { days: 14 })
        : Promise.resolve({ volumes: [], timeZone: "UTC", days: 14, error: null, truncated: false }),
      { volumes: [], timeZone: "UTC", days: 14, error: "could not read sequence volume", truncated: false },
    ),
    // The SMS meter. Same shape, same source, different interaction type — so
    // the two charts are directly comparable and neither can quietly measure
    // something the other does not.
    safe(
      "sequences.volume.sms",
      tenantId
        ? sequenceDailyVolume(tenantId, { days: 14, channel: "sms" })
        : Promise.resolve({ volumes: [], timeZone: "UTC", days: 14, error: null, truncated: false }),
      { volumes: [], timeZone: "UTC", days: 14, error: "could not read text volume", truncated: false },
    ),
    // The per-channel ceilings the operator can move. Resolved server-side so
    // the form opens on the values the ENGINE is using, not on the defaults.
    safe(
      "sequences.limits",
      tenantId ? getChannelLimits(tenantId) : Promise.resolve(LIMIT_DEFAULT),
      LIMIT_DEFAULT,
    ),
    safe(
      "sequences.template_pool",
      tenantId ? loadApprovedPool(getServiceSupabase(), tenantId) : Promise.resolve([]),
      [],
    ),
    // Same reasoning: a zeroed summary from a failed read is indistinguishable
    // from a genuinely quiet day, and zero failures is the most reassuring
    // number on the page.
    safe(
      "sequences.activity_summary",
      tenantId
        ? dripFailureSummary(tenantId).then((s) => ({ ...s, error: null as string | null }))
        : Promise.resolve({ ...EMPTY_SUMMARY, error: null as string | null }),
      { ...EMPTY_SUMMARY, error: "could not read the drip summary" },
    ),
    // Per-sequence rollup. Its OWN read with its OWN error, deliberately not
    // folded into the activity read: the table is capped at 300 rows a half and
    // this walks the whole window, so one being short must not mark the other
    // unknown. A failed read here renders as UNKNOWN, never as an empty board.
    safe(
      "sequences.scoreboard",
      tenantId
        ? sequenceScoreboard(tenantId)
        : Promise.resolve({ scores: [], days: 7, truncated: false, error: null }),
      { scores: [], days: 7, truncated: false, error: "could not read per-sequence outcomes" },
    ),
  ]);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Drips"
        subtitle="Activity shows what actually went out. Templates is every step's copy, with template interchange per step. Manage toggles sequences on and off. Deep email performance stays in Metrics."
      />

      {/* Bridge-online banner — drip sequences are run by the
          sequence-runner daemon on the operator's machine, exactly like
          cron jobs are run by cron_engine. Without the bridge, saved
          sequences never fire. Mirrors the banner on /automations so
          operators get a consistent "is my machine connected" signal
          across both surfaces. Self-review consistency 2026-05-24. */}
      <div className="rounded-xl border border-bg-border bg-bg-deep/40 p-4 flex items-start gap-3">
        {bridgeOnline ? (
          <Cpu className="w-5 h-5 text-status-engaged shrink-0 mt-0.5" />
        ) : (
          <Cloud className="w-5 h-5 text-fg-dim shrink-0 mt-0.5" />
        )}
        <div className="flex-1 text-xs leading-relaxed">
          {bridgeOnline ? (
            <>
              <span className="text-status-engaged font-bold">Your computer is connected.</span>{" "}
              Sequences fire automatically when a lead or application hits the trigger
              stage. Edits take effect within a minute. Toggle one off to pause without
              losing the spec.
            </>
          ) : (
            <>
              <span className="text-fg-muted font-bold">Computer not connected yet.</span>{" "}
              Sequences you create here are saved, but the sequence-runner daemon needs a
              paired machine to actually send the SMS / email steps. Pair a device and
              they&apos;ll start firing within a minute.
            </>
          )}
        </div>
        {!bridgeOnline && (
          <Link
            href="/settings/devices/install"
            className="btn-primary inline-flex items-center gap-1.5 text-xs shrink-0"
          >
            <Download className="w-3 h-3" />
            Install bridge
          </Link>
        )}
      </div>

      {!result.ok && result.reason === "no_tenant" && (
        <div className="rounded-xl border border-status-warm/40 bg-status-warm/5 p-4 text-sm text-status-warm flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>No tenant resolved for this user. Complete onboarding first.</span>
        </div>
      )}

      {!result.ok && result.reason === "migration_not_applied" && (
        <div className="rounded-xl border border-accent/40 bg-accent/5 p-4 space-y-2">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-accent shrink-0 mt-0.5" />
            <div className="flex-1 text-sm">
              <div className="font-bold text-fg">One-time setup required</div>
              <p className="text-xs text-fg-muted mt-1 leading-relaxed">
                The Drip Sequences feature needs migration 043 applied to your
                Supabase project. Run the command below on the operator machine.
                After it completes, refresh the page.
              </p>
            </div>
          </div>
          <div className="rounded-md bg-bg-deep border border-bg-border p-2.5 font-mono text-[11px] text-fg-muted select-all">
            python scripts/apply_migration.py database/043_drip_sequences.sql
          </div>
        </div>
      )}

      {!result.ok && result.reason === "db_error" && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-400">
          <div className="font-bold">Couldn&apos;t load sequences.</div>
          <div className="text-xs mt-1 font-mono">{result.detail}</div>
        </div>
      )}

      {result.ok && (
        <SequencesTabs
          rows={result.rows}
          activity={activityRes.rows}
          activitySummary={summaryRes}
          // Two reads, two verdicts. Merging them would mark the table unknown
          // because the summary query failed, hiding rows that are perfectly
          // good -- and the reverse.
          activityError={activityRes.error}
          summaryError={summaryRes.error}
          scoreboard={scoreboardRes}
          volume={{
            // Joined here, on the server, so the client renders a decided list
            // rather than re-deriving the match and risking a different answer
            // from the one the cap editor writes against.
            rows: joinVolumeToSequences(result.rows, volumeRes.volumes),
            days: volumeRes.days,
            timeZone: volumeRes.timeZone,
            error: volumeRes.error,
            truncated: volumeRes.truncated,
            sms: {
              rows: joinVolumeToSequences(result.rows, smsVolumeRes.volumes),
              error: smsVolumeRes.error,
              truncated: smsVolumeRes.truncated,
            },
            limits,
          }}
          pool={pool}
        />
      )}
    </div>
  );
}
