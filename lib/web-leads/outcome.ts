/**
 * lib/web-leads/outcome.ts — call-outcome logging, and the stage advance
 * that is its byproduct.
 *
 * THE DESIGN DECISION: the operator originally wanted a "transfer to
 * pipeline" button. A manual transfer is a second action a rep must
 * remember, and a pipeline is only accurate if everyone always remembers.
 * So logging the outcome IS the transfer -- a rep marks what happened on
 * the call and CC's stage moves itself. See nextStage() below for exactly
 * how far that is allowed to go.
 *
 * APPEND-ONLY. leadgen_call_outcomes has no update or delete path anywhere
 * in this module or its route -- a mis-click is corrected by logging a
 * later outcome, not by editing history, so a rep's call history is always
 * reconstructable.
 *
 * TENANT SCOPING IS THE AUTHORIZATION BOUNDARY, same as lib/web-leads/data.ts
 * and lib/web-leads/audit.ts: libSQL has no row-level security, so every
 * read and write here pins WEBDEV_TENANT_ID explicitly. Callers pass a `lead`
 * already resolved by fetchLead(id, viewer), while the POST route separately
 * proves sales role plus ownership. The owner is then frozen on the durable
 * outcome row and included in each context/stage CAS so a concurrent transfer
 * cannot turn a valid authorization check into a write on somebody else's lead.
 *
 * THE REAL leadgen_call_outcomes SCHEMA (verified against the live Turso
 * table, with the retry columns added by migration 158):
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
 *   next_action_at text               -- unused by this build
 *   created_at     text not null
 *   request_id     text               -- client-stable UUID; unique per tenant
 *   stage_from     text               -- decision snapshot for retry resumption
 *   stage_to       text               -- nullable target chosen on first write
 *   owner_user_id  text               -- assigned owner frozen with the call
 *
 * THE VOCABULARY MISMATCH THIS FORCED: the design spec's four-button model
 * (no_answer / connected / interested / not_interested) does not match that
 * CHECK constraint -- there is no 'connected' in it. That constraint was
 * built for a wider, general call-disposition workflow (voicemail,
 * gatekeeper, callback, do_not_call, won) that this feature doesn't use.
 * 'reached' is the constraint's value for "got the prospect on the phone",
 * so DB_OUTCOME below is where the UI's 'connected' becomes the DB's
 * 'reached' on write, and UI_OUTCOME_FROM_DB is the reverse on read -- the
 * public API keeps the plan's 'connected' spelling (it also matches the
 * WEBSITE_SALES_STAGES value the stage advance writes), so this map is the
 * only place the two vocabularies cross.
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
import { isUniqueViolationError } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import { RecordsError, updateRecord } from "@/lib/manifest/data";
import { persistCanonicalLeadTouch } from "@/lib/leads/canonical-touch";
import { WEBSITE_SALES_STAGES, type WebsiteSalesStage } from "@/lib/website-sales";
import { WEBDEV_TENANT_ID, type WebLead } from "./data";
import { safeFilterValue } from "./audit";

export type CallOutcome = "no_answer" | "connected" | "interested" | "not_interested";

export const CALL_OUTCOMES: readonly CallOutcome[] = ["no_answer", "connected", "interested", "not_interested"];

export function isCallOutcome(v: unknown): v is CallOutcome {
  return typeof v === "string" && (CALL_OUTCOMES as readonly string[]).includes(v);
}

/** UI/API vocabulary -> the real leadgen_call_outcomes.outcome CHECK values. */
const DB_OUTCOME: Record<CallOutcome, string> = {
  no_answer: "no_answer",
  connected: "reached",
  interested: "interested",
  not_interested: "not_interested",
};

/** The reverse of DB_OUTCOME, for rendering history back in the UI's own
 *  vocabulary. Any DB value this feature didn't write (a legacy/foreign
 *  disposition from the constraint's wider set) has no entry and is passed
 *  through as-is rather than mis-labelled. */
const UI_OUTCOME_FROM_DB: Partial<Record<string, CallOutcome>> = {
  no_answer: "no_answer",
  reached: "connected",
  interested: "interested",
  not_interested: "not_interested",
};

/**
 * THE CONSTRAINED PART -- read this before changing it.
 *
 * CC's engine (lib/website-sales.ts) owns the full fourteen-stage lifecycle
 * and the commission model built on top of it. This call-disposition surface
 * is DELIBERATELY restricted to the early funnel: it gets a claimed cold lead
 * through a first attempt and connection, then Pipeline's explicit lifecycle
 * actions take over for qualification and the founder-meeting handoff. It must
 * NEVER produce
 * `qualified`, `founder_meeting_booked`, `proposal_sent`, `won`,
 * `onboarding`, `in_build`, `client_review`, `launched`, or anything else
 * downstream -- those are CC's to move, and commission accrual and stage
 * hooks key off them. Its only possible moves are the first-attempt edge to
 * `attempting_contact`, a successful connection to `connected`, or a clear
 * rejection to `lost`.
 *
 * FORWARD ONLY, AND ONLY WITHIN OUR ZONE. A lead's position is looked up in
 * WEBSITE_SALES_STAGES and compared against `connected`'s position. Anything
 * beyond `connected` returns null unconditionally, so this can never regress a
 * lead CC has already advanced. At `connected`, the only remaining lifecycle
 * edge this surface owns is an explicit `not_interested` rejection to `lost`;
 * successful outcomes are no-ops until Pipeline performs qualification. An
 * unrecognized current stage (null, or a value not in WEBSITE_SALES_STAGES)
 * also fails closed: never guess-advance a stage this function cannot place.
 *
 * Within that zone: a first `no_answer` moves researched/assigned leads to
 * `attempting_contact`, but a later no-answer never advances or regresses the
 * lead. `connected` and `interested` both land on `connected` -- the
 * qualification call is CC's to make, not ours. `not_interested` lands on
 * `lost`.
 *
 * PURE -- no I/O, so this is fully testable without a DB. See
 * tests/web-leads-outcome.test.ts.
 */
export function nextStage(current: string | null | undefined, outcome: CallOutcome): WebsiteSalesStage | null {
  if (outcome === "no_answer") {
    return current === "researched" || current === "assigned" ? "attempting_contact" : null;
  }

  const stages: readonly string[] = WEBSITE_SALES_STAGES;
  const connectedIndex = stages.indexOf("connected");
  const currentIndex = current ? stages.indexOf(current) : -1;

  if (currentIndex === -1 || currentIndex > connectedIndex) return null;

  if (outcome === "not_interested") return "lost";

  // outcome is "connected" or "interested" -- both land on "connected".
  return currentIndex < connectedIndex ? "connected" : null; // already there: no-op, never backwards
}

export type CallOutcomeRecord = {
  id: string;
  outcome: CallOutcome | string;
  note: string | null;
  repUserId: string;
  calledAt: string;
};

export const MAX_CALL_NOTE_LENGTH = 4000;
const CALL_OUTCOME_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCallOutcomeRequestId(value: unknown): value is string {
  return typeof value === "string" && CALL_OUTCOME_REQUEST_ID.test(value.trim());
}

/** True once this call, or a chronologically newer call, owns Last Touch. */
export function outcomeTouchAlreadyApplied(lastCallAt: string | null | undefined, calledAt: string): boolean {
  const calledMs = Date.parse(calledAt);
  if (!Number.isFinite(calledMs)) return false;
  const lastMs = typeof lastCallAt === "string" ? Date.parse(lastCallAt) : Number.NaN;
  return Number.isFinite(lastMs) && lastMs >= calledMs;
}

/** A later call owns mutable disposition/note context. Older retries still
 * repair their append-only ledger rows, but never overwrite that newer call. */
export function outcomeContextSuperseded(lastCallAt: string | null | undefined, calledAt: string): boolean {
  const calledMs = Date.parse(calledAt);
  const lastMs = typeof lastCallAt === "string" ? Date.parse(lastCallAt) : Number.NaN;
  return Number.isFinite(calledMs) && Number.isFinite(lastMs) && lastMs > calledMs;
}

export type CallOutcomeNoteValidation =
  | { ok: true; note: string | null }
  | { ok: false; error: "reason_required" | "note_too_long" };

/**
 * Keep the HTTP route and both client surfaces on one validation contract.
 * A rejection changes lifecycle state and therefore needs a durable reason;
 * silently truncating that reason would make the closed-loop handoff false.
 */
export function validateCallOutcomeNote(outcome: CallOutcome, value: unknown): CallOutcomeNoteValidation {
  const note = typeof value === "string" ? value.trim() : "";
  if (outcome === "not_interested" && !note) return { ok: false, error: "reason_required" };
  if (note.length > MAX_CALL_NOTE_LENGTH) return { ok: false, error: "note_too_long" };
  return { ok: true, note: note || null };
}

/**
 * The routing, lifecycle, touch and owner facts needed to resume this call,
 * read off the same tenant_records row in one query. Mirrors
 * businessIdForLead in audit.ts (see this module's header, and that one's,
 * for why the lead id is not the business id) -- a plain read of two more
 * columns on a row the caller has already established is visible to this
 * viewer. The POST route owns authorization; the owner returned here becomes
 * an atomic write precondition so that authorization cannot race a transfer.
 */
async function leadRoutingInfo(id: string): Promise<{
  businessId: string | null;
  stage: string | null;
  lastCallAt: string | null;
  assignedTo: string | null;
}> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("tenant_records")
    .select("data")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`lead_data_read_failed: ${error.message}`);
  if (!data) return { businessId: null, stage: null, lastCallAt: null, assignedTo: null };
  const row = data as { data: Record<string, unknown> };
  const businessId = row.data?.webdev_source_business_id;
  const stage = row.data?.stage;
  const lastCallAt = row.data?.last_call_at;
  const assignedTo = row.data?.assigned_to;
  return {
    businessId: typeof businessId === "string" && businessId.trim() ? businessId.trim() : null,
    stage: typeof stage === "string" && stage.trim() ? stage.trim() : null,
    lastCallAt: typeof lastCallAt === "string" && lastCallAt.trim() ? lastCallAt.trim() : null,
    assignedTo: typeof assignedTo === "string" && assignedTo.trim() ? assignedTo.trim() : null,
  };
}

function toRecord(row: { id: string; outcome: string; notes: string | null; rep_user_id: string; called_at: string }): CallOutcomeRecord {
  return {
    id: row.id,
    outcome: UI_OUTCOME_FROM_DB[row.outcome] ?? row.outcome,
    note: row.notes,
    repUserId: row.rep_user_id,
    calledAt: row.called_at,
  };
}

/**
 * Log a call outcome and, as its byproduct, advance the stage per
 * nextStage(). `lead` must already be the result of a tenant-pinned,
 * viewer-scoped fetchLead(id, viewer) call for this same id (the route
 * resolves it once for its own 404 check and passes it through), so
 * authorization happens exactly once per request, not twice.
 *
 * Alongside the constrained stage edge, every result stamps the canonical
 * touch/disposition fields used by Pipeline. A supplied note becomes the
 * handoff note, and a first transition to lost also records the loss reason.
 */
export async function logCallOutcome(input: {
  leadId: string;
  lead: WebLead;
  outcome: CallOutcome;
  note?: unknown;
  repUserId: string;
  requestId: string;
}): Promise<{
  record: CallOutcomeRecord;
  stageChangedTo: WebsiteSalesStage | null;
  trackingWarning: "timeline_tracking_failed" | null;
  idempotent: boolean;
  saveState: CallOutcomeSaveState;
}> {
  const { leadId, lead, outcome, repUserId } = input;
  const requestId = input.requestId.trim().toLowerCase();
  if (!isCallOutcomeRequestId(requestId)) throw new Error("invalid_request_id");
  const noteResult = validateCallOutcomeNote(outcome, input.note);
  if (!noteResult.ok) throw new Error(noteResult.error);
  const note = noteResult.note;

  const initialRouting = await leadRoutingInfo(leadId);
  // See the module header: a missing business_id pointer must not make a
  // real phone call unloggable, so this falls back to the lead's own id.
  const businessIdForWrite = safeFilterValue(initialRouting.businessId || leadId) || leadId;

  const nowIso = new Date().toISOString();
  const initialTarget = nextStage(initialRouting.stage, outcome);
  const db = getServiceSupabase();
  const selectColumns = "id, request_id, business_id, outcome, notes, rep_user_id, called_at, stage_from, stage_to, owner_user_id";
  const ins = await db
    .from("leadgen_call_outcomes")
    .insert({
      id: randomUUID(),
      request_id: requestId,
      tenant_id: WEBDEV_TENANT_ID,
      business_id: businessIdForWrite,
      territory_id: lead.territoryId,
      rep_user_id: repUserId,
      outcome: DB_OUTCOME[outcome],
      notes: note,
      called_at: nowIso,
      created_at: nowIso,
      stage_from: initialRouting.stage,
      stage_to: initialTarget,
      owner_user_id: initialRouting.assignedTo,
    })
    .select(selectColumns)
    .single();
  let stored: StoredCallOutcome;
  let idempotent = false;
  if (!ins.error && ins.data) {
    stored = ins.data as StoredCallOutcome;
  } else if (ins.error && isUniqueViolationError(ins.error)) {
    const replay = await db
      .from("leadgen_call_outcomes")
      .select(selectColumns)
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("request_id", requestId)
      .maybeSingle();
    if (replay.error || !replay.data) {
      throw new CallOutcomeSaveError(
        "resume_failed",
        // A unique error normally means this request-id row won the race, but
        // until that exact row is read back we have not proved which unique
        // constraint fired. Report only confirmed durability to the client.
        { outcomeSaved: false, stageSaved: false, leadContextSaved: false, touchSaved: false, trackingSaved: false },
        `outcome_replay_read_failed:${replay.error?.message || "row_missing"}`,
      );
    }
    stored = replay.data as StoredCallOutcome;
    idempotent = true;
  } else {
    throw new Error(`outcome_insert_failed:${ins.error?.message || "missing_inserted_row"}`);
  }

  if (!sameLogicalOutcome(stored, { businessId: businessIdForWrite, fallbackLeadId: leadId, repUserId, outcome, note })) {
    throw new CallOutcomeSaveError(
      "request_id_conflict",
      { outcomeSaved: false, stageSaved: false, leadContextSaved: false, touchSaved: false, trackingSaved: false },
      "request_id_already_used_for_different_outcome",
    );
  }

  const calledAt = stored.called_at;
  const stageFrom = stored.stage_from;
  const target = websiteSalesStage(stored.stage_to);
  const expectedOwner = stored.owner_user_id;
  if (stored.stage_to && !target) {
    throw new CallOutcomeSaveError(
      "resume_failed",
      { outcomeSaved: true, stageSaved: false, leadContextSaved: false, touchSaved: false, trackingSaved: false },
      `invalid_stored_stage_to:${stored.stage_to}`,
    );
  }

  // THE CONSTRAINED PART -- see nextStage()'s doc comment above. These guarded
  // tenant_records writes touch only the early-funnel stage plus canonical
  // touch, disposition and handoff facts. Pricing and commission remain owned
  // by the downstream website-sales lifecycle.
  //
  // ═══ WHY last_call_at IS STAMPED ON EVERY OUTCOME, INCLUDING "no answer" ═══
  //
  // lib/web-leads/claim.ts expires a claim after 7 days with no call logged,
  // and recycles a lost lead after 90. Both rules read fields that, until this
  // change, NOTHING wrote. The result was not a small gap -- it inverted both
  // rules:
  //
  //   - every claimed lead expired on day 7 no matter how hard the rep worked
  //     it, because last_call_at was always null; and
  //   - no lost lead ever recycled, because lost_at was always null and the
  //     rule fails closed toward the prospect who said no.
  //
  // Codex caught it (2026-08-23). It is worth naming the shape: the claim
  // rules were written, tested at exact instants against hand-made facts, and
  // fully green -- while the fields those facts describe were never populated
  // by any code path. Testing a rule in isolation proves the rule, not the
  // system. Verify the contribution, not the presence.
  //
  // "no answer" stamps too, and deliberately: a rep who dials four times and
  // reaches nobody is working that lead, and taking it off them on day 7
  // punishes exactly the persistence this whole funnel depends on.
  const MAX_CONTEXT_ATTEMPTS = 3;

  // Settle the frozen stage decision first. Stage and owner are conditions on
  // the SAME update, so a lifecycle move or transfer that wins the race cannot
  // be overwritten by a late retry.
  let stageSaved = target === null;
  let stageChangedTo: WebsiteSalesStage | null = null;
  for (let attempt = 0; target && attempt < MAX_CONTEXT_ATTEMPTS; attempt += 1) {
    const current = await routingAfterOutcomeSaved(leadId, {
      outcomeSaved: true,
      stageSaved: false,
      leadContextSaved: false,
      touchSaved: false,
      trackingSaved: false,
    });
    if (current.assignedTo !== expectedOwner) {
      throw new CallOutcomeSaveError(
        "ownership_changed",
        { outcomeSaved: true, stageSaved: false, leadContextSaved: false, touchSaved: false, trackingSaved: false },
        "lead_owner_changed_after_call_was_logged",
      );
    }
    if (current.stage !== stageFrom) {
      stageSaved = true;
      break;
    }

    const stagePatch: Record<string, unknown> = { stage: target };
    if (target === "lost") {
      stagePatch.lost_at = calledAt;
      stagePatch.loss_reason = note;
    }
    try {
      await updateRecord({
        tenant_id: WEBDEV_TENANT_ID,
        entity: "lead",
        id: leadId,
        patch: stagePatch,
        ifMatchAll: [
          { field: "stage", value: current.stage },
          { field: "assigned_to", value: expectedOwner },
        ],
      });
      stageSaved = true;
      stageChangedTo = target;
      break;
    } catch (error) {
      if (error instanceof RecordsError && error.code === "conflict") continue;
      throw new CallOutcomeSaveError(
        "lead_update_failed",
        { outcomeSaved: true, stageSaved: false, leadContextSaved: false, touchSaved: false, trackingSaved: false },
        `lead_stage_write_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!stageSaved) {
    throw new CallOutcomeSaveError(
      "lead_update_failed",
      { outcomeSaved: true, stageSaved: false, leadContextSaved: false, touchSaved: false, trackingSaved: false },
      "lead_stage_write_conflict",
    );
  }

  // Touch first. Its monotonic timestamp becomes the CAS token for mutable
  // context. If a newer call lands, an older retry yields instead of replacing
  // the newer disposition/note. No-answer counts because the rep did the work.
  let touchSaved = false;
  try {
    await persistCanonicalLeadTouch(db, {
      tenantId: WEBDEV_TENANT_ID,
      leadId,
      occurredAt: calledAt,
      isCall: true,
      expectedOwnerId: expectedOwner,
    });
    touchSaved = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("record_lead_touch: owner_conflict")) {
      throw new CallOutcomeSaveError(
        "ownership_changed",
        { outcomeSaved: true, stageSaved, leadContextSaved: false, touchSaved: false, trackingSaved: false },
        "lead_owner_changed_before_call_touch_was_saved",
      );
    }
    throw new CallOutcomeSaveError(
      "lead_update_failed",
      { outcomeSaved: true, stageSaved, leadContextSaved: false, touchSaved: false, trackingSaved: false },
      message,
    );
  }

  let leadContextSaved = false;
  for (let attempt = 0; attempt < MAX_CONTEXT_ATTEMPTS; attempt += 1) {
    const current = await routingAfterOutcomeSaved(leadId, {
      outcomeSaved: true,
      stageSaved,
      leadContextSaved: false,
      touchSaved,
      trackingSaved: false,
    });
    if (current.assignedTo !== expectedOwner) {
      throw new CallOutcomeSaveError(
        "ownership_changed",
        { outcomeSaved: true, stageSaved, leadContextSaved: false, touchSaved, trackingSaved: false },
        "lead_owner_changed_before_call_context_was_saved",
      );
    }
    if (outcomeContextSuperseded(current.lastCallAt, calledAt)) {
      leadContextSaved = true;
      break;
    }
    if (!outcomeTouchAlreadyApplied(current.lastCallAt, calledAt)) continue;

    const contextPatch: Record<string, unknown> = {
      last_disposition: outcome,
      ...(note ? { last_handoff_note: note, last_handoff_note_at: calledAt } : {}),
    };
    try {
      await updateRecord({
        tenant_id: WEBDEV_TENANT_ID,
        entity: "lead",
        id: leadId,
        patch: contextPatch,
        ifMatchAll: [
          { field: "last_call_at", value: calledAt },
          { field: "assigned_to", value: expectedOwner },
        ],
      });
      leadContextSaved = true;
      break;
    } catch (error) {
      if (error instanceof RecordsError && error.code === "conflict") continue;
      throw new CallOutcomeSaveError(
        "lead_update_failed",
        { outcomeSaved: true, stageSaved, leadContextSaved: false, touchSaved, trackingSaved: false },
        `lead_context_write_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!leadContextSaved) {
    throw new CallOutcomeSaveError(
      "lead_update_failed",
      { outcomeSaved: true, stageSaved, leadContextSaved: false, touchSaved, trackingSaved: false },
      "lead_context_write_conflict",
    );
  }

  const summary = `Call disposition: ${outcome.replaceAll("_", " ")}.`;
  const content = note ? `${summary}\n\n${note}` : summary;
  let trackingSaved = false;
  try {
    const interaction = await db.from("lead_interactions").upsert({
      tenant_id: WEBDEV_TENANT_ID,
      lead_id: leadId,
      type: "call_disposition",
      channel: "phone",
      direction: "outbound",
      agent_source: "web_leads_outcome",
      actor_user_id: repUserId,
      subject: "Call disposition",
      content,
      content_preview: content.slice(0, 1024),
      disposition: DB_OUTCOME[outcome],
      call_outcome: outcome,
      provider: "web_leads_outcome",
      provider_message_id: requestId,
      created_at: calledAt,
      metadata: {
        request_id: requestId,
        outcome,
        stage_changed: stageChangedTo !== null,
        from: stageChangedTo ? stageFrom : null,
        to: stageChangedTo,
        business_id: businessIdForWrite,
      },
    }, { onConflict: "provider,provider_message_id", ignoreDuplicates: true });
    if (interaction.error) throw new Error(interaction.error.message);
    trackingSaved = true;
  } catch (error) {
    // The append-only outcome and canonical lead patch are already durable,
    // and requestId now makes the retry safe. Fail this request visibly so the
    // client retains that same id and the next attempt repairs the timeline
    // instead of abandoning a closed-loop metric behind a success response.
    console.error("[web-leads.outcome] lead_interactions insert failed after outcome was saved", {
      leadId,
      repUserId,
      outcome,
      stageChangedTo,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new CallOutcomeSaveError(
      "tracking_failed",
      { outcomeSaved: true, stageSaved, leadContextSaved: true, touchSaved: true, trackingSaved: false },
      `timeline_tracking_failed:${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    record: toRecord(stored),
    stageChangedTo,
    trackingWarning: null,
    idempotent,
    saveState: {
      outcomeSaved: true,
      stageSaved,
      leadContextSaved,
      touchSaved,
      trackingSaved,
    },
  };
}

type StoredCallOutcome = {
  id: string;
  request_id: string;
  business_id: string;
  outcome: string;
  notes: string | null;
  rep_user_id: string;
  called_at: string;
  stage_from: string | null;
  stage_to: string | null;
  owner_user_id: string | null;
};

export type CallOutcomeSaveState = {
  outcomeSaved: boolean;
  stageSaved: boolean;
  leadContextSaved: boolean;
  touchSaved: boolean;
  trackingSaved: boolean;
};

/** A retry-safe partial failure: callers may repeat the SAME requestId. */
export class CallOutcomeSaveError extends Error {
  constructor(
    public readonly code: "request_id_conflict" | "resume_failed" | "lead_update_failed" | "tracking_failed" | "ownership_changed",
    public readonly state: CallOutcomeSaveState,
    message: string,
  ) {
    super(message);
    this.name = "CallOutcomeSaveError";
  }
}

async function routingAfterOutcomeSaved(
  leadId: string,
  state: CallOutcomeSaveState,
): ReturnType<typeof leadRoutingInfo> {
  try {
    return await leadRoutingInfo(leadId);
  } catch (error) {
    throw new CallOutcomeSaveError(
      "resume_failed",
      state,
      `lead_resume_read_failed:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function websiteSalesStage(value: string | null): WebsiteSalesStage | null {
  return value && (WEBSITE_SALES_STAGES as readonly string[]).includes(value)
    ? (value as WebsiteSalesStage)
    : null;
}

function sameLogicalOutcome(
  row: StoredCallOutcome,
  expected: { businessId: string; fallbackLeadId: string; repUserId: string; outcome: CallOutcome; note: string | null },
): boolean {
  return (
    (row.business_id === expected.businessId || row.business_id === expected.fallbackLeadId) &&
    row.rep_user_id === expected.repUserId &&
    row.outcome === DB_OUTCOME[expected.outcome] &&
    row.notes === expected.note
  );
}

/**
 * This lead's outcome history, most recent first -- the "recent outcome
 * history" the panel renders after logging. Read-only; there is no
 * corresponding update or delete anywhere in this module.
 */
export async function fetchRecentOutcomes(leadId: string, limit = 20): Promise<CallOutcomeRecord[]> {
  const { businessId } = await leadRoutingInfo(leadId);
  // Calls made before the source-business pointer was backfilled used leadId
  // as their safe fallback. Read both keys so pointer repair never makes that
  // earlier history disappear.
  const keys = Array.from(new Set([businessId, leadId]
    .map((value) => safeFilterValue(value || ""))
    .filter((value): value is string => Boolean(value))));

  const db = getServiceSupabase();
  const { data, error } = await db
    .from("leadgen_call_outcomes")
    .select("id, outcome, notes, rep_user_id, called_at")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .in("business_id", keys)
    .order("called_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`outcome_history_read_failed: ${error.message}`);

  return ((data || []) as { id: string; outcome: string; notes: string | null; rep_user_id: string; called_at: string }[]).map(toRecord);
}
