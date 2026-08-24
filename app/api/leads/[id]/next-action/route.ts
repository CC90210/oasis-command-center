/**
 * POST /api/leads/[id]/next-action
 *
 * Compute the AI-recommended next move for one OASIS lead.
 * Phase 5b of the OASIS HQ redesign.
 *
 * Pipeline:
 *   1. Resolve operator tenant via session cookie
 *   2. Fetch the lead row from tenant_records + its recent interactions
 *   3. Hand both to lib/ai-next-action.ts (Claude Sonnet)
 *   4. Merge {ai_next_action, ai_next_action_rationale, ai_next_action_at}
 *      into lead.data so the next page render shows it without another call
 *   5. Return the action for the client to render
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";
import { recommendNextAction, type InteractionSnapshot } from "@/lib/ai-next-action";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type InteractionRow = {
  id: string;
  type: string;
  channel: string | null;
  subject: string | null;
  content: string | null;
  created_at: string;
  metadata?: Record<string, unknown> | null;
};

const OUTBOUND_TYPES = new Set([
  "email_sent", "dm_sent", "linkedin_sent", "call_made", "sms_sent",
]);
const INBOUND_TYPES = new Set([
  "email_received", "email_reply", "dm_received", "sms_received",
]);

function toSnapshot(row: InteractionRow): InteractionSnapshot {
  return {
    direction: OUTBOUND_TYPES.has(row.type)
      ? "outbound"
      : INBOUND_TYPES.has(row.type)
        ? "inbound"
        : "outbound",
    // Prefer the explicit channel column; fall back to the type so older
    // rows (channel was added later in migration 003) still narrate.
    channel: row.channel || row.type,
    subject: row.subject,
    body_preview: row.content,
    at: row.created_at,
  };
}

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  // Per-lead AI is a MEMBER CRM tool (CC 2026-07-07): any non-read_only member may
  // request a next-action for a lead they're working. Admin-only is reserved for
  // automations + sequences MANAGEMENT — NOT per-lead AI.
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenantId = sess.tenantId;
  const { id: leadId } = await ctx.params;
  if (!leadId) {
    return NextResponse.json({ ok: false, error: "missing_id" }, { status: 400 });
  }
  // Extended 2026-08-24: the OASIS sales roles may run this on their OWN leads.
  const access = await assertMayWorkLead({
    teamRole: sess.teamRole,
    userId: sess.userId,
    tenantId,
    leadId,
    isOwner: sess.isTrueAdmin,
    adminAccess: sess.adminAccess,
  });
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, error: access.error, message: access.message },
      { status: access.status },
    );
  }

  const db = getServiceSupabase();
  const r = await db
    .from("tenant_records")
    .select("id, data")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "lead")
    .eq("id", leadId)
    .maybeSingle();
  if (r.error || !r.data) {
    return NextResponse.json({ ok: false, error: "lead_not_found" }, { status: 404 });
  }
  const leadData = ((r.data as { data: Record<string, unknown> }).data) || {};

  // Pull the last 10 interactions tied to this lead. lead_interactions
  // is keyed on lead_id (see lib/supabase.ts LeadInteraction type +
  // migration 003); there's no lead_email column. Empty list is a fine
  // fallback — Claude can still recommend a next action from the lead
  // data alone, it just won't have prior-touch context.
  let interactions: InteractionRow[] = [];
  try {
    const ir = await db
      .from("lead_interactions")
      .select("id, type, channel, subject, content, created_at, metadata")
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(10);
    interactions = (ir.data as InteractionRow[]) || [];
  } catch {
    interactions = [];
  }

  let result;
  try {
    result = await recommendNextAction(leadData, interactions.map(toSnapshot), { tenantId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "anthropic_key_missing") {
      return NextResponse.json(
        { ok: false, error: "ai_unavailable", message: "BRAVO_ANTHROPIC_API_KEY not set on the dashboard" },
        { status: 503 },
      );
    }
    if (message.startsWith("next_action_parse_failed")) {
      return NextResponse.json(
        { ok: false, error: "parse_failed", message },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "ai_failed", message },
      { status: 500 },
    );
  }

  // 2026-06-06 (Codex audit) — atomic shallow merge via the
  // patch_tenant_record_data RPC. The previous read-then-write would
  // silently overwrite any concurrent edit that landed while we were
  // waiting for Claude. Same race the /score route had; same fix.
  const upd = await db.rpc("patch_tenant_record_data", {
    p_id: leadId,
    p_tenant_id: tenantId,
    p_patch: {
      ai_next_action: result.action,
      ai_next_action_rationale: result.rationale,
      ai_next_action_at: result.generated_at,
    },
  });
  if (upd.error) {
    return NextResponse.json(
      { ok: false, error: "write_failed", message: upd.error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    action: result.action,
    rationale: result.rationale,
    generated_at: result.generated_at,
  });
}
