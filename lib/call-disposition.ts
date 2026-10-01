/**
 * One vocabulary for "what happened on that call".
 *
 * THE PROBLEM THIS SOLVES. Two paths record calls and each invented its own
 * words for the same events:
 *
 *   the board     lib/web-leads/outcome.ts        no_answer connected interested
 *                                                 not_interested do_not_call
 *   the pipeline  lib/website-sales-workflow.ts   attempted voicemail connected lost
 *
 * Both write `tenant_records.data.last_disposition`, so which vocabulary a lead
 * ends up carrying depends on which screen the rep happened to use. That field
 * is rendered to a rep in components/today/RepToday.tsx, so one lead reads
 * "attempted" and another reads "no_answer" for the same real event. It also
 * makes counting across the two impossible, which is what blocks stage-conversion
 * reporting.
 *
 * THE CANONICAL SET IS NOT NEW. It is the CHECK constraint that has always been
 * on leadgen_call_outcomes.outcome, and it is very nearly the union of the two
 * code vocabularies already. Whoever wrote that schema anticipated one
 * vocabulary; the two paths each implemented a different subset of it. Inventing
 * a tenth value here would be fixing "two vocabularies" by having three.
 *
 * Three of the nine (gatekeeper, callback, won) are permitted by the constraint
 * and written by nobody today. They are listed because the database accepts them
 * and a reader of this file should not have to go looking; adopting them in a UI
 * is a separate piece of work.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not migrate storage. The
 * board keeps its append-only ledger, the pipeline keeps its patch, and both
 * keep their own idempotency. Only the VALUE they agree on changes. Correcting a
 * mapper is cheap; correcting a migrated ledger is not.
 *
 * Type-only imports below, so this module can be imported by both paths without
 * creating a runtime cycle.
 */
import type { CallOutcome } from "./web-leads/outcome";
import type { RepDisposition } from "./website-sales-workflow";

/** The CHECK constraint on leadgen_call_outcomes.outcome, in its own order. */
export const CANONICAL_DISPOSITIONS = [
  "no_answer",
  "voicemail",
  "gatekeeper",
  "reached",
  "callback",
  "interested",
  "not_interested",
  "do_not_call",
  "won",
] as const;

export type CanonicalDisposition = (typeof CANONICAL_DISPOSITIONS)[number];

/**
 * The board's words to the canonical ones.
 *
 * This mapping already existed in outcome.ts as DB_OUTCOME and was already used
 * for the ledger row and the interaction row. It was simply not used for
 * last_disposition, which is why that one field disagreed with the other two
 * writes from the same function.
 */
export const CANONICAL_FROM_CALL_OUTCOME: Record<CallOutcome, CanonicalDisposition> = {
  no_answer: "no_answer",
  connected: "reached",
  interested: "interested",
  not_interested: "not_interested",
  do_not_call: "do_not_call",
};

/**
 * The pipeline's words to the canonical ones.
 *
 * `attempted` is a dial that reached nobody, which is `no_answer`. `lost` is a
 * closed-out lead, which is `not_interested` — the pipeline carries the reason
 * separately in `loss_reason`, so nothing is lost in the mapping.
 */
export const CANONICAL_FROM_REP_DISPOSITION: Record<RepDisposition, CanonicalDisposition> = {
  attempted: "no_answer",
  voicemail: "voicemail",
  connected: "reached",
  lost: "not_interested",
};

export function canonicalFromCallOutcome(o: CallOutcome): CanonicalDisposition {
  return CANONICAL_FROM_CALL_OUTCOME[o];
}

export function canonicalFromRepDisposition(d: RepDisposition): CanonicalDisposition {
  return CANONICAL_FROM_REP_DISPOSITION[d];
}

const LABELS: Record<CanonicalDisposition, string> = {
  no_answer: "No answer",
  voicemail: "Voicemail",
  gatekeeper: "Gatekeeper",
  reached: "Connected",
  callback: "Callback booked",
  interested: "Interested",
  not_interested: "Not interested",
  do_not_call: "Do not call",
  won: "Won",
};

/**
 * What to show a person, for a value that may predate this module.
 *
 * READ-SIDE NORMALISATION IS WHY NO BACKFILL IS NEEDED. Existing rows carry
 * whichever raw vocabulary wrote them, and rewriting history in a store the
 * product treats as a ledger is a decision for a human, not a side effect of a
 * refactor. So this understands the legacy words too: an old `attempted` and a
 * new `no_answer` both render "No answer", and the inconsistency a rep can
 * actually see is gone from the moment this ships, for old rows as well as new.
 *
 * An unrecognised value is returned as it came rather than replaced with a
 * guess or a blank. A label that invents meaning for a value it does not know is
 * worse than one that admits it.
 */
export function dispositionLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  if (v in LABELS) return LABELS[v as CanonicalDisposition];
  // Legacy rows, written before both paths agreed. `connected` is the most
  // common of them by a distance, because BOTH old vocabularies used that word
  // for reaching a human -- so it is the one a rep is most likely to be looking
  // at right now, and the easiest to forget here precisely because it reads like
  // a canonical value.
  if (v === "connected") return LABELS.reached;
  if (v === "attempted") return LABELS.no_answer;
  if (v === "lost") return LABELS.not_interested;
  return v;
}
