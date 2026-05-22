/**
 * POST /api/leads/[id]/stage-event — generic stage-engine trigger.
 *
 * Lets non-server-rendered surfaces (the SMS composer, future
 * voice-note recorders, manual operator "mark contacted" buttons)
 * fire a lead_stage_engine event without re-implementing the rule
 * lookup. The engine itself owns whether the event causes a
 * transition or is a no-op.
 *
 * Whitelisted event types only — operators can't synthesize a
 * `lead_replied_negative` from the UI (that's reserved for the
 * inbound classifier).
 *
 * Body: { type: "outbound_email_sent" | "outbound_email_queued" |
 *                "form_signed" }
 *
 * Auth: session-cookie → tenant.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { dispatchLeadStageEvent, dispatchOasisOnlyEvent } from "@/lib/lead-stage-dispatcher";
import type { OasisLeadStageEvent } from "@/lib/oasis-lead-stage-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMMON_OPERATOR_TRIGGERABLE = new Set<string>([
  "outbound_email_sent",
  "outbound_email_queued",
  "form_signed",
]);

const OASIS_OPERATOR_TRIGGERABLE = new Set<OasisLeadStageEvent["type"]>([
  "discovery_call_scheduled",
  "lead_qualified",
  "proposal_sent",
  "proposal_viewed",
  "contract_signed",
  "onboarding_complete",
  "lead_replied_negative",
  "contract_ended",
  "manual_outreach_started",
  "manual_archive",
]);

export async function POST(
  req: NextRequest,
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

  let body: { type?: unknown };
  try {
    body = (await req.json()) as { type?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const type = typeof body.type === "string" ? body.type : "";
  if (!COMMON_OPERATOR_TRIGGERABLE.has(type) && !OASIS_OPERATOR_TRIGGERABLE.has(type as OasisLeadStageEvent["type"])) {
    return NextResponse.json(
      { ok: false, error: "event_type_not_allowed", type },
      { status: 400 },
    );
  }

  const result = OASIS_OPERATOR_TRIGGERABLE.has(type as OasisLeadStageEvent["type"])
    ? await dispatchOasisOnlyEvent({
        type: type as OasisLeadStageEvent["type"],
        tenantId: sess.tenantId,
        leadId,
      })
    : await dispatchLeadStageEvent({
        type: type as "outbound_email_sent" | "outbound_email_queued" | "form_signed",
        tenantId: sess.tenantId,
        leadId,
      });

  return NextResponse.json({
    ok: true,
    fired: result.fired,
    ...(result.fired
      ? { from: result.from, to: result.to, reason: result.reasonCode }
      : { reason: result.reason }),
  });
}
