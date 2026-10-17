import type { SupabaseClient } from "@supabase/supabase-js";
import { logTenantAudit } from "@/lib/audit/activity-feed";
import { cancelPendingApproval } from "@/lib/os/approvals/store";
import { getTursoClient } from "@/lib/turso";

type DbError = { message: string; code?: string };
type DbResult<T> = { data: T | null; error: DbError | null; count: number | null };
type IdRow = { id: string };
type LeadRow = { id: string; data: Record<string, unknown> | string | null };
type InteractionRow = { id: string; metadata: Record<string, unknown> | string | null };
type DeletePlan = {
  blockers: [];
  cancel: Record<string, number>;
  unlink: Record<string, number>;
  delete: Record<string, number>;
};

export type DeletePipelineLeadResult =
  | { ok: true; dryRun: boolean; plan: DeletePlan }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "blocked"; blockers: string[] }
  | { ok: false; code: "unavailable"; message: string };

const PROTECTED_STAGES = new Set(["won", "onboarding", "in_build", "client_review", "launched"]);
const UNLINK_TARGETS = [
  ["offer_funnel_events", "lead_id"],
  ["objection_event", "lead_record_id"],
  ["leadgen_businesses", "crm_record_id"],
  ["cold_leads", "promoted_lead_id"],
  ["calendar_events", "lead_id"],
] as const;
const DELETE_TARGETS = [
  ["form_submissions", "lead_id"],
  ["form_views", "lead_id"],
  ["offer_funnel_visit_leads", "lead_id"],
  ["clair_reports", "lead_id"],
  ["phone_lookup_jobs", "lead_id"],
  ["leadgen_recheck_requests", "lead_id"],
  ["leadgen_presence_requests", "lead_id"],
  ["daily_plan_items", "lead_id"],
] as const;
const SUNBIZ_LINKS = [
  ["esign_envelopes", ["lead_id"]],
  ["application_signing_requests", ["lead_id"]],
  ["funded_deals", ["lender_id"]],
  ["document_extraction_jobs", ["lead_id"]],
  ["merchant_background_checks", ["lead_id"]],
  ["renewal_outreach_events", ["lead_id", "lender_id"]],
  ["sunbiz_conversation_state", ["lead_id"]],
  ["sunbiz_reply_drafts", ["lead_id"]],
  ["scrub_candidates", ["created_lead_id"]],
] as const;

class Unavailable extends Error {
  constructor(context: string, detail?: string) {
    super(context + (detail ? ": " + detail : ""));
  }
}

async function resultOf<T>(query: PromiseLike<unknown>): Promise<DbResult<T>> {
  return (await query) as DbResult<T>;
}

/**
 * A lookup on a table that may not exist (retired and SunBiz tables, an older
 * database): a missing TABLE reads as no rows. A missing COLUMN never does: it
 * is a wrong name, and reading it as zero would let a blocker pass or leave a
 * queued send uncancelled (verified against the live schema 2026-10-17, every
 * table and column here exists). It fails closed instead.
 */
async function optional<T>(query: PromiseLike<unknown>, context: string): Promise<DbResult<T> | null> {
  const result = await resultOf<T>(query);
  if (!result.error) return result;
  if (missingTable(result.error)) return null;
  throw new Unavailable(context, result.error.message);
}

async function required<T>(query: PromiseLike<unknown>, context: string): Promise<DbResult<T>> {
  const result = await resultOf<T>(query);
  if (result.error) throw new Unavailable(context, result.error.message);
  return result;
}

function rows<T>(result: DbResult<T[]> | null): T[] {
  return result?.data ?? [];
}

function count(result: DbResult<unknown> | null): number {
  if (!result) return 0;
  if (typeof result.count === "number") return result.count;
  return Array.isArray(result.data) ? result.data.length : 0;
}

/** A JSON column read as a plain object: an object as is, a JSON string parsed, anything else {}. */
function objectOf(value: Record<string, unknown> | string | null): Record<string, unknown> {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** strict: the table must exist (a blocker on live money or booking data never reads "missing" as "none"). */
async function countLink(
  db: SupabaseClient,
  table: string,
  column: string,
  tenantId: string,
  leadId: string,
  strict = false,
): Promise<number> {
  const query = db.from(table).select(column, { count: "exact", head: true })
    .eq("tenant_id", tenantId).eq(column, leadId);
  return count(strict ? await required<IdRow[]>(query, "checking " + table) : await optional<IdRow[]>(query, "checking " + table));
}

async function linkedRows<T>(
  db: SupabaseClient,
  table: string,
  selection: string,
  column: string,
  tenantId: string,
  leadId: string,
  strict = false,
): Promise<T[]> {
  const query = db.from(table).select(selection).eq("tenant_id", tenantId).eq(column, leadId);
  return rows(strict ? await required<T[]>(query, "checking " + table) : await optional<T[]>(query, "checking " + table));
}

async function updateLink(
  db: SupabaseClient,
  table: string,
  column: string,
  tenantId: string,
  leadId: string,
  patch: Record<string, unknown>,
): Promise<number> {
  return count(await optional<unknown[]>(
    db.from(table).update(patch, { count: "exact" })
      .eq("tenant_id", tenantId).eq(column, leadId),
    "updating " + table,
  ));
}

async function countStatus(
  db: SupabaseClient,
  table: string,
  tenantId: string,
  leadId: string,
  statuses: string[],
): Promise<number> {
  return count(await optional<IdRow[]>(
    db.from(table).select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).eq("lead_id", leadId).in("status", statuses),
    "checking " + table,
  ));
}

async function cancelStatus(
  db: SupabaseClient,
  table: string,
  tenantId: string,
  leadId: string,
  statuses: string[],
  nextStatus: string,
): Promise<number> {
  return count(await optional<unknown[]>(
    db.from(table).update({ status: nextStatus }, { count: "exact" })
      .eq("tenant_id", tenantId).eq("lead_id", leadId).in("status", statuses),
    "cancelling " + table,
  ));
}

async function appointmentIds(db: SupabaseClient, tenantId: string, leadId: string): Promise<string[]> {
  return (await linkedRows<IdRow>(db, "call_appointments", "id", "lead_id", tenantId, leadId))
    .map((row) => row.id);
}

async function meetingNotifications(
  db: SupabaseClient,
  tenantId: string,
  leadId: string,
  mutate: boolean,
): Promise<number> {
  const ids = await appointmentIds(db, tenantId, leadId);
  if (!ids.length) return 0;
  const query = mutate
    ? db.from("website_sales_meeting_notifications").update({ status: "cancelled" }, { count: "exact" })
    : db.from("website_sales_meeting_notifications").select("id", { count: "exact", head: true });
  return count(await optional<unknown[]>(
    query.eq("tenant_id", tenantId).in("appointment_id", ids).in("status", ["pending", "sending"]),
    (mutate ? "cancelling" : "checking") + " website sales meeting notifications",
  ));
}

async function approvalRows(db: SupabaseClient, tenantId: string, leadId: string): Promise<IdRow[]> {
  return rows(await optional<IdRow[]>(
    db.from("approvals").select("id").eq("tenant_id", tenantId)
      .eq("status", "pending").eq("payload_json->>lead_id", leadId),
    "checking pending approvals",
  ));
}

async function queuedInteractions(
  db: SupabaseClient,
  tenantId: string,
  leadId: string,
): Promise<InteractionRow[]> {
  return rows(await optional<InteractionRow[]>(
    db.from("lead_interactions").select("id, metadata")
      .eq("tenant_id", tenantId).eq("lead_id", leadId).eq("channel", "email")
      .eq("metadata->>status", "queued"),
    "checking queued lead interactions",
  ));
}

async function blockersFor(
  db: SupabaseClient,
  tenantId: string,
  leadId: string,
  lead: LeadRow,
): Promise<string[]> {
  const blockers: string[] = [];
  // The live tables below must exist: these are the rows a delete would take
  // with it (website_deals, onboarding and payment receipts CASCADE from
  // tenant_records in production) or must never be orphaned. A missing one
  // fails the whole delete closed. Only retired and SunBiz tables are optional.
  const appointments = rows(await required<Array<{ scheduled_for: string }>>(
    db.from("call_appointments").select("scheduled_for")
      .eq("tenant_id", tenantId).eq("lead_id", leadId)
      .eq("status", "scheduled").eq("workflow_status", "active")
      .gt("scheduled_for", new Date().toISOString()),
    "checking booked calls",
  ));
  for (const appointment of appointments) {
    blockers.push("This lead has a booked call on " + appointment.scheduled_for + ". Cancel the call first, then delete.");
  }

  const documents = rows(await required<IdRow[]>(
    db.from("lead_documents").select("id").eq("tenant_id", tenantId)
      .eq("lead_id", leadId).is("metadata->>deleted_at", null),
    "checking lead documents",
  ));
  if (documents.length) blockers.push("This lead has documents. Delete the documents first, then delete the lead.");

  const [liveDeals, retiredDeals] = await Promise.all([
    linkedRows<IdRow>(db, "website_deals", "id", "lead_id", tenantId, leadId, true),
    linkedRows<IdRow>(db, "website_deals_v2_retired", "id", "lead_id", tenantId, leadId),
  ]);
  if (liveDeals.length + retiredDeals.length) {
    blockers.push("This lead has a website deal. A lead with financial history cannot be deleted.");
  }

  const onboarding =
    await countLink(db, "website_onboarding", "lead_id", tenantId, leadId, true) +
    await countLink(db, "website_onboarding_v2_retired", "lead_id", tenantId, leadId);
  if (onboarding) blockers.push("This lead has website onboarding work. Keep the lead with its delivery history.");

  const receipts =
    await countLink(db, "website_sales_payment_receipts", "lead_id", tenantId, leadId, true) +
    await countLink(db, "website_sales_payment_receipts_v1_retired", "lead_id", tenantId, leadId);
  if (receipts) blockers.push("This lead has a payment receipt. Leads with payment records cannot be deleted.");

  let commissions = 0;
  if (liveDeals.length) {
    commissions += count(await required<IdRow[]>(
      db.from("website_sales_commissions").select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId).in("deal_id", liveDeals.map((row) => row.id)),
      "checking website sales commissions",
    ));
  }
  if (retiredDeals.length) {
    commissions += count(await optional<IdRow[]>(
      db.from("website_sales_commissions_v2_retired").select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId).in("deal_id", retiredDeals.map((row) => row.id)),
      "checking retired website sales commissions",
    ));
  }
  if (commissions) blockers.push("This lead has a sales commission. Leads tied to compensation cannot be deleted.");

  const stage = String(objectOf(lead.data).stage ?? "").trim().toLowerCase();
  if (PROTECTED_STAGES.has(stage)) {
    blockers.push("This lead is at the " + stage.replace(/_/g, " ") + " stage. Won and delivery-stage leads cannot be deleted.");
  }

  const ordinary = [
    ["customers", "source_lead_id", "This lead has been converted to a customer. Keep the lead with the customer history."],
    ["delivery_projects", "lead_id", "This lead has a delivery project. Keep the lead with the project history."],
    ["client_automation_profiles", "lead_id", "This lead has a client automation profile. Keep the lead with the client setup."],
  ] as const;
  for (const [table, column, message] of ordinary) {
    if (await countLink(db, table, column, tenantId, leadId, true)) blockers.push(message);
  }

  for (const [table, columns] of SUNBIZ_LINKS) {
    let linked = false;
    for (const column of columns) {
      if (await countLink(db, table, column, tenantId, leadId)) linked = true;
    }
    if (linked) {
      blockers.push("This lead is linked to SunBiz lending history in " + table.replace(/_/g, " ") + ". Keep the lead with that history.");
    }
  }

  const approved = await required<IdRow[]>(
    db.from("approvals").select("id").eq("tenant_id", tenantId)
      .in("status", ["approved", "executing"]).is("executed_at", null)
      .eq("payload_json->>lead_id", leadId),
    "checking approved actions",
  );
  if (count(approved)) {
    blockers.push("This lead has an approved action that has not run yet. Let it finish or cancel it first, then delete.");
  }
  return blockers;
}

async function planFor(db: SupabaseClient, tenantId: string, leadId: string): Promise<DeletePlan> {
  const cancel: Record<string, number> = {
    drip_runs: await countStatus(db, "drip_runs", tenantId, leadId, ["scheduled"]),
    scheduled_sends: await countStatus(db, "scheduled_sends", tenantId, leadId, ["pending"]),
    scheduled_calls: await countStatus(db, "scheduled_calls", tenantId, leadId, ["pending"]),
    website_sales_meeting_notifications: await meetingNotifications(db, tenantId, leadId, false),
    lead_interactions: (await queuedInteractions(db, tenantId, leadId)).length,
    approvals: (await approvalRows(db, tenantId, leadId)).length,
    sms_agent_jobs: await countStatus(db, "sms_agent_jobs", tenantId, leadId, ["pending"]),
  };
  const unlink: Record<string, number> = {};
  for (const [table, column] of UNLINK_TARGETS) {
    unlink[table] = await countLink(db, table, column, tenantId, leadId);
  }
  unlink.sms_agent_conversations = await countLink(db, "sms_agent_conversations", "lead_id", tenantId, leadId);
  const remove: Record<string, number> = {};
  for (const [table, column] of DELETE_TARGETS) {
    remove[table] = await countLink(db, table, column, tenantId, leadId);
  }
  return { blockers: [], cancel, unlink, delete: remove };
}

async function cancelInteractionRows(db: SupabaseClient, tenantId: string, leadId: string): Promise<number> {
  let changed = 0;
  for (const row of await queuedInteractions(db, tenantId, leadId)) {
    const metadata = { ...objectOf(row.metadata), status: "cancelled", cancelled_reason: "lead_deleted" };
    changed += count(await optional<unknown[]>(
      db.from("lead_interactions").update({ metadata }, { count: "exact" })
        .eq("tenant_id", tenantId).eq("lead_id", leadId).eq("id", row.id)
        .eq("channel", "email").eq("metadata->>status", "queued"),
      "cancelling a queued lead interaction",
    ));
  }
  return changed;
}

async function cancelApprovals(
  db: SupabaseClient,
  tenantId: string,
  leadId: string,
  actorUserId: string,
): Promise<number> {
  const pending = await approvalRows(db, tenantId, leadId);
  if (!pending.length) return 0;
  const raw = getTursoClient();
  let changed = 0;
  for (const row of pending) {
    if (await cancelPendingApproval(
      raw,
      tenantId,
      row.id,
      { type: "user", id: actorUserId },
      { reason: "lead_deleted", lead_id: leadId },
      new Date(),
    )) changed += 1;
  }
  return changed;
}

function missingTable(error: DbError): boolean {
  return ["42P01", "PGRST205"].includes(error.code || "") ||
    /no such table|could not find the table/i.test(error.message);
}

function missingColumn(error: DbError): boolean {
  return ["42703", "PGRST204"].includes(error.code || "") || /no such column|could not find the column/i.test(error.message);
}

async function cancelSmsJobs(db: SupabaseClient, tenantId: string, leadId: string): Promise<number> {
  for (const errorColumn of ["last_error", "error", "reason", null] as const) {
    const patch: Record<string, unknown> = { status: "dead_letter" };
    if (errorColumn) patch[errorColumn] = "lead_deleted";
    const result = await resultOf<unknown[]>(
      db.from("sms_agent_jobs").update(patch, { count: "exact" })
        .eq("tenant_id", tenantId).eq("lead_id", leadId).eq("status", "pending"),
    );
    if (!result.error) return count(result);
    if (missingTable(result.error)) return 0;
    if (errorColumn && missingColumn(result.error)) continue;
    throw new Unavailable("cancelling SMS agent jobs", result.error.message);
  }
  return 0;
}

async function unlinkSms(db: SupabaseClient, tenantId: string, leadId: string): Promise<number> {
  const result = await resultOf<unknown[]>(
    db.from("sms_agent_conversations").update({ lead_id: null, state: "closed" }, { count: "exact" })
      .eq("tenant_id", tenantId).eq("lead_id", leadId),
  );
  if (!result.error) return count(result);
  if (missingTable(result.error)) return 0;
  if (!missingColumn(result.error)) throw new Unavailable("unlinking SMS conversations", result.error.message);
  return updateLink(db, "sms_agent_conversations", "lead_id", tenantId, leadId, { lead_id: null });
}

async function deleteLinks(
  db: SupabaseClient,
  tenantId: string,
  leadId: string,
): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  for (const [table, column] of DELETE_TARGETS) {
    removed[table] = count(await optional<unknown[]>(
      db.from(table).delete({ count: "exact" }).eq("tenant_id", tenantId).eq(column, leadId),
      "deleting " + table,
    ));
  }
  return removed;
}

export async function deletePipelineLead(
  db: SupabaseClient,
  input: { tenantId: string; leadId: string; actorUserId: string; dryRun: boolean },
): Promise<DeletePipelineLeadResult> {
  try {
    const found = await required<LeadRow>(
      db.from("tenant_records").select("id, data")
        .eq("tenant_id", input.tenantId).eq("id", input.leadId)
        .eq("entity_type", "lead").maybeSingle(),
      "loading the lead",
    );
    if (!found.data) return { ok: false, code: "not_found" };

    const blockers = await blockersFor(db, input.tenantId, input.leadId, found.data);
    if (blockers.length) return { ok: false, code: "blocked", blockers };
    if (input.dryRun) {
      return { ok: true, dryRun: true, plan: await planFor(db, input.tenantId, input.leadId) };
    }

    const cancel: Record<string, number> = {
      drip_runs: await cancelStatus(db, "drip_runs", input.tenantId, input.leadId, ["scheduled"], "cancelled"),
      scheduled_sends: await cancelStatus(db, "scheduled_sends", input.tenantId, input.leadId, ["pending"], "cancelled"),
      scheduled_calls: await cancelStatus(db, "scheduled_calls", input.tenantId, input.leadId, ["pending"], "cancelled"),
      website_sales_meeting_notifications: await meetingNotifications(db, input.tenantId, input.leadId, true),
      lead_interactions: await cancelInteractionRows(db, input.tenantId, input.leadId),
      approvals: await cancelApprovals(db, input.tenantId, input.leadId, input.actorUserId),
      sms_agent_jobs: await cancelSmsJobs(db, input.tenantId, input.leadId),
    };

    const unlink: Record<string, number> = {};
    for (const [table, column] of UNLINK_TARGETS) {
      unlink[table] = await updateLink(db, table, column, input.tenantId, input.leadId, { [column]: null });
    }
    unlink.sms_agent_conversations = await unlinkSms(db, input.tenantId, input.leadId);
    const removed = await deleteLinks(db, input.tenantId, input.leadId);

    const finalBlockers = await blockersFor(db, input.tenantId, input.leadId, found.data);
    if (finalBlockers.length) return { ok: false, code: "blocked", blockers: finalBlockers };

    const deleted = await required<unknown[]>(
      db.from("tenant_records").delete({ count: "exact" })
        .eq("tenant_id", input.tenantId).eq("id", input.leadId).eq("entity_type", "lead"),
      "deleting the lead",
    );
    if (deleted.count !== 1) {
      throw new Unavailable("deleting the lead", "expected one row, deleted " + (deleted.count ?? 0));
    }

    const plan: DeletePlan = { blockers: [], cancel, unlink, delete: removed };
    await logTenantAudit({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      actionType: "pipeline_lead_deleted",
      targetTable: "tenant_records",
      targetId: input.leadId,
      after: { cancel, unlink, delete: removed },
    });
    return { ok: true, dryRun: false, plan };
  } catch (error) {
    console.error("[pipeline.delete-lead]", error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      code: "unavailable",
      message: "This lead could not be deleted safely. Reload the pipeline before trying again.",
    };
  }
}
