/**
 * POST /api/leads/[id]/compose-checkin
 *
 * Returns an AI-composed personalized check-in email for the lead.
 * Used by the LeadActionToolbar "Send check-in" button: instead of
 * opening the modal with a hardcoded "Hey {firstName}, just checking
 * in..." template, the modal fetches this endpoint and pre-fills the
 * form with the AI's draft. The operator can edit before clicking
 * Queue send.
 *
 * Auth: session-cookie → tenant. Read-only — does NOT persist anything;
 * the queue happens via the existing POST /api/leads/[id]/email path.
 *
 * Response 200: { ok: true, subject, body, composed_at }
 * Response 4xx/5xx: { ok: false, error, message?, fallback: { subject, body } }
 *   — on AI failure we still return a usable fallback so the operator
 *   can edit + send rather than seeing a dead modal.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { composeCheckin, type CheckinInteractionSnapshot } from "@/lib/ai-checkin-compose";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fallbackTemplate(
  leadData: Record<string, unknown>,
  daysSinceLastTouch: number | null,
  // operatorFirstName is intentionally unused — the OASIS email template
  // appends the operator's name + brand signature automatically when
  // send_gateway / dashboard_email_consumer wraps the body in branded
  // HTML. Adding our own sign-off here would surface it twice.
  _operatorFirstName: string,
): { subject: string; body: string } {
  const leadName =
    (typeof leadData.name === "string" && leadData.name) ||
    (typeof leadData.company === "string" && leadData.company) ||
    "";
  const firstName = leadName.split(/\s+/)[0] || "there";
  const company =
    typeof leadData.company === "string" && leadData.company.trim()
      ? leadData.company.trim()
      : null;
  const subject = company
    ? `Quick check-in — ${company}`
    : "Quick check-in";
  const contextLine =
    daysSinceLastTouch !== null && daysSinceLastTouch > 7
      ? `It's been a few weeks since we last touched base.`
      : `Wanted to share a quick thought.`;
  const body = `Hey ${firstName},

${contextLine}

If 10-15 minutes works on your end this week, happy to find a time. Otherwise, no pressure — just shoot back a thought if anything's on your mind.

Either way, let me know.`;
  return { subject, body };
}

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: leadId } = await ctx.params;
  if (!UUID_RE.test(leadId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  const access = await assertMayWorkLead({
    teamRole: sess.teamRole,
    userId: sess.userId,
    tenantId: sess.tenantId,
    leadId,
    isOwner: sess.isTrueAdmin,
    adminAccess: sess.adminAccess,
    accessMode: "owned_oasis_sales",
  });
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, error: access.error, message: access.message },
      { status: access.status },
    );
  }

  const db = getServiceSupabase();
  const [leadRow, interactionsRes, profileRow] = await Promise.all([
    db
      .from("tenant_records")
      .select("data, created_at")
      .eq("tenant_id", sess.tenantId)
      .eq("entity_type", "lead")
      .eq("id", leadId)
      .maybeSingle(),
    db
      .from("lead_interactions")
      .select("type, direction, channel, created_at, agent_source, subject, content_preview, metadata")
      .eq("tenant_id", sess.tenantId)
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(10),
    db
      .from("user_profiles")
      .select("full_name, display_name, email, brand")
      .eq("auth_user_id", sess.userId)
      .maybeSingle(),
  ]);

  if (leadRow.error || !leadRow.data) {
    return NextResponse.json({ ok: false, error: "lead_not_found" }, { status: 404 });
  }
  const leadData = (leadRow.data as { data: Record<string, unknown> | null }).data || {};
  const interactions = (interactionsRes.data || []) as CheckinInteractionSnapshot[];
  const profile = (profileRow.data as {
    full_name: string | null;
    display_name: string | null;
    email: string | null;
    brand: string | null;
  } | null) || { full_name: null, display_name: null, email: sess.email, brand: null };

  // Compute days_since_last_touch from the most-recent interaction or
  // the lead's created_at as a fallback (matches how the lead drawer
  // computes the same value).
  const lastInteractionAt =
    interactions[0]?.created_at ||
    (leadRow.data as { created_at?: string }).created_at ||
    null;
  const daysSinceLastTouch = lastInteractionAt
    ? Math.max(0, Math.floor((Date.now() - new Date(lastInteractionAt).getTime()) / 86_400_000))
    : null;

  const operatorFirstName =
    (profile.full_name || profile.display_name || "")
      .trim()
      .split(/\s+/)[0] ||
    (profile.email || "").split("@")[0] ||
    "Operator";

  const fallback = fallbackTemplate(leadData, daysSinceLastTouch, operatorFirstName);

  try {
    const composed = await composeCheckin({
      leadData,
      interactions,
      daysSinceLastTouch,
      operator: {
        full_name: profile.full_name,
        display_name: profile.display_name,
        email: profile.email,
        brand: profile.brand,
      },
    }, { tenantId: sess.tenantId });
    return NextResponse.json({
      ok: true,
      subject: composed.subject,
      body: composed.body,
      composed_at: composed.composed_at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 503 for missing key, 502 for parse failure, 500 otherwise. In all
    // cases include the deterministic fallback so the toolbar can still
    // open with usable content; the operator can edit and send.
    let status = 500;
    let errorTag = "ai_failed";
    if (message === "anthropic_key_missing") {
      status = 503;
      errorTag = "ai_unavailable";
    } else if (message.startsWith("compose_parse_failed")) {
      status = 502;
      errorTag = "compose_parse_failed";
    }
    return NextResponse.json(
      { ok: false, error: errorTag, message, fallback },
      { status },
    );
  }
}
