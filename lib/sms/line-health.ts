/**
 * lib/sms/line-health.ts — the I/O behind benching a bad sending number.
 *
 * Rules are pure and live in line-health-core.ts.
 *
 * There is deliberately NO new table here. The evidence is the carrier receipts
 * we already keep, so the benched set is derived on every call rather than
 * stored. A stored flag would need its own recovery path and its own way of
 * going stale; a derived one recovers the moment the line delivers again, which
 * is exactly the behaviour we want and one fewer thing to keep in sync.
 */

import "server-only";
import { readRecentReceiptsByLine } from "./delivery-receipts";
import { sendableLines, wireDecision, type LineDecision } from "./line-health-core";
import { sendTelegram } from "@/lib/notify/telegram";
import { shouldAlert } from "@/lib/notify/alert-decay";
import { getServiceSupabase } from "@/lib/supabase-server";

export type PoolVerdict = {
  /** Lines that may be sent from, in the order given. */
  lines: string[];
  blocked: LineDecision[];
  /** True when the whole wire is halted, not just some lines. */
  wireHalted: boolean;
  reason: string;
};

/**
 * Filter a wire's sending pool down to the lines that are actually working.
 *
 * FAILS CLOSED. An unreadable receipt history yields an empty pool, because
 * "send from every number we own since we cannot check them" is the outage this
 * exists to prevent.
 */
export async function sendablePool(
  tenantId: string,
  pool: string[],
  opts: { wire?: string; nowMs?: number } = {},
): Promise<PoolVerdict> {
  if (pool.length === 0) return { lines: [], blocked: [], wireHalted: false, reason: "wire has no lines" };
  const nowMs = opts.nowMs ?? Date.now();
  const samples = await readRecentReceiptsByLine(tenantId, {
    sinceMs: nowMs - 24 * 3_600_000,
    onlyLines: pool,
  });

  const wire = samples === null ? null : wireDecision(samples);
  const { lines, blocked, reason } = sendableLines(pool, samples);

  if (wire?.halt) {
    // A halted wire overrides the per-line result: five consecutive failures
    // across the route means the route is dead, and picking whichever line has
    // not personally reached three yet just burns it next.
    return { lines: [], blocked, wireHalted: true, reason: wire.reason };
  }
  return { lines, blocked, wireHalted: false, reason };
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Tell Adon a line was benched, once, on the standing decay ladder.
 *
 * KEYED ON THE CONDITION, not the message: the alert key is the line plus the
 * wire, so a number that keeps failing re-alerts on the ladder rather than
 * every dispatch tick. There is exactly one ladder in this codebase and this
 * does not add a second.
 */
export async function announceBenchedLines(
  tenantId: string,
  verdict: PoolVerdict,
  opts: { wire?: string; nowMs?: number } = {},
): Promise<{ alerted: string[] }> {
  const nowMs = opts.nowMs ?? Date.now();
  const db = getServiceSupabase();
  const alerted: string[] = [];
  const wire = opts.wire || "sms";

  const conditions: Array<{ key: string; body: string }> = [];
  if (verdict.wireHalted) {
    conditions.push({
      key: `sms-wire-halt:${wire}`,
      body: `🔴 <b>TEXTING HALTED</b> — wire <b>${esc(wire)}</b>\n${esc(verdict.reason)}\nNo texts will send on this wire until a line delivers again.`,
    });
  }
  for (const b of verdict.blocked) {
    conditions.push({
      key: `sms-line-benched:${wire}:${b.number}`,
      body: `🟠 <b>NUMBER BENCHED</b> — ${esc(b.number)} (${esc(wire)})\n${esc(b.reason)}\nIt will come back on its own if it starts delivering again.`,
    });
  }

  for (const c of conditions) {
    const state = await db.from("health_alert_state").select("*").eq("alert_key", c.key).maybeSingle();
    const row = state.data as { last_signature: string | null; last_alerted_at: string | null; repeat_n: number | null } | null;
    const decision = shouldAlert(
      c.key,
      { lastSignature: row?.last_signature, lastAlertedAt: row?.last_alerted_at, repeatN: row?.repeat_n },
      new Date(nowMs),
    );
    if (!decision.send) continue;
    await sendTelegram(c.body, { lane: "sunbiz-ops" }).catch(() => undefined);
    alerted.push(c.key);
    // Recorded regardless of delivery: if Telegram is down we must not spin
    // re-sending on every dispatch tick. The delivery self-test is the separate
    // mechanism that catches a dead channel.
    await db.from("health_alert_state").upsert(
      {
        alert_key: c.key,
        tenant_id: tenantId,
        last_signature: c.key,
        last_alerted_at: new Date(nowMs).toISOString(),
        repeat_n: decision.nextRepeatN,
        first_failed_at: row?.last_alerted_at ?? new Date(nowMs).toISOString(),
        updated_at: new Date(nowMs).toISOString(),
      },
      { onConflict: "alert_key" },
    ).then(() => undefined, () => undefined);
  }
  return { alerted };
}
