/**
 * website-sales-workflow.ts — the ONE owner of what a call outcome does to a
 * lead: which stage it moves to, which fields it stamps, and when the rep must
 * name a next action.
 *
 * WHY THIS FILE GREW (2026-08-23). The product had TWO call-logging paths that
 * did not know about each other:
 *
 *   Web Leads      WebLeadDetail / CallMode -> /api/web-leads/[id]/outcome
 *                  vocabulary: no_answer | connected | interested | not_interested
 *                  wrote: data.stage ONLY
 *
 *   Pipeline       LeadLifecycleActions -> /api/website-sales/[leadId]
 *                  vocabulary: attempted | voicemail | connected | lost
 *                  wrote: stage, last_disposition, last_contact_at, next_action_at
 *
 * Rep Today ranks a rep's whole day on `next_action_at` and shows
 * `last_disposition`. Only the SECOND path ever wrote either one. Reps call
 * from the first path -- that is where the 31,034 web-sales leads and Call Mode
 * live. So every callback a rep promised on a real call was recorded in a
 * vocabulary Rep Today does not read, into fields it does not set, and the
 * "call these first" queue ranked on a column nothing populated. The queue was
 * not broken; it was starved, and it looked identical either way.
 *
 * The fix is convergence, not a third vocabulary: this module owns the
 * disposition vocabulary, the stage move, the field stamps and the validation,
 * and BOTH routes call it. lib/web-leads/outcome.ts keeps its append-only
 * history table and its authorization boundary and delegates the lead patch
 * here.
 *
 * FORWARD-ONLY, EARLY-FUNNEL-ONLY (moved here from lib/web-leads/outcome.ts,
 * semantics preserved exactly -- see advanceStageForDisposition). CC's engine
 * (lib/website-sales.ts) owns the full fourteen-stage lifecycle and the
 * commission model on top of it. A disposition logged from a call may never
 * produce `qualified` or anything downstream of it, and may never move a lead
 * backwards.
 */

export const OASIS_WEBSITE_TENANT_SLUG = "oasis-webdev";

/**
 * The original four-value pipeline vocabulary. KEPT EXACTLY AS IT WAS: it is
 * the wire contract of /api/website-sales/[leadId]'s `disposition` action and
 * is asserted by tests/website-sales-workflow.test.ts. New code should prefer
 * CallDisposition below, which is a superset.
 */
export type RepDisposition = "attempted" | "voicemail" | "connected" | "lost";

/**
 * What actually happens on an outbound call, in the words a rep would use.
 *
 * The database was always ready for this. leadgen_call_outcomes.outcome has
 * carried a CHECK constraint permitting no_answer / voicemail / gatekeeper /
 * reached / callback / interested / not_interested / do_not_call / won since
 * the territories migration; the UI offered four of them. Widening the screen
 * to match the column needs no migration.
 *
 * WHY THESE EIGHT AND NOT MORE. Each one either changes what the system does
 * next (a callback creates a queue entry; do_not_call stops contact) or changes
 * what a manager can see about why a rep is not connecting (voicemail and
 * gatekeeper are very different problems and "no answer" hides both). A ninth
 * that does neither would be a button a rep has to think about mid-call for no
 * downstream effect.
 */
export const CALL_DISPOSITIONS = [
  "no_answer",
  "voicemail",
  "gatekeeper",
  "connected",
  "callback",
  "interested",
  "not_interested",
  "do_not_call",
] as const;

export type CallDisposition = (typeof CALL_DISPOSITIONS)[number];

export function isCallDisposition(v: unknown): v is CallDisposition {
  return typeof v === "string" && (CALL_DISPOSITIONS as readonly string[]).includes(v);
}

/** Dispositions where the rep never got the prospect on the phone. These are
 *  the ones that need a next attempt, because nothing has been decided yet. */
const NO_CONTACT: readonly CallDisposition[] = ["no_answer", "voicemail", "gatekeeper"];

/** A disposition that ENDS the conversation. Never schedule against these. */
const TERMINAL: readonly CallDisposition[] = ["not_interested", "do_not_call"];

export function isNoContactDisposition(d: CallDisposition): boolean {
  return NO_CONTACT.includes(d);
}

export function isTerminalDisposition(d: CallDisposition): boolean {
  return TERMINAL.includes(d);
}

/**
 * How long until the next attempt, per disposition, in minutes.
 *
 * OPERATOR DECISION (Adon, 2026-08-23): the system SUGGESTS a time and the rep
 * confirms it. Not a blank field on all 200 calls of a block, which is the
 * friction that makes reps stop logging; and not a silent default written
 * behind their back, which produces a queue full of times nobody chose.
 *
 * The spacing is per-disposition because the three no-contact outcomes are not
 * the same problem:
 *
 *   no_answer   3h   nobody picked up. Most likely wrong moment, not wrong
 *                    number, so try the other half of the same business day.
 *   voicemail   2d   they have now heard from us, and a second voicemail hours
 *                    later reads as pestering rather than persistence.
 *   gatekeeper  1d   the number is right and someone answered. Come back
 *                    tomorrow at a DIFFERENT hour to miss the same gatekeeper,
 *                    which is why this is 26h rather than a flat 24.
 *
 * `callback` has no entry on purpose: the prospect names that time, never us.
 */
const NEXT_ATTEMPT_MINUTES: Partial<Record<CallDisposition, number>> = {
  no_answer: 3 * 60,
  voicemail: 2 * 24 * 60,
  gatekeeper: 26 * 60,
};

/**
 * The time to PRE-FILL for this disposition, or null when the system has no
 * business guessing. Returns an ISO string so the caller can hand it straight
 * to the input the rep confirms.
 */
export function suggestedNextActionAt(
  disposition: CallDisposition,
  from: string | Date = new Date(),
): string | null {
  const minutes = NEXT_ATTEMPT_MINUTES[disposition];
  if (!minutes) return null;
  const base = typeof from === "string" ? Date.parse(from) : from.getTime();
  if (!Number.isFinite(base)) return null;
  return new Date(base + minutes * 60_000).toISOString();
}

/**
 * Does this disposition REFUSE to save without a next action?
 *
 * Only `callback`. A prospect who said "call me Thursday at 2" and then does
 * not appear in anyone's Thursday queue is the single worst data-loss event in
 * this workflow: the rep believes it is handled, and nothing will ever remind
 * them. The three no-contact dispositions get a suggested time instead of a
 * hard requirement, because a rep clearing voicemails must never be blocked --
 * an unscheduled lead still lands in Rep Today's "not yet scheduled" tier, so
 * it is not lost, merely lower priority than a promise we made out loud.
 */
export function requiresNextAction(disposition: CallDisposition): boolean {
  return disposition === "callback";
}

/**
 * THE FORWARD-ONLY GUARD. Moved verbatim in behaviour from
 * lib/web-leads/outcome.ts's nextStage(), which is where it was proven; that
 * function now delegates here so there is exactly one implementation.
 *
 * Returns the stage this disposition should move the lead to, or null for "do
 * not touch the stage".
 *
 * Anything AT OR BEYOND `connected` in WEBSITE_SALES_STAGES is untouchable,
 * whatever the disposition: CC's engine has already moved that lead and
 * commission accrual keys off those stages. An unrecognised current stage
 * (null, or absent from the list) is treated the same way -- never
 * guess-advance a lead this function cannot place.
 *
 * PURE. No I/O, fully testable without a database.
 *
 * `stages` is injected rather than imported so this module stays free of
 * lib/website-sales.ts (which pulls server-only code into the client bundle
 * through the components that import this file for its type exports).
 */
export function advanceStageForDisposition(
  current: string | null | undefined,
  disposition: CallDisposition,
  stages: readonly string[],
): string | null {
  // A lead nobody reached has not changed state. It is still being attempted.
  if (isNoContactDisposition(disposition)) return null;

  const connectedIndex = stages.indexOf("connected");
  const currentIndex = current ? stages.indexOf(current) : -1;

  // Unknown stage, or already at/past `connected`: CC owns it from here.
  if (currentIndex === -1 || currentIndex > connectedIndex) return null;

  // A prospect who said no, or said never contact me, is lost either way.
  if (isTerminalDisposition(disposition)) return "lost";

  // `connected`, `interested` and `callback` all land on `connected`: the rep
  // got them on the phone. Whether that is a QUALIFIED lead is CC's call, made
  // through the qualify action, never inferred from a rep's button press.
  return currentIndex < connectedIndex ? "connected" : null;
}

/** Thrown reasons, exported so routes can map them to stable error codes
 *  instead of matching on message text. */
export const WORKFLOW_ERRORS = {
  nextActionRequired: "next_action_required",
  nextActionMustBeFuture: "next_action_must_be_in_future",
  lossReasonRequired: "loss_reason_required",
} as const;

export function mayAgentQualify(stage: unknown): boolean {
  return stage === "connected";
}

export function mayAgentBookFounder(stage: unknown): boolean {
  return stage === "qualified";
}

/**
 * The ORIGINAL four-value patch builder, behaviour unchanged.
 *
 * Still the entry point for /api/website-sales/[leadId]'s `disposition`
 * action. It now expresses itself in terms of callDispositionPatch so the two
 * paths cannot drift apart, but its inputs, outputs, throw conditions and
 * stage mapping are exactly what tests/website-sales-workflow.test.ts pins.
 *
 * Note the deliberate difference from the newer builder: this one is NOT
 * stage-aware, because its caller (the pipeline lifecycle panel) is an
 * operator surface that is allowed to set `attempting_contact` on a lead
 * regardless of where it sits. The forward-only guard applies to the Web Leads
 * call logger, which is a rep surface.
 */
export function dispositionPatch(
  disposition: RepDisposition,
  nextActionAt: string | null,
  occurredAt = new Date().toISOString(),
  lossReason = "",
): Record<string, unknown> {
  if ((disposition === "attempted" || disposition === "voicemail") && !nextActionAt) {
    throw new Error(WORKFLOW_ERRORS.nextActionRequired);
  }
  if (nextActionAt && (!Number.isFinite(Date.parse(nextActionAt)) || Date.parse(nextActionAt) <= Date.parse(occurredAt))) {
    throw new Error(WORKFLOW_ERRORS.nextActionMustBeFuture);
  }
  if (disposition === "lost" && !lossReason.trim()) throw new Error(WORKFLOW_ERRORS.lossReasonRequired);
  const stage = disposition === "connected"
    ? "connected"
    : disposition === "lost"
      ? "lost"
      : "attempting_contact";
  return {
    stage,
    last_disposition: disposition,
    last_contact_at: occurredAt,
    next_action_at: nextActionAt,
    ...(disposition === "lost" ? { loss_reason: lossReason } : {}),
  };
}

/**
 * The patch a Web Leads call disposition applies to the lead record.
 *
 * This is the half that Rep Today reads. `last_disposition` is what the queue
 * shows beside each lead, and `next_action_at` is what it RANKS on -- overdue
 * first, then due today, then never-scheduled. Writing the outcome history row
 * without this patch is what made the queue permanently empty.
 *
 * `stage` is OMITTED from the returned object when the forward-only guard says
 * not to touch it, rather than being set to null. A null would blank the stage
 * of every lead CC's engine had already advanced, silently dragging won and
 * in-build deals back out of the pipeline -- a patch that is merged into
 * existing data must not carry keys it does not mean.
 */
export function callDispositionPatch(input: {
  disposition: CallDisposition;
  nextActionAt: string | null;
  currentStage: string | null | undefined;
  stages: readonly string[];
  occurredAt?: string;
}): Record<string, unknown> {
  const occurredAt = input.occurredAt || new Date().toISOString();
  const { disposition, stages } = input;

  // A prospect who is done with us must never also be scheduled for a callback.
  // Accepting both would put a lead we promised never to ring back at the top
  // of someone's queue tomorrow morning.
  const nextActionAt = isTerminalDisposition(disposition) ? null : input.nextActionAt;

  if (requiresNextAction(disposition) && !nextActionAt) {
    throw new Error(WORKFLOW_ERRORS.nextActionRequired);
  }
  if (nextActionAt) {
    const at = Date.parse(nextActionAt);
    if (!Number.isFinite(at) || at <= Date.parse(occurredAt)) {
      throw new Error(WORKFLOW_ERRORS.nextActionMustBeFuture);
    }
  }

  const stage = advanceStageForDisposition(input.currentStage, disposition, stages);

  return {
    ...(stage ? { stage } : {}),
    last_disposition: disposition,
    last_contact_at: occurredAt,
    // Explicitly null on a terminal disposition: that CLEARS a callback the
    // rep had previously scheduled, which is the correct outcome when the
    // prospect has now said no.
    next_action_at: nextActionAt,
    ...(disposition === "do_not_call"
      ? { do_not_call: true, do_not_call_at: occurredAt, do_not_call_source: "rep_call_disposition" }
      : {}),
  };
}
