/**
 * /api/call-appointments — lead-centric call scheduling (database/117).
 *
 * Distinct from /api/conversations/schedule-call + scheduled_calls
 * (database/115), which is the Conversations inbox's generic thread-scoped
 * "request a call" reminder. This backs the Calls tab's per-lead CALL SHEET:
 * schedule a call against a specific lead (from the lead board / drawer),
 * then the call sheet surfaces that lead's notes + MCA/underwriting summary
 * so the rep has everything during the call.
 *
 *   POST — create an appointment against a lead/application. Body:
 *     { leadId, entity?, scheduledFor (ISO), preCallNote?, assignedTo? }.
 *     Authorizes the lead via getWritableLead (CRM-write role tier — any
 *     non-read_only tenant member may schedule a call on any lead in their
 *     tenant, same tier as set-stage/promote).
 *
 *   GET — list the CURRENT user's appointments (assigned_to = me OR
 *     created_by = me), tenant-scoped, status != 'cancelled' by default,
 *     ordered by scheduled_for asc. Enriched with each lead's basic info
 *     (business_name, contact_name, phone, stage) pulled from tenant_records
 *     in one batched query so the list renders without N+1 lookups.
 *
 * Auth: resolveSessionContext (session -> tenant). Fail closed throughout —
 * an auth/db error never falls through to "show everything."
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getWritableLead } from "@/lib/lead-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE_LENGTH = 4000;
// Clock-skew grace — mirrors CallSchedulerModal's 15s floor, widened slightly
// since this is a plain datetime-local input (no "book now" preset).
const PAST_GRACE_MS = 5 * 60_000;

type AppointmentRow = {
  id: string;
  tenant_id: string;
  lead_id: string;
  entity_type: string;
  scheduled_for: string;
  assigned_to: string | null;
  status: string;
  pre_call_note: string | null;
  outcome_note: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function isValidFutureIso(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() < Date.now() - PAST_GRACE_MS) return null;
  return d;
}

function boundedNote(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_NOTE_LENGTH);
}

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }

  let body: {
    leadId?: unknown;
    entity?: unknown;
    scheduledFor?: unknown;
    preCallNote?: unknown;
    assignedTo?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const leadId = typeof body.leadId === "string" ? body.leadId : "";
  if (!UUID_RE.test(leadId)) {
    return NextResponse.json({ ok: false, error: "invalid_lead_id" }, { status: 400 });
  }
  const entity: "lead" | "application" = body.entity === "application" ? "application" : "lead";

  const scheduledFor = isValidFutureIso(body.scheduledFor);
  if (!scheduledFor) {
    return NextResponse.json(
      { ok: false, error: "invalid_scheduled_for", message: "scheduledFor must be a valid ISO time not far in the past." },
      { status: 400 },
    );
  }

  const assignedToRaw = typeof body.assignedTo === "string" ? body.assignedTo : "";
  if (assignedToRaw && !UUID_RE.test(assignedToRaw)) {
    return NextResponse.json({ ok: false, error: "invalid_assigned_to" }, { status: 400 });
  }

  const preCallNote = boundedNote(body.preCallNote);

  // Role + tenant + record authorization in one call — any non-read_only
  // tenant member may schedule a call on any lead/application in their
  // tenant (CRM-write tier, same as set-stage/promote). Fails closed on an
  // unrecognized/null role (getWritableLead -> canWriteCrm allowlist).
  const acc = await getWritableLead(
    { teamRole: sess.teamRole, userId: sess.userId, isOwner: sess.isTrueAdmin, adminAccess: sess.adminAccess },
    { tenantId: sess.tenantId, entity, id: leadId },
  );
  if (!acc.ok) {
    return acc.reason === "role_denied"
      ? NextResponse.json(
          { ok: false, error: "forbidden_role", message: "Read-only members can't schedule calls." },
          { status: 403 },
        )
      : NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const db = getServiceSupabase();
  const ins = await db
    .from("call_appointments")
    .insert({
      tenant_id: sess.tenantId,
      lead_id: leadId,
      entity_type: entity,
      scheduled_for: scheduledFor.toISOString(),
      assigned_to: assignedToRaw || sess.userId,
      pre_call_note: preCallNote,
      created_by: sess.userId,
    })
    .select("*")
    .single();
  if (ins.error) {
    return NextResponse.json({ ok: false, error: "insert_failed", message: ins.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, appointment: ins.data as AppointmentRow });
}

export async function GET(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }

  const includeCancelled = req.nextUrl.searchParams.get("include_cancelled") === "1";

  const db = getServiceSupabase();
  let q = db
    .from("call_appointments")
    .select("*")
    .eq("tenant_id", sess.tenantId)
    .or(`assigned_to.eq.${sess.userId},created_by.eq.${sess.userId}`)
    .order("scheduled_for", { ascending: true });
  if (!includeCancelled) q = q.neq("status", "cancelled");

  const r = await q;
  if (r.error) {
    return NextResponse.json({ ok: false, error: "query_failed", message: r.error.message }, { status: 500 });
  }
  const rows = (r.data || []) as AppointmentRow[];

  // Batch-enrich with each lead's basic info from tenant_records — one round
  // trip instead of N, so the list renders without a waterfall of per-row
  // detail fetches (same rationale as /api/leads/[id]/detail's parallel
  // docs+application fetch).
  const leadIds = Array.from(new Set(rows.map((row) => row.lead_id)));
  const leadMap = new Map<string, { business_name: string | null; contact_name: string | null; phone: string | null; stage: string | null }>();
  if (leadIds.length) {
    const recs = await db
      .from("tenant_records")
      .select("id, entity_type, data")
      .eq("tenant_id", sess.tenantId)
      .in("id", leadIds);
    if (!recs.error) {
      for (const rec of (recs.data || []) as Array<{ id: string; entity_type: string; data: Record<string, unknown> }>) {
        const d = rec.data || {};
        const stageField = rec.entity_type === "application" ? "status" : "stage";
        // BOTH SPELLINGS. SunBiz leads store these as business_name /
        // contact_name; OASIS leads store them as company / name, because that
        // is what its lead entity declares. Reading only the SunBiz pair left
        // the call sheet blank for every OASIS lead — a rep about to dial with
        // no name on screen. Same fallback the drip tracker already uses.
        const str = (...keys: string[]) => {
          for (const k of keys) if (typeof d[k] === "string" && d[k]) return d[k] as string;
          return null;
        };
        leadMap.set(rec.id, {
          business_name: str("business_name", "company"),
          contact_name: str("contact_name", "name", "full_name"),
          phone: typeof d.phone === "string" ? d.phone : null,
          stage: typeof d[stageField] === "string" ? (d[stageField] as string) : null,
        });
      }
    }
  }

  const appointments = rows.map((row) => ({
    ...row,
    lead: leadMap.get(row.lead_id) || null,
  }));

  return NextResponse.json({ ok: true, appointments });
}
