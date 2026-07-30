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
  | "held_circuit_open" | "held_no_app_link";

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
 * Only a settled row ever reports 'sent'.
 */
export function statusFromRow(row: { status: string; last_error: string | null }): InstantEmailStatus {
  const err = (row.last_error || "").toLowerCase();
  if (row.status === "sent" || row.status === "done") return "sent";
  if (err.includes("suppressed") || err.includes("unsubscrib") || err.includes("opted_out")) {
    return "skipped_suppressed";
  }
  // Matches BOTH strings executor.ts writes for this condition: the 6h hold
  // ("missing_application_link (no form/HMAC key)") and the give-up skip
  // ("missing_application_link: skipped after retries (no form/HMAC key)").
  // Matched on the underscore form because that is what the executor actually
  // writes — an earlier draft matched "application link"/"app_link" and caught
  // neither, silently degrading a halt into a generic "failed".
  if (err.includes("missing_application_link")) return "held_no_app_link";
  if (err.includes("no_email_for_email_step")) return "skipped_no_email";
  if (row.status === "failed") return "failed";
  return "queued"; // scheduled / sending / rescheduled — the row survives
}
