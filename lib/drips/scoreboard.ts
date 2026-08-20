/**
 * lib/drips/scoreboard.ts — the I/O behind the per-sequence rollup.
 *
 * Rules live in scoreboard-core.ts and are pure. This file only fetches.
 *
 * WHY IT PAGINATES INSTEAD OF TAKING A LIMIT. The activity table caps each half
 * of its read at 300 rows, which is right for a table (nobody scrolls 600 rows)
 * and wrong for a COUNT. Measured 2026-08-20, both halves were over the cap:
 * 643 open and 498 done. A rollup built on that sample would have quietly
 * reported a fraction of every number while looking authoritative — the exact
 * "partial count rendered as fact" failure the activity summary already carries
 * a truncation banner for.
 *
 * So this walks the whole window, and if it ever hits the hard ceiling it says
 * so rather than returning a floor dressed as a total.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { scoreSequences, type ScoredRun, type ScoreboardResult } from "./scoreboard-core";
export type { ScoreboardResult } from "./scoreboard-core";

type Db = ReturnType<typeof getServiceSupabase>;

const PAGE = 500;
/** Absolute ceiling across the window. Well above a normal week (~1,100 rows on
 *  2026-08-20) and low enough that a runaway cannot stall the page. */
const MAX_ROWS = 6000;

async function fetchAll<T>(
  run: (from: number, to: number) => Promise<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ rows: T[]; truncated: boolean; error: string | null }> {
  const rows: T[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const res = await run(from, from + PAGE - 1);
    if (res.error) return { rows, truncated: false, error: res.error.message };
    const page = res.data || [];
    rows.push(...page);
    if (page.length < PAGE) return { rows, truncated: false, error: null };
  }
  return { rows, truncated: true, error: null };
}

/**
 * Per-sequence outcomes over the last `days`.
 *
 * The carrier verdict is joined in from sms_delivery_receipts by drip_run_id.
 * That join is the entire point: without it "sent" is the only number available
 * and "sent" is what said 11 on the day 3 of those 11 had been refused.
 */
export async function sequenceScoreboard(
  tenantId: string,
  opts: { days?: number; nowMs?: number } = {},
): Promise<ScoreboardResult> {
  const db: Db = getServiceSupabase();
  const days = opts.days ?? 7;
  const since = new Date((opts.nowMs ?? Date.now()) - days * 24 * 3_600_000).toISOString();

  // Two halves, same reasoning as recentDripActivity: a row that has not sent
  // is placed by when it was DUE, a row that has by when it SENT. One ORDER BY
  // cannot serve both, and here we need every row of each.
  const COLS = "id, sequence_name, channel, status, from_identity, last_error, sent_at, scheduled_for";
  const openRes = await fetchAll<ScoredRun>((from, to) =>
    db.from("drip_runs").select(COLS).eq("tenant_id", tenantId)
      .is("sent_at", null).gte("scheduled_for", since)
      .order("scheduled_for", { ascending: false }).range(from, to) as never,
  );
  const doneRes = await fetchAll<ScoredRun>((from, to) =>
    db.from("drip_runs").select(COLS).eq("tenant_id", tenantId)
      .not("sent_at", "is", null).gte("sent_at", since)
      .order("sent_at", { ascending: false }).range(from, to) as never,
  );
  // Either half failing is a failure. Half a picture presented as the whole one
  // is the silent-truncation shape this module refuses.
  const readError = openRes.error || doneRes.error;
  if (readError) return { scores: [], days, truncated: false, error: readError };

  const runs = [...openRes.rows, ...doneRes.rows];

  // Carrier verdicts, keyed by drip_run_id. Only SMS rows have one.
  const receiptsRes = await fetchAll<{ drip_run_id: string | null; carrier_status: string | null; resolved_at: string | null }>(
    (from, to) =>
      db.from("sms_delivery_receipts").select("drip_run_id, carrier_status, resolved_at")
        .eq("tenant_id", tenantId).gte("sent_at", since)
        .order("sent_at", { ascending: false }).range(from, to) as never,
  );
  // A receipt read failure must NOT degrade to "no receipts": that is
  // indistinguishable from the blind spot this screen exists to show, and it
  // would paint every SMS sequence 'unconfirmed' as though the wire were broken.
  if (receiptsRes.error) {
    return { scores: [], days, truncated: false, error: `carrier receipts unreadable: ${receiptsRes.error}` };
  }
  const byRun = new Map<string, { carrier_status: string | null; resolved_at: string | null }>();
  for (const r of receiptsRes.rows) {
    if (r.drip_run_id) byRun.set(String(r.drip_run_id), r);
  }

  const enriched: ScoredRun[] = runs.map((r) => {
    const rec = r.id ? byRun.get(String(r.id)) : undefined;
    return rec
      ? { ...r, carrier_status: rec.carrier_status, receipt_resolved_at: rec.resolved_at }
      : r;
  });

  // `enabled` from the sequence definitions, so a card can say "off" rather
  // than leaving an operator to infer it from a zero.
  const enabledByName = new Map<string, boolean>();
  const seqRes = await db.from("drip_sequences").select("name, enabled").eq("tenant_id", tenantId);
  if (!seqRes.error) {
    for (const s of (seqRes.data || []) as Array<{ name: string; enabled: unknown }>) {
      // libSQL returns booleans as 0/1, so a strict === true check silently
      // marks every live sequence as off.
      enabledByName.set(String(s.name), s.enabled === true || s.enabled === 1);
    }
  }

  return {
    scores: scoreSequences(enriched, enabledByName),
    days,
    truncated: openRes.truncated || doneRes.truncated || receiptsRes.truncated,
    error: null,
  };
}
