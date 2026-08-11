/**
 * lib/drips/sequence-volume.ts — the reads behind per-sequence daily volume.
 *
 * The rules are pure and live in sequence-volume-core.ts. This is the I/O half.
 *
 * READS lead_interactions, NOT drip_runs, and the choice is load-bearing —
 * see the header of sequence-volume-core.ts. In one line: this is the meter for
 * a cap that governor.ts enforces against lead_interactions, and drip_runs
 * cannot see the ~1-in-4 drip emails written by the other sender.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { OPERATOR_TIME_ZONE } from "@/lib/dates";
import {
  bucketBySequenceDay,
  sequenceNameFromSource,
  type SequenceVolume,
  type VolumeInteraction,
} from "./sequence-volume-core";

type Db = ReturnType<typeof getServiceSupabase>;

export type SequenceVolumeReport = {
  volumes: SequenceVolume[];
  timeZone: string;
  days: number;
  /** The read failed. Callers must render this as UNKNOWN, never as zero
   *  volume — an empty chart is the most reassuring possible picture and the
   *  least trustworthy one. */
  error: string | null;
  /** The window hit the page ceiling, so counts are a floor rather than a
   *  total. Reported, never absorbed. */
  truncated: boolean;
};

/** Hard ceiling on rows pulled for the chart. A rolling fortnight of drip mail
 *  is a few thousand rows at the volumes this estate runs; the pages exist so a
 *  backlog cannot silently truncate the count and UNDER-report volume, which
 *  for a cap's own meter is the dangerous direction. */
const PAGE = 1000;
const MAX_PAGES = 12;

/**
 * Per-sequence daily email counts over the last `days` calendar days.
 *
 * Tenant-scoped: the service role bypasses RLS, so the filter is the only thing
 * keeping one tenant's volume off another's chart.
 */
export async function sequenceDailyVolume(
  tenantId: string,
  opts: { days?: number; nowMs?: number } = {},
): Promise<SequenceVolumeReport> {
  const days = Math.max(1, Math.min(60, opts.days ?? 14));
  const nowMs = opts.nowMs ?? Date.now();
  const timeZone = OPERATOR_TIME_ZONE;
  const base: SequenceVolumeReport = { volumes: [], timeZone, days, error: null, truncated: false };

  const db: Db = getServiceSupabase();
  // One extra day of slack on the query bound. The window is CALENDAR days in
  // the operator's zone and this filter is UTC, so a tight bound would clip the
  // oldest day for anyone west of UTC. Rows outside the window are dropped by
  // the bucketer anyway.
  const sinceIso = new Date(nowMs - (days + 1) * 86_400_000).toISOString();

  const rows: VolumeInteraction[] = [];
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await db
      .from("lead_interactions")
      .select("agent_source, created_at, metadata")
      .eq("tenant_id", tenantId)
      .eq("type", "email_sent")
      .eq("direction", "outbound")
      .like("agent_source", "sequence:%")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);

    // Fail LOUD. An empty chart from a broken read looks exactly like a quiet
    // fortnight, and this chart is the evidence an operator uses to decide
    // whether a cap is set correctly.
    if (r.error) return { ...base, error: `volume read failed: ${r.error.message}` };

    const page_rows = (r.data || []) as Array<{
      agent_source: string | null;
      created_at: string | null;
      metadata: Record<string, unknown> | null;
    }>;

    for (const row of page_rows) {
      const md = row.metadata || {};
      rows.push({
        sequenceId: typeof md.sequence_id === "string" && md.sequence_id ? md.sequence_id : null,
        sequenceName: sequenceNameFromSource(row.agent_source),
        at: row.created_at || "",
        // Matching governor.ts: only an EXPLICIT dry run is excluded, so a row
        // from a writer we do not control counts against the cap instead of
        // vanishing from it.
        dryRun: String(md.dry_run) === "true",
      });
    }

    if (page_rows.length < PAGE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  return {
    ...base,
    volumes: bucketBySequenceDay(rows, { days, timeZone, nowMs }),
    truncated,
  };
}

/**
 * Today's per-sequence email count, keyed by sequence id, for the SEND PATH.
 *
 * Deliberately the same code path as the chart (one day of the same bucketing),
 * so the number the engine gates on and the number the operator sees cannot
 * drift apart. Two implementations of "how many did this sequence send today"
 * would eventually disagree, and the operator would be right to trust neither.
 *
 * Returns null on a read error so the caller decides how to degrade — this
 * module never converts a failed read into a comfortable zero.
 */
export async function sequenceSentToday(tenantId: string, nowMs?: number): Promise<Map<string, number> | null> {
  const report = await sequenceDailyVolume(tenantId, { days: 1, nowMs });
  if (report.error) return null;
  const out = new Map<string, number>();
  for (const v of report.volumes) {
    if (v.sequenceId) out.set(v.sequenceId, v.today);
    // Name-keyed entries are also recorded, so a sequence whose sends predate
    // id stamping still counts toward its own cap.
    if (v.sequenceName) {
      out.set(`name:${v.sequenceName}`, (out.get(`name:${v.sequenceName}`) || 0) + v.today);
    }
  }
  return out;
}

/** The configured cap per sequence id. Absent means uncapped. */
export async function sequenceDailyCaps(tenantId: string): Promise<Map<string, number> | null> {
  const db: Db = getServiceSupabase();
  const r = await db
    .from("drip_sequences")
    .select("id, name, daily_email_cap")
    .eq("tenant_id", tenantId)
    .not("daily_email_cap", "is", null)
    .limit(500);
  if (r.error) return null;
  const out = new Map<string, number>();
  for (const row of (r.data || []) as Array<{ id: string; name: string | null; daily_email_cap: number | null }>) {
    if (typeof row.daily_email_cap !== "number") continue;
    out.set(String(row.id), row.daily_email_cap);
    // Mirrored under the name key so the cap still applies to sends attributed
    // by name alone. Without this, a capped sequence whose rows lack an id
    // would be counted but never limited.
    if (row.name) out.set(`name:${row.name}`, row.daily_email_cap);
  }
  return out;
}
