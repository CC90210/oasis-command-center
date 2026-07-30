/**
 * lib/drips/immediate-core.ts — outcome policy for the instant "Send
 * Application" email (2026-07-30). Deliberately free of `server-only` and of
 * every import that touches IO, so it is unit-testable under tsx (see
 * lib/drips/stage-buffer.ts for the same pattern and the same reason).
 *
 * The IO shell is lib/drips/immediate.ts. Every DECISION lives here.
 */

export type InstantEmailStatus =
  | "sent" | "queued" | "disabled" | "duplicate" | "failed"
  | "skipped_no_email" | "skipped_suppressed" | "skipped_paused"
  | "held_circuit_open" | "held_no_app_link"
  | "held_blocked_by_guard" | "skipped_other";

export type InstantEmailOutcome = { status: InstantEmailStatus; reason?: string; runId?: string };

export type EnrollNowSkip =
  | "no_sequence" | "sequence_steps_invalid" | "dead_or_declined" | "opted_out"
  | "paused" | "docs_on_file" | "no_contact_method" | "already_enrolled"
  | "shopped_recently" | "accelerated_chase" | "insert_failed";

/**
 * Default ON. `SEND_APPLICATION_INSTANT=0` makes Save fall back to the normal
 * drip cadence.
 *
 * Deliberately independent of DRIPS_LIVE (spec 4.4): DRIPS_LIVE is the kill
 * switch for AUTOMATED drip output, while this is operator-initiated
 * transactional mail, semantically identical to a rep composing the email by
 * hand. Pausing marketing must not silently disable a button someone just
 * pressed. Takes env as a parameter so it is testable without mutating global
 * state.
 */
export function instantEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SEND_APPLICATION_INSTANT || "").trim() !== "0";
}

/** Total map — no `?? "queued"` fallback anywhere. An unmapped skip silently
 *  reading as "queued" is how a lead that will NEVER be mailed gets reported as
 *  merely waiting. */
const SKIP_TO_STATUS: Record<EnrollNowSkip, InstantEmailStatus> = {
  opted_out: "skipped_suppressed",
  paused: "skipped_paused",
  dead_or_declined: "skipped_paused",
  shopped_recently: "skipped_paused",
  accelerated_chase: "skipped_paused",
  no_contact_method: "skipped_no_email",
  already_enrolled: "duplicate",
  docs_on_file: "duplicate",
  no_sequence: "queued",
  sequence_steps_invalid: "failed",
  insert_failed: "failed",
};

export function skipToStatus(reason: EnrollNowSkip): InstantEmailStatus {
  return SKIP_TO_STATUS[reason];
}

/**
 * Map the drip_runs row's OWN recorded state to an operator-facing outcome.
 *
 * Why not use dispatchRuns' return value: it reports coarse tallies, while
 * suppression and the application-link halt are decided inside processEmailStep
 * and recorded on the row as `last_error`. Mapping tallies alone could never
 * produce skipped_suppressed or held_no_app_link — they would surface as a
 * misleading `failed` or `queued`.
 *
 * Only a settled row that was NOT skipped ever reports 'sent'.
 */
/** executor.ts advanceRow() terminalizes a SKIPPED step to the very same
 *  'sent'/'done' status a real send gets; the ONLY difference on the row is
 *  this prefix that skipStep writes into last_error. Checking status first
 *  would report "sent" for an email that never left the building. */
const SKIP_PREFIX = "skipped: ";

export function statusFromRow(row: { status: string; last_error: string | null }): InstantEmailStatus {
  const raw = (row.last_error || "").toLowerCase();
  const skipped = raw.startsWith(SKIP_PREFIX);
  const err = skipped ? raw.slice(SKIP_PREFIX.length) : raw;

  // Reason matching runs FIRST, on the un-prefixed remainder, so a skip is
  // always explained by its cause rather than by its (misleading) row status.
  if (err.includes("suppressed") || err.includes("unsubscrib") || err.includes("opted_out")) return "skipped_suppressed";
  if (err.includes("missing_application_link")) return "held_no_app_link";
  if (err.includes("no_email_for_email_step")) return "skipped_no_email";
  if (err.includes("blast_safety") || err.includes("positioning")) return "held_blocked_by_guard";

  // A skip we have no specific mapping for: say so plainly rather than
  // guessing. It is NOT sent and NOT merely queued — the sequence moved past it.
  if (skipped) return "skipped_other";

  if (row.status === "sent" || row.status === "done") return "sent";
  if (row.status === "failed") return "failed";
  return "queued"; // scheduled / sending / rescheduled — the row survives
}
