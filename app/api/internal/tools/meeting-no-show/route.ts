/**
 * POST /api/internal/tools/meeting-no-show - close a missed OASIS founder meeting
 * as a no-show and answer the lead's signed rebook link (lib/booking/no-show.ts).
 *
 * Signed by CC's machines like the tool runner (lib/tools/runner-auth.ts: HMAC
 * over "<timestamp>.<raw body>", TOOLS_RUNNER_SECRET_<PRODUCER>), never a
 * session; middleware lets /api/internal/tools/* through and the handler
 * authenticates first. OASIS's own workspace only.
 *
 * Body: {"appointment_id": "<uuid>", "who": "lead_absent" | "host_absent" | "both_absent" | "unknown"}
 * 200 {ok, appointment_id, lead_id, already_closed, lead_updated, lead_stage, rebook_url, scheduled_for}
 * 409 {error: "meeting_not_started" | "meeting_not_closable" | "not_a_founder_meeting" | ...}
 * 503 {error: "not_installed", detail: "rebook_key_not_set"}
 *
 * The rebook URL is a credential for one meeting: it is returned to the signed
 * caller to put in that lead's email, and never logged.
 */
import { authenticateToolsRequest, toolsJson, toolsRefuse } from "@/lib/tools/runner-auth";
import { markFounderMeetingNoShow, NO_SHOW_WHO, type NoShowWho } from "@/lib/booking/no-show";
import { RebookNotConfiguredError } from "@/lib/booking/rebook-token";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { SITE_ORIGIN } from "@/lib/marketing/routes";
import { getServiceSupabase } from "@/lib/supabase-server";
import { closeVerifiedFounderMeeting } from "@/lib/website-sales-founder-meeting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFLICTS = new Set([
  "appointment_not_found",
  "not_a_founder_meeting",
  "meeting_not_started",
  "meeting_not_closable",
  "meeting_close_conflict",
  "lead_not_found",
]);

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateToolsRequest(req, process.env, new Date());
  if (!auth.ok) return auth.response;
  const appointmentId = typeof auth.body.appointment_id === "string" ? auth.body.appointment_id.trim() : "";
  if (!UUID.test(appointmentId)) return toolsRefuse(422, "invalid_payload", { field: "appointment_id" });
  const who = (typeof auth.body.who === "string" ? auth.body.who.trim() : "unknown") as NoShowWho;
  if (!NO_SHOW_WHO.includes(who)) return toolsRefuse(422, "invalid_payload", { field: "who" });
  try {
    const result = await markFounderMeetingNoShow(
      { tenantId: AI_AUDIT_TENANT_ID, appointmentId, who, actorUserId: `system:meeting-no-show:${auth.producer}` },
      { db: getServiceSupabase(), now: () => Date.now(), close: closeVerifiedFounderMeeting, origin: SITE_ORIGIN },
    );
    return toolsJson(200, {
      ok: true,
      appointment_id: result.appointmentId,
      lead_id: result.leadId,
      already_closed: result.alreadyClosed,
      lead_updated: result.leadUpdated,
      lead_stage: result.leadStage,
      scheduled_for: result.scheduledFor,
      rebook_url: result.rebookUrl,
    });
  } catch (error) {
    if (error instanceof RebookNotConfiguredError) {
      return toolsRefuse(503, "not_installed", { detail: "rebook_key_not_set" });
    }
    const message = error instanceof Error ? error.message : "meeting_no_show_failed";
    const code = message.split(":", 1)[0];
    if (CONFLICTS.has(code)) return toolsRefuse(409, code, { detail: message.slice(0, 200) });
    console.error("[tools.meeting-no-show] failed", { appointmentId, code });
    return toolsRefuse(500, "meeting_no_show_failed", { detail: code });
  }
}
