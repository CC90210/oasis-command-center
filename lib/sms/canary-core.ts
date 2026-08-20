/**
 * lib/sms/canary-core.ts — when is a phone line PROVEN to deliver?
 *
 * WHY THE BAR IS TWO PASSES AND NOT ONE. On 2026-08-18 the AI Follow-Up wire
 * delivered 8 of 8 and we treated it as commissioned. Roughly 22 hours later
 * every send from those same two numbers was refused by the carrier, and it
 * stayed that way. A single good burst is exactly what a number does on its
 * first day before the carriers make up their mind about it.
 *
 * So a line is cleared only by deliveries SEPARATED IN TIME. One send proves
 * the request was accepted; two, far enough apart, is the cheapest evidence
 * that the carrier has not since changed its mind.
 *
 * Everything here is pure. The runner does the I/O and hands attempts in.
 */

/** One canary send and whatever the carrier eventually said about it. */
export type CanaryAttempt = {
  number: string;
  /** ISO. When we handed it to the provider. */
  sentAt: string;
  /** delivered | failed | pending | unknown | null while unresolved. */
  carrierStatus: string | null;
  /** ISO, set once the verdict is TERMINAL. Null means still waiting. */
  resolvedAt: string | null;
};

export type LineVerdict =
  /** Two spaced deliveries, no failure since. Safe to send on. */
  | "cleared"
  /** The carrier refused at least one. Bench it. */
  | "failed"
  /** Sent, no terminal answer yet. NOT a pass. */
  | "pending"
  /** Not enough evidence either way. NOT a pass. */
  | "insufficient";

export type LineResult = {
  number: string;
  verdict: LineVerdict;
  reason: string;
  delivered: number;
  failed: number;
  unresolved: number;
  /** Milliseconds between the first and last qualifying delivery. */
  spreadMs: number;
};

/** A line must deliver twice at least this far apart. Half an hour is long
 *  enough to cross the window in which the 08-18 burst still looked healthy,
 *  and short enough to clear a line inside one working session. */
export const MIN_SPREAD_MS = 30 * 60_000;

const TERMINAL_OK = new Set(["delivered"]);
const TERMINAL_BAD = new Set(["failed", "undelivered"]);

/**
 * Three outcomes, and the third is not the same as "still waiting".
 *
 *   waiting      — no verdict yet. Waiting longer may produce one.
 *   inconclusive — resolved WITHOUT a verdict (retired as 'unknown' after the
 *                  reconciler ran out of attempts). Waiting will never help;
 *                  the line has to be re-tested.
 *
 * Collapsing them would tell an operator to keep waiting on evidence that is
 * never coming, which is how the 15 stuck receipts looked for four days.
 */
function terminal(a: CanaryAttempt): "ok" | "bad" | "waiting" | "inconclusive" {
  if (!a.resolvedAt) return "waiting";
  const s = String(a.carrierStatus ?? "").toLowerCase();
  if (TERMINAL_OK.has(s)) return "ok";
  if (TERMINAL_BAD.has(s)) return "bad";
  return "inconclusive";
}

/**
 * Decide whether one line may be sent on.
 *
 * FAILURE DOMINATES. A line with any refused canary is benched even if other
 * canaries delivered, because a partly-blocked number is how this started: the
 * carrier accepted a burst and then began refusing, and during the overlap the
 * line looked mixed rather than dead.
 */
export function lineVerdict(
  attempts: CanaryAttempt[],
  opts: { minSpreadMs?: number } = {},
): LineResult {
  const minSpread = opts.minSpreadMs ?? MIN_SPREAD_MS;
  const number = attempts[0]?.number ?? "";
  let delivered = 0;
  let failed = 0;
  let waiting = 0;
  let inconclusive = 0;
  const okTimes: number[] = [];

  for (const a of attempts) {
    const t = terminal(a);
    if (t === "ok") {
      delivered++;
      const ms = Date.parse(a.sentAt);
      if (Number.isFinite(ms)) okTimes.push(ms);
    } else if (t === "bad") {
      failed++;
    } else if (t === "waiting") {
      waiting++;
    } else {
      inconclusive++;
    }
  }

  // `unresolved` stays in the shape as the total "no answer" count, so callers
  // that only care whether evidence is missing do not have to add two fields.
  const base = { number, delivered, failed, unresolved: waiting + inconclusive };

  if (attempts.length === 0) {
    return { ...base, verdict: "insufficient", reason: "never tested", spreadMs: 0 };
  }
  if (failed > 0) {
    return {
      ...base,
      verdict: "failed",
      reason: `${failed} canary send(s) refused by the carrier`,
      spreadMs: 0,
    };
  }

  okTimes.sort((a, b) => a - b);
  const spreadMs = okTimes.length >= 2 ? okTimes[okTimes.length - 1] - okTimes[0] : 0;

  if (delivered >= 2 && spreadMs >= minSpread) {
    return { ...base, verdict: "cleared", reason: `${delivered} delivered, ${Math.round(spreadMs / 60_000)} min apart`, spreadMs };
  }
  // Only a send that may STILL answer is 'pending'. One retired as 'unknown'
  // never will, so it falls through to 'insufficient' and prompts a re-test
  // rather than telling the operator to keep waiting.
  if (waiting > 0) {
    return { ...base, verdict: "pending", reason: `${waiting} canary send(s) awaiting a carrier verdict`, spreadMs };
  }
  if (inconclusive > 0) {
    return {
      ...base,
      verdict: "insufficient",
      reason: `${inconclusive} canary send(s) never got a verdict and were retired; re-test this line`,
      spreadMs,
    };
  }
  if (delivered >= 2) {
    return {
      ...base,
      verdict: "insufficient",
      reason: `${delivered} delivered but only ${Math.round(spreadMs / 60_000)} min apart; need ${Math.round(minSpread / 60_000)}`,
      spreadMs,
    };
  }
  return {
    ...base,
    verdict: "insufficient",
    reason: `${delivered} delivered; need 2 spaced at least ${Math.round(minSpread / 60_000)} min apart`,
    spreadMs,
  };
}

/**
 * Which lines may the drip engine send from?
 *
 * FAIL CLOSED: anything not explicitly `cleared` is excluded. "We have not
 * finished testing it" and "it is broken" both mean do not send, and collapsing
 * them into a permissive default is how an untested line gets production
 * traffic.
 */
export function clearedLines(results: LineResult[]): string[] {
  return results.filter((r) => r.verdict === "cleared").map((r) => r.number);
}

/**
 * Is it safe to resume sending at all?
 *
 * Requires at least one cleared line. Resuming with zero cleared lines would
 * put every queued text back onto whatever the pool happens to contain, which
 * is precisely the state we just halted.
 */
export function resumeAllowed(results: LineResult[]): { ok: boolean; reason: string } {
  const cleared = clearedLines(results);
  if (cleared.length === 0) {
    const pending = results.filter((r) => r.verdict === "pending").length;
    return {
      ok: false,
      reason: pending > 0
        ? `no line has cleared yet; ${pending} still awaiting a carrier verdict`
        : "no line has cleared; every tested line was refused or is untested",
    };
  }
  return { ok: true, reason: `${cleared.length} cleared line(s): ${cleared.join(", ")}` };
}
