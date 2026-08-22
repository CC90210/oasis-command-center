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
 * read and write here pins WEBDEV_TENANT_ID explicitly. This module does not
 * re-derive viewer authorization -- callers pass in a `lead` already
 * resolved by fetchLead(id, viewer) for that same id, same convention
 * fetchAudit() uses, so authorization happens exactly once per request.
 *
 * THE REAL leadgen_call_outcomes SCHEMA (verified against
 * services/leadgen/migrations/003_territories.sql in JARVIS, not assumed --
 * the table exists and is empty, so there was nothing live to introspect):
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
import { getServiceSupabase } from "@/lib/supabase-server";
import { updateRecord } from "@/lib/manifest/data";
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
 * and the commission model built on top of it. We asked Bravo (agent_activity
 * row 5daa4bd1, 2026-08-21) for the supported way to advance a stage from
 * here and have not received a usable answer, so this function is
 * DELIBERATELY restricted to the early funnel only. It must NEVER produce
 * `qualified`, `founder_meeting_booked`, `proposal_sent`, `won`,
 * `onboarding`, `in_build`, `client_review`, `launched`, or anything else
 * downstream -- those are CC's to move, and commission accrual and stage
 * hooks key off them. This function's return type is a plain union of
 * `"connected" | "lost" | null`, not a search over the full stage list, so
 * "no stage beyond these two can ever be produced" holds by construction,
 * not by a runtime check that could later be loosened. This is pending CC's
 * answer -- once it lands, THIS function is what gets replaced, not its
 * callers.
 *
 * FORWARD ONLY, AND ONLY WITHIN OUR ZONE. A lead's position is looked up in
 * WEBSITE_SALES_STAGES and compared against `connected`'s position: anything
 * AT OR BEYOND `connected` (including `connected` itself, and everything
 * CC's engine has since moved it to) returns null unconditionally, whatever
 * the outcome -- so this can never regress a lead CC has already advanced,
 * and never touches a lead outside the early funnel this build owns. An
 * unrecognized current stage (null, or a value not in WEBSITE_SALES_STAGES)
 * fails the same way: never guess-advance a stage this function cannot
 * place.
 *
 * Within that zone: `no_answer` never advances anything. `connected` and
 * `interested` both land on `connected` -- the qualification call is CC's
 * to make, not ours. `not_interested` lands on `lost`.
 *
 * PURE -- no I/O, so this is fully testable without a DB. See
 * tests/web-leads-outcome.test.ts.
 */
export function nextStage(current: string | null | undefined, outcome: CallOutcome): WebsiteSalesStage | null {
  if (outcome === "no_answer") return null;

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

const MAX_NOTE_LENGTH = 4000;

function boundedNote(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_NOTE_LENGTH);
}

/**
 * The `leadgen_businesses.id` this lead was promoted from, and its CURRENT
 * `stage`, read off the same tenant_records row in one query. Mirrors
 * businessIdForLead in audit.ts (see this module's header, and that one's,
 * for why the lead id is not the business id) -- a plain read of two more
 * columns on a row the caller has already established is visible to this
 * viewer, not a second authorization check.
 */
async function leadRoutingInfo(id: string): Promise<{ businessId: string | null; stage: string | null }> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("tenant_records")
    .select("data")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`lead_data_read_failed: ${error.message}`);
  if (!data) return { businessId: null, stage: null };
  const row = data as { data: Record<string, unknown> };
  const businessId = row.data?.webdev_source_business_id;
  const stage = row.data?.stage;
  return {
    businessId: typeof businessId === "string" && businessId.trim() ? businessId.trim() : null,
    stage: typeof stage === "string" && stage.trim() ? stage.trim() : null,
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
 * Never writes anything to tenant_records except `data.stage` -- no
 * pricing, commission, or other lifecycle field. See nextStage()'s doc
 * comment for the full constraint.
 */
export async function logCallOutcome(input: {
  leadId: string;
  lead: WebLead;
  outcome: CallOutcome;
  note?: unknown;
  repUserId: string;
}): Promise<{ record: CallOutcomeRecord; stageChangedTo: WebsiteSalesStage | null }> {
  const { leadId, lead, outcome, repUserId } = input;
  const note = boundedNote(input.note);

  const { businessId, stage } = await leadRoutingInfo(leadId);
  // See the module header: a missing business_id pointer must not make a
  // real phone call unloggable, so this falls back to the lead's own id.
  const businessIdForWrite = safeFilterValue(businessId || leadId) || leadId;

  const nowIso = new Date().toISOString();
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
      created_at: nowIso,
    })
    .select("id, outcome, notes, rep_user_id, called_at")
    .single();
  if (ins.error) throw new Error(`outcome_insert_failed: ${ins.error.message}`);

  // THE CONSTRAINED PART -- see nextStage()'s doc comment above. This is the
  // ONLY tenant_records write in this module, and it only ever touches
  // `data.stage`, and only to "connected" or "lost".
  const target = nextStage(stage, outcome);
  if (target) {
    await updateRecord({
      tenant_id: WEBDEV_TENANT_ID,
      entity: "lead",
      id: leadId,
      patch: { stage: target },
    });
  }

  return {
    record: toRecord(ins.data as { id: string; outcome: string; notes: string | null; rep_user_id: string; called_at: string }),
    stageChangedTo: target,
  };
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
    .select("id, outcome, notes, rep_user_id, called_at")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("business_id", key)
    .order("called_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`outcome_history_read_failed: ${error.message}`);

  return ((data || []) as { id: string; outcome: string; notes: string | null; rep_user_id: string; called_at: string }[]).map(toRecord);
}
