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
import { newestVerdict, sendableLines, wireDecision, type LineDecision } from "./line-health-core";
import { canaryStatus } from "./canary";
import { resolveAgentAlerts, writeAgentAlert } from "@/lib/notify/agent-alert";
import { shouldAlert } from "@/lib/notify/alert-decay";
import { getServiceSupabase } from "@/lib/supabase-server";
import { isRetiredTenant } from "@/lib/tenant/retired";

export type PoolVerdict = {
  /** Lines that may be sent from, in the order given. */
  lines: string[];
  blocked: LineDecision[];
  /** True when the whole wire is halted, not just some lines. */
  wireHalted: boolean;
  reason: string;
  /** Every line the wire was judged on (the pool given). */
  pool?: string[];
  /** Lines whose newest carrier verdict is a delivery: the evidence a benched line is back. */
  delivering?: string[];
  /** The newest carrier verdict across the whole wire is a delivery. */
  wireDelivering?: boolean;
};

/** The workspace's card for one benched number (subject: `<wire>:<number>`). */
export const LINE_BENCHED_ALERT = "sms_line_benched";
/** The workspace's card for a halted wire (subject: the wire). */
export const WIRE_HALTED_ALERT = "sms_wire_halted";

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

  // THE CANARY ALLOW-LIST IS ENFORCED HERE, NOT AT RESUME (Codex P1,
  // 2026-08-20).
  //
  // resumePlan() computes which lines cleared, but a resume script that merely
  // raises the caps does not stop the executor picking a line the canary just
  // refused — it would take three PRODUCTION failures per bad line to bench it,
  // which on the six dead numbers is eighteen texts aimed at real merchants.
  //
  // Enforcing it here instead means the allow-list applies on every dispatch
  // forever, not once at the moment someone runs a script, and there is no
  // second copy of the truth to go stale.
  //
  // ONE canary failure is enough, where production needs three: a canary is
  // sent to a handset we control, so a refusal is unambiguously about the LINE.
  // A production failure could just as easily be a landline on the far end.
  const canary = await canaryStatus(tenantId, { lines: pool });
  if (canary.error) {
    // Fail closed: we cannot tell which lines were cleared.
    return { lines: [], blocked, wireHalted: false, reason: `canary history unreadable: ${canary.error}` };
  }
  const canaryFailed = new Set(canary.results.filter((r) => r.verdict === "failed").map((r) => r.number));
  const allowed = lines.filter((n) => !canaryFailed.has(n));
  for (const n of canaryFailed) {
    if (blocked.some((b) => b.number === n)) continue;
    blocked.push({ number: n, bench: true, consecutiveFailures: 0, sample: 0, reason: "refused a canary test send" });
  }

  const evidence =
    samples === null
      ? {}
      : {
          pool,
          delivering: pool.filter((n) => newestVerdict(samples.filter((s) => s.number === n)) === "delivered"),
          wireDelivering: newestVerdict(samples) === "delivered",
        };
  if (wire?.halt) {
    // A halted wire overrides the per-line result: five consecutive failures
    // across the route means the route is dead, and picking whichever line has
    // not personally reached three yet just burns it next.
    return { lines: [], blocked, wireHalted: true, reason: wire.reason, ...evidence };
  }
  return {
    lines: allowed,
    blocked,
    wireHalted: false,
    reason: canaryFailed.size > 0 ? `${reason}; ${canaryFailed.size} refused a canary` : reason,
    ...evidence,
  };
}

/**
 * Tell the workspace a line was benched, once, on the standing decay ladder.
 *
 * EVERY PAGE IS ALSO A CARD (writeAgentAlert), keyed by a stable subject (the
 * wire, or `<wire>:<number>`), in the workspace's own Needs you list. Until
 * 2026-10-08 this only pushed to Telegram and recorded the ladder whether or
 * not the push landed, so a workspace with no Telegram bot was never told and
 * the ladder kept it quiet. The card's push goes to that workspace's own
 * audience (lib/notify/alert-route.ts), and the card stays open until the line
 * demonstrably delivers again (closeRecoveredLineCards).
 *
 * KEYED ON THE CONDITION, not the message: the alert key is the line plus the
 * wire, so a number that keeps failing re-alerts on the ladder rather than
 * every dispatch tick. There is exactly one ladder in this codebase and this
 * does not add a second. The ladder, not once-per-open, decides each page:
 * a number benched for days re-pages at 6, 12 and 24 hours, as it always did.
 */
export async function announceBenchedLines(
  tenantId: string,
  verdict: PoolVerdict,
  opts: { wire?: string; nowMs?: number } = {},
): Promise<{ alerted: string[] }> {
  // A retired tenant sends nothing, so its lines have nothing to announce, and
  // its health_alert_state rows are being exported and deleted.
  if (isRetiredTenant(tenantId)) return { alerted: [] };
  const nowMs = opts.nowMs ?? Date.now();
  const db = getServiceSupabase();
  const alerted: string[] = [];
  const wire = opts.wire || "sms";
  // The lines the card's recovery check judges again: the whole pool.
  const lines = [...new Set([...(verdict.pool ?? verdict.lines), ...verdict.blocked.map((b) => b.number)])];

  const conditions: Array<{ key: string; alert: Parameters<typeof writeAgentAlert>[0] }> = [];
  if (verdict.wireHalted) {
    conditions.push({
      key: `sms-wire-halt:${wire}`,
      alert: {
        tenantId,
        alertType: WIRE_HALTED_ALERT,
        severity: "urgent",
        subjectType: "sms_wire",
        subjectId: wire,
        title: "Texting is paused",
        body: `No texts will send until one of your numbers delivers again (${verdict.reason}).`,
        payload: { wire, lines },
      },
    });
  }
  for (const b of verdict.blocked) {
    conditions.push({
      key: `sms-line-benched:${wire}:${b.number}`,
      alert: {
        tenantId,
        alertType: LINE_BENCHED_ALERT,
        severity: "warn",
        subjectType: "sms_line",
        subjectId: `${wire}:${b.number}`,
        title: "A texting number was paused",
        body: `${b.number} is paused (${b.reason}). It comes back on its own once it delivers again.`,
        payload: { wire, number: b.number, lines },
      },
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
    await writeAgentAlert(c.alert);
    alerted.push(c.key);
    // Recorded regardless of delivery: if Telegram is down we must not spin
    // re-sending on every dispatch tick. The card above is the record that
    // does not depend on delivery: it sits in the workspace's Needs you list
    // until the line recovers, and says whether its Telegram heard.
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

type OpenLineCard = { alertType: string; subjectId: string; wire: string; number: string | null; lines: string[] };

function openLineCard(row: { alert_type?: unknown; subject_id?: unknown; payload?: unknown }): OpenLineCard | null {
  let payload: Record<string, unknown> = {};
  if (row.payload && typeof row.payload === "object") payload = row.payload as Record<string, unknown>;
  else if (typeof row.payload === "string") {
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const wire = typeof payload.wire === "string" ? payload.wire : null;
  const lines = Array.isArray(payload.lines) ? payload.lines.filter((n): n is string => typeof n === "string") : [];
  const number = typeof payload.number === "string" ? payload.number : null;
  if (!wire || lines.length === 0 || typeof row.subject_id !== "string") return null;
  if (row.alert_type === LINE_BENCHED_ALERT && !number) return null;
  return { alertType: String(row.alert_type), subjectId: row.subject_id, wire, number, lines };
}

/**
 * Close a workspace's benched-line and halted-wire cards whose condition has
 * DEMONSTRABLY cleared, and restart their ladder so the next occurrence pages
 * at once instead of inheriting a 24-hour silence.
 *
 * The evidence is the bench decision itself, re-run on the lines the card
 * recorded (sendablePool, canary refusals included), plus a delivery as the
 * newest verdict. "Not benched" alone is not enough: a line's failures age out
 * of the 24-hour window and it reads "not benched" with nothing showing it
 * delivers, and an empty or pending-only history proves nothing either. A card
 * closed on those reopens and pages as if new the next time the line fails.
 *
 * Runs from the reconcile cron after the receipts close, once per workspace;
 * one read when nothing is open. Never throws.
 */
export async function closeRecoveredLineCards(
  tenantId: string,
  opts: { nowMs?: number } = {},
): Promise<string[]> {
  if (isRetiredTenant(tenantId)) return [];
  const closed: string[] = [];
  try {
    const db = getServiceSupabase();
    const open = await db
      .from("agent_alerts")
      .select("alert_type, subject_id, payload")
      .eq("tenant_id", tenantId)
      .in("alert_type", [LINE_BENCHED_ALERT, WIRE_HALTED_ALERT])
      .is("resolved_at", null)
      .limit(50);
    if (open.error) {
      console.error("[line-health] open line cards unreadable:", open.error.message);
      return [];
    }
    const cards = ((open.data || []) as Array<Record<string, unknown>>)
      .map(openLineCard)
      .filter((c): c is OpenLineCard => c !== null);
    const byWire = new Map<string, OpenLineCard[]>();
    for (const card of cards) byWire.set(card.wire, [...(byWire.get(card.wire) ?? []), card]);

    for (const [wire, wireCards] of byWire) {
      const pool = [...new Set(wireCards.flatMap((c) => c.lines))];
      const verdict = await sendablePool(tenantId, pool, { wire, nowMs: opts.nowMs });
      for (const card of wireCards) {
        const back =
          card.alertType === WIRE_HALTED_ALERT
            ? !verdict.wireHalted && verdict.wireDelivering === true
            : verdict.lines.includes(card.number as string) && (verdict.delivering ?? []).includes(card.number as string);
        if (!back) continue;
        const n = await resolveAgentAlerts({
          tenantId,
          alertType: card.alertType,
          subjectId: card.subjectId,
          resolvedBy:
            card.alertType === WIRE_HALTED_ALERT
              ? "auto: texts deliver again"
              : "auto: a text from this number delivered again",
        });
        if (n === 0) continue;
        closed.push(card.subjectId);
        // The ladder keys announceBenchedLines pages on: `sms-wire-halt:<wire>`
        // and `sms-line-benched:<wire>:<number>` (the card's subject).
        const key = card.alertType === WIRE_HALTED_ALERT ? `sms-wire-halt:${wire}` : `sms-line-benched:${card.subjectId}`;
        await db
          .from("health_alert_state")
          .update({ last_signature: "recovered", updated_at: new Date(opts.nowMs ?? Date.now()).toISOString() })
          .eq("tenant_id", tenantId)
          .eq("alert_key", key)
          .then(() => undefined, () => undefined);
      }
    }
  } catch (err) {
    console.error("[line-health] closing recovered line cards failed:", err instanceof Error ? err.message : err);
  }
  return closed;
}
