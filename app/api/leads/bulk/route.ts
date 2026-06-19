/**
 * POST /api/leads/bulk — bulk assign / bulk stage-change for the pipeline board
 * (Adon Batch 2.2 bulk + Batch 6.1 multi). Lets an admin distribute an imported
 * list across agents, or move a batch of leads forward, in one action instead of
 * opening each drawer.
 *
 * Body:
 *   { op: "assign", ids: string[], assigned_to: string | null }
 *   { op: "stage",  ids: string[], stage: string, entity?: "lead" | "application" }
 *
 * Authorization is applied PER id with the SAME owner-or-admin gate as the
 * single-record routes (/assign mirrors /assign's unconditional gate; /stage
 * mirrors /set-stage's flag-aware gate). An admin can act on any record; an agent
 * only on records they own (or any record when LEAD_SCOPING_ENABLED is off, for
 * the stage op). A record the caller can't touch is folded into `skipped` —
 * INDISTINGUISHABLE from a missing record, so the endpoint can't be used to
 * enumerate which UUIDs are real (matches the single routes' 404-for-both).
 * Never errors the whole batch — fail closed.
 *
 * Response: { ok, op, updated, skipped, failed }.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { updateRecord, RecordsError } from "@/lib/manifest/data";
import { canViewLead, leadScopingEnabled } from "@/lib/lead-scope";
import { LEAD_PIPELINE_STAGES, OPPORTUNITY_PIPELINE_STAGES } from "@/lib/sunbiz-stage-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 200;

type Outcome = { updated: number; skipped: number; failed: number };

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenantId = sess.tenantId;

  let body: { op?: unknown; ids?: unknown; assigned_to?: unknown; stage?: unknown; entity?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const op = body.op === "assign" || body.op === "stage" ? body.op : null;
  if (!op) {
    return NextResponse.json({ ok: false, error: "invalid_op" }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? Array.from(new Set(body.ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x))))
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: "no_valid_ids" }, { status: 400 });
  }
  if (ids.length > MAX_IDS) {
    return NextResponse.json({ ok: false, error: "too_many_ids", max: MAX_IDS }, { status: 400 });
  }

  const db = getServiceSupabase();
  const out: Outcome = { updated: 0, skipped: 0, failed: 0 };

  if (op === "assign") {
    // Validate the assignee once (null = clear). A non-UUID is a 400; a UUID that
    // isn't a member of this tenant is rejected before we touch any record.
    const raw = body.assigned_to;
    let nextAssignedTo: string | null = null;
    if (typeof raw === "string" && raw.trim().length) {
      const candidate = raw.trim().toLowerCase();
      if (!UUID_RE.test(candidate)) {
        return NextResponse.json({ ok: false, error: "invalid_assigned_to" }, { status: 400 });
      }
      nextAssignedTo = candidate;
    }
    if (nextAssignedTo) {
      const member = await db
        .from("user_profiles")
        .select("auth_user_id")
        .eq("tenant_id", tenantId)
        .eq("auth_user_id", nextAssignedTo)
        .maybeSingle();
      if (!member.data) {
        return NextResponse.json({ ok: false, error: "not_a_tenant_member" }, { status: 400 });
      }
    }

    for (const id of ids) {
      const existing = await db
        .from("tenant_records")
        .select("id, entity_type, data")
        .eq("tenant_id", tenantId)
        .in("entity_type", ["lead", "application", "funded_deal", "renewal"])
        .eq("id", id)
        .maybeSingle();
      if (!existing.data) {
        out.skipped += 1;
        continue;
      }
      const data = (existing.data as { data?: Record<string, unknown> }).data || {};
      const currentOwner =
        typeof data.assigned_to === "string" ? (data.assigned_to as string).toLowerCase() : null;
      // Owner-or-admin gate — identical to /assign (unconditional). Agent can only
      // reassign a lead they own. A non-owner outcome folds into `skipped` so it's
      // indistinguishable from a missing record (no enumeration oracle).
      if (!sess.isAdmin && currentOwner !== (sess.userId || "").toLowerCase()) {
        out.skipped += 1;
        continue;
      }
      const upd = await db.rpc("patch_tenant_record_data", {
        p_id: id,
        p_tenant_id: tenantId,
        p_patch: { assigned_to: nextAssignedTo },
      });
      if (upd.error) {
        out.failed += 1;
        continue;
      }
      out.updated += 1;
      try {
        const note = nextAssignedTo
          ? `Reassigned to ${nextAssignedTo} by ${sess.email || "an admin"} (bulk).`
          : `Assignment cleared by ${sess.email || "an admin"} (bulk).`;
        await db.from("lead_interactions").insert({
          tenant_id: tenantId,
          lead_id: id,
          type: "lead_reassigned",
          channel: "system",
          direction: "outbound",
          agent_source: "dashboard_bulk_assign",
          subject: "Lead reassigned",
          content: note,
          content_preview: note,
          metadata: {
            assigned_to: nextAssignedTo,
            assigned_by: sess.userId,
            entity_type: (existing.data as { entity_type?: string }).entity_type,
            bulk: true,
          },
        });
      } catch {
        /* best-effort audit */
      }
    }
    return NextResponse.json({ ok: true, op, ...out });
  }

  // op === "stage"
  const entity = body.entity === "application" ? "application" : "lead";
  const stage = typeof body.stage === "string" ? body.stage.trim() : "";
  const validStages = entity === "application" ? OPPORTUNITY_PIPELINE_STAGES : LEAD_PIPELINE_STAGES;
  if (!stage || !validStages.some((s) => s.key === stage)) {
    return NextResponse.json({ ok: false, error: "invalid_stage" }, { status: 400 });
  }
  const field = entity === "application" ? "status" : "stage";

  for (const id of ids) {
    const existing = await db
      .from("tenant_records")
      .select("id, entity_type, data")
      .eq("tenant_id", tenantId)
      .eq("entity_type", entity)
      .eq("id", id)
      .maybeSingle();
    if (!existing.data) {
      out.skipped += 1;
      continue;
    }
    const data = (existing.data as { data?: Record<string, unknown> }).data || {};
    // Flag-aware owner-or-admin gate, IDENTICAL to /set-stage (Codex 2026-06-19
    // LOW-5): scoping OFF → any tenant member; ON → owner-or-admin. A no-access
    // outcome folds into `skipped` (no enumeration oracle).
    if (!canViewLead({ isAdmin: sess.isAdmin, userId: sess.userId }, data, leadScopingEnabled())) {
      out.skipped += 1;
      continue;
    }
    if (typeof data[field] === "string" && data[field] === stage) {
      out.skipped += 1; // already on this stage
      continue;
    }
    try {
      await updateRecord({ tenant_id: tenantId, entity, id, patch: { [field]: stage } });
    } catch (err) {
      void (err instanceof RecordsError ? err.code : "unknown");
      out.failed += 1;
      continue;
    }
    out.updated += 1;
    try {
      const note = `Stage set to ${stage} (bulk)`;
      await db.from("lead_interactions").insert({
        tenant_id: tenantId,
        lead_id: id,
        type: "stage_changed",
        channel: "system",
        direction: "outbound",
        agent_source: "dashboard_bulk_set_stage",
        subject: "Stage changed",
        content: note,
        content_preview: note,
        metadata: { to: stage, field, entity, changed_by: sess.userId, bulk: true },
      });
    } catch {
      /* best-effort audit */
    }
  }
  return NextResponse.json({ ok: true, op, ...out });
}
