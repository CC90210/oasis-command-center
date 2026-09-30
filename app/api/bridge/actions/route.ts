/**
 * POST /api/bridge/actions — apply ONE change the Coding harness proposed,
 * after the operator confirmed it in the chat (2026-09-30).
 *
 * /api/bridge/chat no longer writes anything when a reply ends: each
 * <dashboard-action> marker in the reply reaches the widget as a signed
 * proposal (lib/admin/bridge-dashboard-actions.ts). The operator clicks Apply,
 * then Confirm, and the widget posts that proposal here verbatim.
 *
 * Gates, in order:
 *   - the session is authorized for the bridge exactly as the chat was
 *     (lib/bridge-proxy authorizeBridgeRequest): signed out 401, a workspace
 *     without the bridge 403; tenant, user and role come from that, never the
 *     body;
 *   - the agent is one this workspace's bridge serves;
 *   - the signature matches this type, payload and expiry for THIS session's
 *     tenant, user and agent: an edited payload or another session's token is
 *     403, an expired one 410, and nothing runs;
 *   - the role is re-checked; then runAction runs it and logAction logs it,
 *     so the change shows in /runs.
 * The answer is the action's result, which the widget shows as applied or
 * rejected.
 */

import { NextResponse } from "next/server";
import { authorizeBridgeRequest } from "@/lib/bridge-proxy";
import { validateBridgeAgent } from "@/lib/agent-roots";
import { applyPendingBridgeAction } from "@/lib/admin/bridge-dashboard-actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ ok: false, type: "?", error: "too_large" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, type: "?", error: "invalid_json" }, { status: 400 });
  }
  const type = typeof body.type === "string" ? body.type : "?";

  const auth = await authorizeBridgeRequest();
  if (!auth.ok) return NextResponse.json({ ok: false, type, error: auth.error }, { status: auth.status });

  const agent = String(body.agent || "").trim().toLowerCase();
  const agentCheck = validateBridgeAgent(agent, auth.tenantSlug);
  if (!agentCheck.ok) return NextResponse.json({ ok: false, type, error: agentCheck.error }, { status: agentCheck.status });

  const { status, result } = await applyPendingBridgeAction(body, {
    tenantId: auth.tenantId,
    userId: auth.userId,
    agent,
    teamRole: auth.teamRole,
  });
  return NextResponse.json(result, { status });
}
