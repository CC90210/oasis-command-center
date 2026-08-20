/**
 * lib/sms/line-health-core.ts — bench a sending number before it burns a cohort.
 *
 * Adon, 2026-08-20, choosing the thresholds: "3 failures in a row on a phone
 * number stops that number. 5 across the whole account stops all texting. You
 * get a Telegram message naming the number and the count."
 *
 * WHY THIS IS SEPARATE FROM THE EXISTING BREAKER. send-breaker.ts halts a WIRE
 * at 10 consecutive failures. That is the right shape for "the route is dead"
 * and the wrong shape for what actually happened: on 2026-08-20 a canary from
 * all twelve of our numbers to one handset came back six delivered, six failed.
 * Half the pool was dead and the wire-level breaker could never see it, because
 * the healthy half kept the consecutive count from ever reaching 10.
 *
 * A per-line rule catches that. A per-wire rule catches a whole route dying.
 * Neither substitutes for the other, which is why both exist.
 *
 * IMPORTANT: this measures OUR LINES, not merchant handsets. A destination that
 * cannot receive texts is destination-health-core.ts and a different question —
 * conflating them would bench a perfectly good number for the crime of having
 * texted a room full of landlines.
 */

import type { CarrierStatus } from "./carrier-status";

/** One carrier verdict for one of our sending numbers. */
export type LineSample = {
  number: string;
  status: CarrierStatus;
  /** Epoch ms. */
  at: number;
};

/** Consecutive carrier failures on one line before it is benched. */
export const LINE_BENCH_CONSECUTIVE = 3;
/** Consecutive carrier failures across a whole wire before every line halts. */
export const WIRE_HALT_CONSECUTIVE = 5;

export type LineDecision = {
  number: string;
  bench: boolean;
  consecutiveFailures: number;
  sample: number;
  reason: string;
};

function newestFirst(samples: LineSample[]): LineSample[] {
  return samples.filter((s) => s.status === "delivered" || s.status === "failed").sort((a, b) => b.at - a.at);
}

/**
 * Should this line be benched?
 *
 * Counts CONSECUTIVE failures from the newest verdict backwards. A single
 * delivery anywhere in that run resets it, because the line demonstrably still
 * works and the failures were about the handsets it was aimed at.
 *
 * 'pending' and 'unknown' are skipped entirely rather than breaking the run.
 * They are an absence of evidence: treating an unresolved receipt as a success
 * would have hidden this outage (all 15 AI-wire receipts sat unresolved for
 * four days), and treating it as a failure would bench a healthy line the
 * moment reconciliation lagged.
 */
export function lineDecision(
  number: string,
  samples: LineSample[],
  opts: { consecutive?: number } = {},
): LineDecision {
  const limit = opts.consecutive ?? LINE_BENCH_CONSECUTIVE;
  const terminal = newestFirst(samples);
  let streak = 0;
  for (const s of terminal) {
    if (s.status === "failed") streak++;
    else break;
  }
  if (streak >= limit) {
    return {
      number,
      bench: true,
      consecutiveFailures: streak,
      sample: terminal.length,
      reason: `${streak} consecutive carrier failures`,
    };
  }
  return {
    number,
    bench: false,
    consecutiveFailures: streak,
    sample: terminal.length,
    reason: terminal.length === 0 ? "no terminal receipts yet" : `${streak} consecutive failure(s), limit ${limit}`,
  };
}

export type WireDecision = {
  halt: boolean;
  consecutiveFailures: number;
  benched: string[];
  reason: string;
};

/**
 * Should the entire wire stop?
 *
 * Measured across ALL of the wire's lines together, newest first, so a route
 * that is dead everywhere trips even when no single line has reached its own
 * limit — five failures spread over three numbers is still a dead route.
 */
export function wireDecision(
  samples: LineSample[],
  opts: { consecutive?: number; lineConsecutive?: number } = {},
): WireDecision {
  const limit = opts.consecutive ?? WIRE_HALT_CONSECUTIVE;
  const terminal = newestFirst(samples);
  let streak = 0;
  for (const s of terminal) {
    if (s.status === "failed") streak++;
    else break;
  }

  const byLine = new Map<string, LineSample[]>();
  for (const s of samples) {
    const list = byLine.get(s.number) ?? [];
    list.push(s);
    byLine.set(s.number, list);
  }
  const benched = [...byLine.entries()]
    .map(([n, ss]) => lineDecision(n, ss, { consecutive: opts.lineConsecutive }))
    .filter((d) => d.bench)
    .map((d) => d.number);

  if (streak >= limit) {
    return { halt: true, consecutiveFailures: streak, benched, reason: `${streak} consecutive carrier failures across the wire` };
  }
  return {
    halt: false,
    consecutiveFailures: streak,
    benched,
    reason: terminal.length === 0 ? "no terminal receipts yet" : `${streak} consecutive failure(s), limit ${limit}`,
  };
}

/**
 * Which lines may the engine send from?
 *
 * FAIL CLOSED on an unreadable history: `samples === null` yields an empty
 * pool, not the full one. Sending from every line we own because we could not
 * read their health is the exact shape of the outage this prevents.
 */
export function sendableLines(
  pool: string[],
  samples: LineSample[] | null,
  opts: { consecutive?: number } = {},
): { lines: string[]; blocked: LineDecision[]; reason: string } {
  if (samples === null) {
    return { lines: [], blocked: [], reason: "line health unreadable - refusing to send rather than sending blind" };
  }
  const byLine = new Map<string, LineSample[]>();
  for (const s of samples) {
    const list = byLine.get(s.number) ?? [];
    list.push(s);
    byLine.set(s.number, list);
  }
  const decisions = pool.map((n) => lineDecision(n, byLine.get(n) ?? [], opts));
  const blocked = decisions.filter((d) => d.bench);
  const lines = decisions.filter((d) => !d.bench).map((d) => d.number);
  return {
    lines,
    blocked,
    reason: blocked.length === 0 ? `${lines.length} line(s) available` : `${blocked.length} benched, ${lines.length} available`,
  };
}
