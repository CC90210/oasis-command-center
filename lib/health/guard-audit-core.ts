/**
 * lib/health/guard-audit-core.ts — did each safety mechanism actually DO
 * anything, and did it do too much?
 *
 * WHY. Three independent bugs were found on 2026-08-20 and all three had the
 * same shape: a mechanism that existed, ran, threw no errors, and quietly
 * affected nothing.
 *
 *   1. matchThreadMessage gated on a provider field that the provider stopped
 *      sending. It excluded 100% of candidate messages. SMS delivery
 *      verification died estate-wide on 08-16 and looked like a quiet week.
 *   2. reconcileReceipts hardcoded which account's credentials to use, so one
 *      wire's threads were never readable. Those receipts sat at
 *      check_attempts=0 forever.
 *   3. A stage was missing from a routing list, so 25 queued texts were
 *      silently pointed at a different wire.
 *
 * None raised an error. None failed a test. Every one of them would have been
 * caught inside a week by asking two questions:
 *
 *   Did you act on anything?      (a guard that never fires may be unwired)
 *   Did you act on EVERYTHING?    (a filter that excludes all input is broken,
 *                                  and looks exactly like a quiet upstream)
 *
 * Adon, 2026-08-20: "add one recurring check that asks 'did each safety
 * mechanism actually do anything this week?' — if a filter matched nothing or a
 * monitor never fired, it says so."
 */

export type Expectation =
  /** A healthy window ALWAYS shows action. Zero means it is probably unwired.
   *  Example: the receipt reconciler, while texts are going out. */
  | "expect_action"
  /** Zero is normal and good. Example: the circuit breaker — we hope it never
   *  has to fire. Only "could not measure" is reportable. */
  | "zero_is_fine"
  /** A filter that removes candidates. Acting on EVERYTHING it saw is the
   *  100%-exclusion bug. Example: the thread matcher. */
  | "must_not_be_total";

export type InstrumentReading = {
  id: string;
  /** How many items the instrument examined. Null means the read failed. */
  considered: number | null;
  /** How many it acted on: matched, blocked, resolved, suppressed. Null means
   *  the read failed. */
  acted: number | null;
  expectation: Expectation;
  /** Plain-language description of what this mechanism protects. */
  what: string;
};

export type AuditFinding = {
  id: string;
  severity: "high" | "medium" | "info";
  message: string;
};

/**
 * Turn readings into findings.
 *
 * NOT KNOWING IS A FINDING. A reading that could not be taken is reported at
 * high severity rather than skipped: the entire lesson of 2026-08-16 is that an
 * absent signal reads identically to a healthy one, and a self-check that
 * silently drops unreadable instruments reproduces the bug it exists to catch.
 */
export function auditInstruments(readings: InstrumentReading[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const r of readings) {
    if (r.considered === null || r.acted === null) {
      out.push({
        id: r.id,
        severity: "high",
        message: `could not be measured — ${r.what}. Not knowing whether a guard is working is not the same as it working.`,
      });
      continue;
    }

    if (r.expectation === "must_not_be_total" && r.considered > 0 && r.acted === r.considered) {
      out.push({
        id: r.id,
        severity: "high",
        message:
          `excluded ALL ${r.considered} candidate(s) it saw — ${r.what}. ` +
          `A filter that rejects everything is indistinguishable from a quiet upstream, ` +
          `which is exactly how delivery verification died unnoticed on 2026-08-16.`,
      });
      continue;
    }

    if (r.expectation === "expect_action" && r.considered > 0 && r.acted === 0) {
      out.push({
        id: r.id,
        severity: "high",
        message:
          `saw ${r.considered} item(s) and acted on none — ${r.what}. ` +
          `Either it is unwired, or its match condition can no longer be met.`,
      });
      continue;
    }

    if (r.considered === 0) {
      // Nothing to judge. Worth saying once, quietly: an instrument with no
      // input for a week may be watching something that no longer happens.
      out.push({
        id: r.id,
        severity: "info",
        message: `had nothing to examine this window — ${r.what}.`,
      });
      continue;
    }

    if (r.acted === 0 && r.expectation === "zero_is_fine") {
      out.push({ id: r.id, severity: "info", message: `did not need to fire — ${r.what}.` });
    }
  }
  return out;
}

/** Anything that should page someone. */
export function reportable(findings: AuditFinding[]): AuditFinding[] {
  return findings.filter((f) => f.severity !== "info");
}

/**
 * One-line summary for the digest.
 *
 * Deliberately states the denominator. "3 findings" invites the reader to
 * assume the other instruments were checked and passed; "3 of 9" tells them how
 * much of the estate this actually covers, which is the honest framing when the
 * registry is known to be incomplete.
 */
export function summarize(readings: InstrumentReading[], findings: AuditFinding[]): string {
  const bad = reportable(findings).length;
  return bad === 0
    ? `all ${readings.length} instrument(s) did measurable work this window`
    : `${bad} of ${readings.length} instrument(s) need attention`;
}
