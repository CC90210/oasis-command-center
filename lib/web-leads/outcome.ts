/**
 * lib/web-leads/outcome.ts — call-outcome logging: the append-only history
 * row, and the lead patch that is its byproduct.
 *
 * THE DESIGN DECISION: the operator originally wanted a "transfer to
 * pipeline" button. A manual transfer is a second action a rep must
 * remember, and a pipeline is only accurate if everyone always remembers.
 * So logging the outcome IS the transfer -- a rep marks what happened on
 * the call and CC's stage moves itself.
 *
 * WHAT CHANGED 2026-08-23, AND WHY IT WAS URGENT. This module wrote ONLY
 * `data.stage`. It never wrote `next_action_at` or `last_disposition` -- the
 * two fields components/today/RepToday.tsx ranks and labels a rep's entire day
 * on. Those fields were written by a DIFFERENT call-logging path
 * (/api/website-sales/[leadId], driven from the pipeline lifecycle panel) in a
 * DIFFERENT four-word vocabulary. Reps call from this path, because this is
 * where the 31,034 web-sales leads and Call Mode are. So:
 *
 *   - "Call these first" ranked on a column nothing populated. Every rep's
 *     queue was permanently in its "never scheduled" tier.
 *   - A prospect who said "call me Thursday at 2" generated no Thursday
 *     anything. The rep believed it was handled.
 *   - An empty queue and a working-but-starved queue look identical on screen,
 *     so nothing ever reported this.
 *
 * The vocabulary is now the full eight a rep actually needs, and the lead
 * patch is built by lib/website-sales-workflow.ts -- the single owner of what
 * a disposition means -- rather than by a second stage list living here. See
 * that module's header for the convergence and the forward-only guard, which
 * moved there from this file with its behaviour unchanged.
 *
 * APPEND-ONLY. leadgen_call_outcomes has no update or delete path anywhere
 * in this module or its route -- a mis-click is corrected by logging a
 * later outcome, not by editing history, so a rep's call history is always
 * reconstructable. That property is also what makes the repair path below
 * possible.
 *
 * TENANT SCOPING IS THE AUTHORIZATION BOUNDARY, same as lib/web-leads/data.ts
 * and lib/web-leads/audit.ts: libSQL has no row-level security, so every
 * read and write here pins WEBDEV_TENANT_ID explicitly. This module does not
 * re-derive viewer authorization -- callers pass in a `lead` already
 * resolved by fetchLead(id, viewer) for that same id, same convention
 * fetchAudit() uses, so authorization happens exactly once per request.
 *
 * THE REAL leadgen_call_outcomes SCHEMA (verified against
 * services/leadgen/migrations/003_territories.sql in JARVIS, not assumed):
 *
 *   id             text primary key   -- generated here, randomUUID()
 *   tenant_id      text not null
 *   business_id    text not null      -- see leadRoutingInfo() below
 *   territory_id   text               -- nullable
 *   rep_user_id    text not null
 *   outcome        text not null CHECK (outcome in
 *                    ('no_answer','voicemail','gatekeeper','reached',
 *                     'callback','interested','not_interested',
 *                     'do_not_call','won'))
 *   notes          text               -- NOT "note" -- the request body's
 *                                         `note` field maps onto this column
 *   called_at      text not null
 *   next_action_at text               -- NOW USED. See above.
 *   created_at     text not null
 *
 * THE VOCABULARY MISMATCH: the CHECK constraint spells "got them on the
 * phone" as `reached`; this feature's API and UI spell it `connected` (which
 * also matches the WEBSITE_SALES_STAGES value the stage advance writes).
 * DB_OUTCOME/UI_OUTCOME_FROM_DB are the only place those two cross. Every
 * other disposition maps to itself -- the widened vocabulary was chosen to
 * match the constraint, so this needs no migration.
 *
 * business_id IS NOT lead_id. `leadgen_call_outcomes.business_id` keys on
 * `leadgen_businesses.id`, exactly like `leadgen_site_audits` does (see
 * audit.ts's header comment for the full mechanism and the two-pointer
 * indirection: leadgen_businesses.crm_record_id = <tenant_records.id>,
 * and data.webdev_source_business_id = <leadgen_businesses.id> stamped back
 * onto the promoted lead). Unlike audit.ts, a missing pointer here must not
 * make a real phone call unloggable -- so leadRoutingInfo()'s caller falls
 * back to the lead's own tenant_records id, keeping the NOT NULL column
 * satisfiable and the row still queryable by id either way.
 */

import { randomUUID } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { updateRecord } from "@/lib/manifest/data";
import { WEBSITE_SALES_STAGES } from "@/lib/website-sales";
import {
  CALL_DISPOSITIONS,
  advanceStageForDisposition,
  callDispositionPatch,
  isCallDisposition,
  type CallDisposition,
} from "@/lib/website-sales-workflow";
import { WEBDEV_TENANT_ID, type WebLead } from "./data";
import { safeFilterValue } from "./audit";
import {
  pushNextActionToCalendar,
  rollBackReminder,
  NEXT_ACTION_EVENT_ID_FIELD,
  type CalendarSyncStatus,
} from "./calendar-sync";

/**
 * The API/UI vocabulary. Identical to the workflow module's CallDisposition --
 * aliased rather than redeclared so the two can never drift into the two-
 * vocabulary problem this change exists to fix.
 */
export type CallOutcome = CallDisposition;

export const CALL_OUTCOMES: readonly CallOutcome[] = CALL_DISPOSITIONS;

export function isCallOutcome(v: unknown): v is CallOutcome {
  return isCallDisposition(v);
}

/** UI/API vocabulary -> the real leadgen_call_outcomes.outcome CHECK values.
 *  Only `connected` differs; the rest were named to match the constraint. */
const DB_OUTCOME: Record<CallOutcome, string> = {
  no_answer: "no_answer",
  voicemail: "voicemail",
  gatekeeper: "gatekeeper",
  connected: "reached",
  callback: "callback",
  interested: "interested",
  not_interested: "not_interested",
  do_not_call: "do_not_call",
};

/** The reverse of DB_OUTCOME, for rendering history back in the UI's own
 *  vocabulary. Any DB value this feature didn't write (`won`, or a legacy
 *  disposition) has no entry and is passed through as-is rather than
 *  mis-labelled. */
const UI_OUTCOME_FROM_DB: Partial<Record<string, CallOutcome>> = {
  no_answer: "no_answer",
  voicemail: "voicemail",
  gatekeeper: "gatekeeper",
  reached: "connected",
  callback: "callback",
  interested: "interested",
  not_interested: "not_interested",
  do_not_call: "do_not_call",
};

/**
 * THE CONSTRAINED PART -- read this before changing it.
 *
 * CC's engine (lib/website-sales.ts) owns the full fourteen-stage lifecycle and
 * the commission model built on top of it. We asked Bravo (agent_activity row
 * 5daa4bd1, 2026-08-21) for the supported way to advance a stage from here and
 * have not received a usable answer, so a disposition logged from a call is
 * DELIBERATELY restricted to the early funnel. It must NEVER produce
 * `qualified`, `founder_meeting_booked`, `proposal_sent`, `won`, `onboarding`,
 * `in_build`, `client_review`, `launched`, or anything else downstream --
 * those are CC's to move, and commission accrual and stage hooks key off them.
 * This is pending CC's answer; once it lands, THIS function is what gets
 * replaced, not its callers.
 *
 * The return type is a plain union of `"connected" | "lost" | null`, not a
 * search over the full stage list, so "no stage beyond these two can ever be
 * produced" holds BY CONSTRUCTION rather than by a runtime check a later edit
 * could loosen. The exhaustive proof is tests/web-leads-outcome.test.ts, which
 * runs every disposition against every stage.
 *
 * The forward-only decision itself moved to lib/website-sales-workflow.ts on
 * 2026-08-23 so that BOTH call-logging paths share one implementation (see
 * this module's header for why there were two). This function keeps the name,
 * the narrow return type and the constraint; it delegates the arithmetic.
 */
export function nextStage(
  current: string | null | undefined,
  outcome: CallOutcome,
): "connected" | "lost" | null {
  const stage = advanceStageForDisposition(current, outcome, WEBSITE_SALES_STAGES);
  // The workflow module returns a plain string; narrow it back to this
  // module's deliberately tiny union. Anything else would be a bug there, and
  // is dropped rather than propagated.
  return stage === "connected" || stage === "lost" ? stage : null;
}

export type CallOutcomeRecord = {
  id: string;
  outcome: CallOutcome | string;
  note: string | null;
  repUserId: string;
  calledAt: string;
  /** The next action the rep set when logging this call, if any. Rendered in
   *  history so a rep can see the callback they promised without leaving the
   *  panel. */
  nextActionAt: string | null;
};

const MAX_NOTE_LENGTH = 4000;

function boundedNote(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_NOTE_LENGTH);
}

/**
 * Raised when the history row was written but the lead patch was not.
 *
 * THIS IS THE HONEST FAILURE, and it is why it has its own type. The two
 * writes cannot be made atomic through this data layer: the append-only
 * history lives in leadgen_call_outcomes and the queue fields live in
 * tenant_records.data. If the second write fails and we returned success, the
 * rep would see "logged" and a callback that will never appear in anyone's
 * queue -- the exact failure this whole change exists to remove, reintroduced
 * one layer down.
 *
 * The repair is possible precisely BECAUSE the history is append-only: the
 * outcome row already carries the disposition and the next action, so
 * reconcileLeadFromHistory() can rebuild the lead patch from it with no new
 * history row and no rep re-entry. Retrying is therefore idempotent.
 */
export class ScheduleNotAppliedError extends Error {
  readonly outcomeId: string;
  readonly cause: string;
  constructor(outcomeId: string, cause: string) {
    super("schedule_not_applied");
    this.name = "ScheduleNotAppliedError";
    this.outcomeId = outcomeId;
    this.cause = cause;
  }
}

/**
 * The `leadgen_businesses.id` this lead was promoted from, and its CURRENT
 * `stage`, read off the same tenant_records row in one query. Mirrors
 * businessIdForLead in audit.ts (see this module's header, and that one's,
 * for why the lead id is not the business id) -- a plain read of two more
 * columns on a row the caller has already established is visible to this
 * viewer, not a second authorization check.
 */
async function leadRoutingInfo(
  id: string,
): Promise<{ businessId: string | null; stage: string | null; eventId: string | null }> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("tenant_records")
    .select("data")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`lead_data_read_failed: ${error.message}`);
  if (!data) return { businessId: null, stage: null, eventId: null };
  const row = data as { data: Record<string, unknown> };
  const businessId = row.data?.webdev_source_business_id;
  const stage = row.data?.stage;
  // The id Google assigned to this lead's reminder, if we have ever made
  // one. See lib/web-leads/calendar-sync.ts for why this is stored rather
  // than derived.
  const eventId = row.data?.[NEXT_ACTION_EVENT_ID_FIELD];
  return {
    businessId: typeof businessId === "string" && businessId.trim() ? businessId.trim() : null,
    stage: typeof stage === "string" && stage.trim() ? stage.trim() : null,
    eventId: typeof eventId === "string" && eventId.trim() ? eventId.trim() : null,
  };
}

type OutcomeRow = {
  id: string;
  outcome: string;
  notes: string | null;
  rep_user_id: string;
  called_at: string;
  next_action_at: string | null;
};

const OUTCOME_COLUMNS = "id, outcome, notes, rep_user_id, called_at, next_action_at";

function toRecord(row: OutcomeRow): CallOutcomeRecord {
  return {
    id: row.id,
    outcome: UI_OUTCOME_FROM_DB[row.outcome] ?? row.outcome,
    note: row.notes,
    repUserId: row.rep_user_id,
    calledAt: row.called_at,
    nextActionAt: row.next_action_at,
  };
}

/**
 * Apply the lead-side patch for a disposition. Split out from logCallOutcome
 * so the repair path can re-run exactly the same write without appending a
 * second history row.
 */
async function applyLeadPatch(input: {
  leadId: string;
  disposition: CallOutcome;
  nextActionAt: string | null;
  currentStage: string | null;
  occurredAt: string;
}): Promise<Record<string, unknown>> {
  const patch = callDispositionPatch({
    disposition: input.disposition,
    nextActionAt: input.nextActionAt,
    currentStage: input.currentStage,
    stages: WEBSITE_SALES_STAGES,
    occurredAt: input.occurredAt,
  });
  await updateRecord({
    tenant_id: WEBDEV_TENANT_ID,
    entity: "lead",
    id: input.leadId,
    patch,
  });
  return patch;
}

/**
 * Log a call outcome, and apply the lead patch that makes it visible in the
 * rep's queue. `lead` must already be the result of a tenant-pinned,
 * viewer-scoped fetchLead(id, viewer) call for this same id (the route
 * resolves it once for its own 404 check and passes it through), so
 * authorization happens exactly once per request, not twice.
 *
 * ORDER MATTERS. The append-only history row goes first, carrying the
 * disposition AND the next action, so that if the lead patch then fails the
 * truth of the call still exists and is replayable. The reverse order would
 * leave a scheduled callback with no record of the call that produced it.
 *
 * Never writes anything to tenant_records except the fields in
 * callDispositionPatch -- no pricing, commission, or other lifecycle field.
 */
export async function logCallOutcome(input: {
  leadId: string;
  lead: WebLead;
  outcome: CallOutcome;
  note?: unknown;
  nextActionAt?: string | null;
  repUserId: string;
}): Promise<{
  record: CallOutcomeRecord;
  stageChangedTo: "connected" | "lost" | null;
  nextActionAt: string | null;
  /** How the phone-side mirror went. NEVER affects whether the call was
   *  logged -- see the ordering rule in lib/web-leads/calendar-sync.ts. */
  calendarSync: CalendarSyncStatus;
}> {
  const { leadId, lead, outcome, repUserId } = input;
  const note = boundedNote(input.note);

  const { businessId, stage, eventId: existingEventId } = await leadRoutingInfo(leadId);
  // See the module header: a missing business_id pointer must not make a
  // real phone call unloggable, so this falls back to the lead's own id.
  const businessIdForWrite = safeFilterValue(businessId || leadId) || leadId;

  const nowIso = new Date().toISOString();

  // Validate BEFORE writing anything. callDispositionPatch throws on a
  // callback with no time, or any next action that is not in the future --
  // a rejected disposition must not leave a history row behind.
  const patch = callDispositionPatch({
    disposition: outcome,
    nextActionAt: input.nextActionAt ?? null,
    currentStage: stage,
    stages: WEBSITE_SALES_STAGES,
    occurredAt: nowIso,
  });
  const nextActionAt = (patch.next_action_at as string | null) ?? null;

  const db = getServiceSupabase();
  const ins = await db
    .from("leadgen_call_outcomes")
    .insert({
      id: randomUUID(),
      tenant_id: WEBDEV_TENANT_ID,
      business_id: businessIdForWrite,
      territory_id: lead.territoryId,
      rep_user_id: repUserId,
      outcome: DB_OUTCOME[outcome],
      notes: note,
      called_at: nowIso,
      next_action_at: nextActionAt,
      created_at: nowIso,
    })
    .select(OUTCOME_COLUMNS)
    .single();
  if (ins.error) throw new Error(`outcome_insert_failed: ${ins.error.message}`);

  const record = toRecord(ins.data as OutcomeRow);

  try {
    await updateRecord({
      tenant_id: WEBDEV_TENANT_ID,
      entity: "lead",
      id: leadId,
      patch,
    });
  } catch (err) {
    // The call happened and is recorded. The queue does not yet know. Say so
    // precisely rather than returning a success the rep would act on.
    throw new ScheduleNotAppliedError(record.id, err instanceof Error ? err.message : String(err));
  }

  // STEP 3, AND ONLY AFTER STEPS 1 AND 2 SUCCEEDED. The calendar is a mirror
  // of the queue, not a second source of truth, so it is pushed last and its
  // failure is reported rather than thrown. A rep whose Google is not connected
  // still has a complete, working queue; they just do not get the phone alert.
  const { status: calendarSync, eventId: newEventId } = await pushNextActionToCalendar({
    repUserId,
    businessName: lead.name,
    disposition: outcome,
    nextActionAt,
    existingEventId,
    phone: lead.phone,
    note,
  });

  // Remember what Google called it, so the next push updates that event
  // instead of creating a second one. Written only when it actually changed,
  // and in its own patch: this is mirror bookkeeping and it must not disturb
  // the queue fields the call already committed above.
  //
  // THIS FAILURE IS NOT SWALLOWED (Codex review, sixth pass, 2026-08-24). An
  // earlier version ignored it on the reasoning that the call was logged, the
  // queue was right and the reminder was on the phone. That reasoning was
  // wrong in the one case that matters most: if we created an event and then
  // failed to record its id, the event is UNADDRESSABLE. A later disposition
  // with no next action would pass a null id to the remover, get `ok` back
  // (nothing to remove), report "cleared" -- and leave a live reminder ringing
  // forever. For `do_not_call` that means a phone alert to ring a prospect who
  // asked us never to be called again, which is the one outcome here with a
  // legal edge on it.
  //
  // So a failed write-back ROLLS THE EVENT BACK using the id still held in
  // memory, returning to the clean state of "no reminder", and reports the
  // sync as failed. The rep is told their queue is saved but their phone is
  // not, which is true. Only if the rollback ALSO fails is there an orphan,
  // and that is reported rather than hidden.
  let syncStatus = calendarSync;
  if (newEventId !== existingEventId) {
    try {
      await updateRecord({
        tenant_id: WEBDEV_TENANT_ID,
        entity: "lead",
        id: leadId,
        patch: { [NEXT_ACTION_EVENT_ID_FIELD]: newEventId },
      });
    } catch (err) {
      const rolledBack = await rollBackReminder(repUserId, newEventId);
      syncStatus = {
        state: "failed",
        reason: "api_error",
        detail: rolledBack
          ? `event id not persisted, reminder rolled back: ${err instanceof Error ? err.message : String(err)}`
          : `event id not persisted AND rollback failed -- an unaddressable reminder may be live on this rep's calendar: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    record,
    stageChangedTo: (patch.stage as "connected" | "lost" | undefined) ?? null,
    nextActionAt,
    calendarSync: syncStatus,
  };
}

/**
 * THE REPAIR PATH for ScheduleNotAppliedError.
 *
 * Re-applies the lead patch from the most recent history row. Appends
 * nothing, asks the rep for nothing, and is safe to run repeatedly -- the
 * patch is a pure function of a row that can no longer change, so running it
 * twice produces the same lead state as running it once.
 *
 * Returns null when there is no history to reconcile from, which is not an
 * error: a lead nobody has called has nothing to repair.
 */
export async function reconcileLeadFromHistory(
  leadId: string,
): Promise<{ repaired: true; from: CallOutcomeRecord } | null> {
  const [latest] = await fetchRecentOutcomes(leadId, 1);
  if (!latest) return null;
  if (!isCallOutcome(latest.outcome)) return null;

  const { stage } = await leadRoutingInfo(leadId);
  await applyLeadPatch({
    leadId,
    disposition: latest.outcome,
    nextActionAt: latest.nextActionAt,
    currentStage: stage,
    // The ORIGINAL call time, not now: re-stamping last_contact_at with the
    // repair time would move a call into a day it did not happen in, and the
    // future-timestamp check must be measured against when the rep set it.
    occurredAt: latest.calledAt,
  });
  return { repaired: true, from: latest };
}

/**
 * This lead's outcome history, most recent first -- the "recent outcome
 * history" the panel renders after logging. Read-only; there is no
 * corresponding update or delete anywhere in this module.
 */
export async function fetchRecentOutcomes(leadId: string, limit = 20): Promise<CallOutcomeRecord[]> {
  const { businessId } = await leadRoutingInfo(leadId);
  const key = safeFilterValue(businessId || leadId) || leadId;

  const db = getServiceSupabase();
  const { data, error } = await db
    .from("leadgen_call_outcomes")
    .select(OUTCOME_COLUMNS)
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("business_id", key)
    .order("called_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`outcome_history_read_failed: ${error.message}`);

  return ((data || []) as OutcomeRow[]).map(toRecord);
}
