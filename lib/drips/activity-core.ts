/**
 * lib/drips/activity-core.ts — what the drip engine ACTUALLY sent.
 *
 * WHY A CLASSIFIER AND NOT A STATUS COLUMN. `drip_runs.status` is not a record
 * of delivery, it is a record of the row advancing. Measured 2026-08-10:
 *
 *   1,348 sms rows read status='sent'
 *     484 carried a real from_identity  -> genuinely handed to a provider
 *     864 carried NULL from_identity    -> ADVANCED, never sent
 *
 * A 400-row sample of that 864 was 100% skips ("no_email_for_email_step",
 * "sms_delivery_failed_after_retries") and 0% carried a provider id. So a
 * surface that renders `status` verbatim tells an operator 1,348 messages went
 * out when 484 did, and computes a failure rate against a denominator that is
 * two-thirds fiction.
 *
 * That is the same class of untruth as the ten-day SMS outage, one layer up:
 * a row that says 'sent' while nobody received anything. This file exists so
 * the Drips tab cannot repeat it.
 *
 * Pure and free of "server-only" so the rule is directly testable; all I/O
 * lives in activity-queries.ts.
 */

/** What actually happened to a step, as opposed to what the status column says. */
export type ActivityStatus =
  | "sent"
  | "dry_run"
  | "skipped"
  | "failed"
  | "scheduled"
  | "sending"
  | "cancelled"
  | "unknown";

export type RunShape = {
  status?: string | null;
  /** "rep:number" on a real send, "dry:rep:number" on a rehearsal, NULL when
   *  the row merely advanced without contacting a provider. */
  from_identity?: string | null;
};

/**
 * Fold (status, from_identity) into what genuinely happened.
 *
 * from_identity is the discriminator because it is written only where a
 * provider was actually addressed. Trusting `status` alone is what makes a
 * skip indistinguishable from a send.
 */
export function classifyRunStatus(row: RunShape): ActivityStatus {
  const status = String(row.status ?? "").toLowerCase();
  const from = row.from_identity == null ? null : String(row.from_identity);

  // Terminal-but-advanced. 'done' is the sequence-final equivalent of 'sent';
  // advanceRow writes `isLast ? "done" : "sent"`, so both must be read the same
  // way or every final step is miscounted.
  if (status === "sent" || status === "done") {
    if (from === null || from === "") return "skipped";
    if (from.startsWith("dry:")) return "dry_run";
    return "sent";
  }
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "scheduled") return "scheduled";
  if (status === "sending") return "sending";
  return "unknown";
}

export type FailureSummary = {
  /** Rows genuinely handed to a provider. The only honest denominator. */
  realSends: number;
  failed: number;
  skipped: number;
  dryRun: number;
  /** Percentage over realSends + failed, rounded. Null when there is nothing
   *  to judge — a rate of "0%" from an empty sample reads as healthy and is
   *  the exact false green this file exists to prevent. */
  failureRatePct: number | null;
};

export function summarizeFailures(rows: RunShape[]): FailureSummary {
  let realSends = 0;
  let failed = 0;
  let skipped = 0;
  let dryRun = 0;
  for (const r of rows) {
    switch (classifyRunStatus(r)) {
      case "sent": realSends++; break;
      case "failed": failed++; break;
      case "skipped": skipped++; break;
      case "dry_run": dryRun++; break;
      default: break;
    }
  }
  const denominator = realSends + failed;
  return {
    realSends,
    failed,
    skipped,
    dryRun,
    failureRatePct: denominator === 0 ? null : Math.round((failed / denominator) * 100),
  };
}

/**
 * Steps we deliberately declined to send: no lawful basis to text, no reachable
 * channel, or a provider not wired.
 *
 * Kept separate from `failed` on purpose. These are policy working correctly,
 * and folding them into the failure rate would make a healthy compliance gate
 * look like an outage — which would train an operator to ignore the number.
 */
export function isHeldForPolicy(lastError: unknown): boolean {
  return /sms_no_lawful_basis|unreachable:|sms_channel_unavailable|email_channel_unavailable|sms_provider_not_wired/.test(
    String(lastError ?? ""),
  );
}

/**
 * The activity window, expressed on OUTCOME time rather than schedule time.
 *
 * `scheduled_for` is when a step became DUE; it says nothing about when the
 * merchant heard from us. A step queued four days ago and retried until it sent
 * this morning IS this morning's activity, and a 24h window keyed on
 * `scheduled_for` drops it, so a burst of sends after a backlog cleared would be
 * invisible on the very tab built to show sends.
 *
 * But `sent_at` alone is worse. The executor stamps it only on the success path
 * (executor.ts, markSent), so a `sent_at`-only filter reports ZERO failures no
 * matter how many there were, and failures are what this tab exists to catch.
 *
 * So the filter is an OR: terminal sends measured by when they SENT, everything
 * still open (pending, retrying, failed) measured by when it was DUE. Returned
 * as a PostgREST `or=` string. It lives here, out of the server-only query
 * module, so the rule itself is directly testable.
 */
export function outcomeWindow(sinceIso: string): string {
  return `sent_at.gte.${sinceIso},and(sent_at.is.null,scheduled_for.gte.${sinceIso})`;
}
