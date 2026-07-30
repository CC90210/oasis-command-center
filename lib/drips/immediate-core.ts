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

export type InstantEmailOutcome = {
  status: InstantEmailStatus;
  reason?: string;
  runId?: string;
  /** MASKED recipient (see maskEmail) — set ONLY on a verified 'sent' where the
   *  address is known. Never the raw address: this surfaces in an operator
   *  alert, and the repo's rule is PII is redacted in logs/alerts. The point is
   *  narrow: let the rep SEE which address it went to (catches a stale address
   *  on a phone-matched lead), not expose the full address. */
  to?: string;
};

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
  // NOT "queued": when there is no lead or no enabled transactional sequence
  // for this stage, no drip_runs row is created, so nothing is waiting and
  // nothing will ever send. Reporting it as queued would tell the rep the
  // email is on its way when the system has no way to send it.
  no_sequence: "skipped_other",
  sequence_steps_invalid: "failed",
  insert_failed: "failed",
};

export function skipToStatus(reason: EnrollNowSkip): InstantEmailStatus {
  return SKIP_TO_STATUS[reason];
}

const SKIP_PREFIX = "skipped: ";

/** The specific cause encoded in a last_error, or null if we have no mapping. */
function reasonOf(err: string): InstantEmailStatus | null {
  if (err.includes("suppressed") || err.includes("unsubscrib") || err.includes("opted_out")) return "skipped_suppressed";
  if (err.includes("missing_application_link")) return "held_no_app_link";
  if (err.includes("no_email_for_email_step")) return "skipped_no_email";
  if (err.includes("blast_safety") || err.includes("positioning")) return "held_blocked_by_guard";
  return null;
}

/** The `from_identity` prefix advanceRow stamps on a step it terminalized
 *  WITHOUT a real send: `alreadySentStep`'s dedup backstop, or a forced
 *  DRIPS_LIVE=0 / dry-run pass. Both settle the row to the same 'sent'/'done'
 *  status a genuine send gets, with no "skipped: " prefix on last_error — so
 *  from_identity is the ONLY signal that distinguishes them from a real send,
 *  which stamps the row with the actual sender address (e.g.
 *  "submissions@sunbizfunding.com", no prefix). See executor.ts finishStep /
 *  advanceRow and the two call sites at "dedup:...", "dry:...". */
const DEDUP_PREFIX = "dedup:";
const DRY_PREFIX = "dry:";

/**
 * Map a drip_runs row to an operator-facing outcome.
 *
 * FOUR cases, in order, because last_error is NEVER cleared by executor.ts and
 * from_identity is stamped on every terminal row regardless of path:
 *
 *  0. from_identity carries the dedup/dry marker. advanceRow gives THIS row the
 *     SAME 'sent'/'done' status and (crucially) the SAME null/stale last_error
 *     a real send would leave — no "skipped: " prefix exists for this path, so
 *     from_identity must be checked FIRST, before the terminal check below ever
 *     gets a chance to read the row as a genuine send. Without this a
 *     legitimate re-send that the never-double-send backstop silently
 *     swallowed (or a forced dry run) was reported to the rep as "queued" —
 *     mail that was never sent and never would be, on a row the cron will
 *     never touch again because it is already terminal.
 *  1. SKIPPED (last_error carries the "skipped: " prefix). advanceRow gives a
 *     skipped step the SAME 'sent'/'done' status as a real send, so the prefix
 *     is the only signal. Never report sent; explain the cause.
 *  2. TERMINAL with no skip prefix and no dedup/dry marker. This was a genuine
 *     send, and any last_error is STALE residue from an earlier hold or
 *     reschedule that was never cleared. It must NOT override the send.
 *  3. NOT TERMINAL. The row is still in flight, held, or failed, so last_error
 *     IS the current reason — match it (this is the 6h app-link hold, which is
 *     status 'scheduled' and carries no prefix).
 */
export function statusFromRow(row: {
  status: string;
  last_error: string | null;
  from_identity?: string | null;
}): InstantEmailStatus {
  const from = (row.from_identity || "").toLowerCase();
  if (from.startsWith(DEDUP_PREFIX)) return "duplicate";
  if (from.startsWith(DRY_PREFIX)) return "disabled";

  const raw = (row.last_error || "").toLowerCase();
  const skipped = raw.startsWith(SKIP_PREFIX);
  const err = skipped ? raw.slice(SKIP_PREFIX.length) : raw;
  const terminal = row.status === "sent" || row.status === "done";

  if (skipped) return reasonOf(err) ?? "skipped_other";
  if (terminal) return "sent";
  return reasonOf(err) ?? (row.status === "failed" ? "failed" : "queued");
}

/**
 * Mask an email address for a PII-safe operator alert: first character of the
 * local part, then a fixed "***", then "@domain" verbatim (e.g.
 * "acme@example.com" -> "a***@example.com"). Never returns the full address.
 * Pure and total — no throwing on malformed input, because this only ever
 * feeds a one-line alert, never a decision.
 */
export function maskEmail(email: string): string {
  if (!email) return "";
  const at = email.indexOf("@");
  if (at === -1) return `${email[0]}***`;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local[0] || ""}***@${domain}`;
}
