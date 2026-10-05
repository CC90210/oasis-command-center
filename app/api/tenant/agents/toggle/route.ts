/**
 * POST /api/tenant/agents/toggle — owner-only mutation of the tenant's
 * manifest.agents array.
 *
 * Body: { action: "add" | "enable" | "disable" | "remove", slug: string }
 *
 * Rules:
 *   - Caller MUST be signed in AND be an owner or admin of the tenant.
 *   - "add"     — slug must NOT already exist on the manifest. Appends a
 *                 binding with enabled=true, core=false. The slug must be a
 *                 teammate this workspace built (a tenant-owned `agents` row,
 *                 W4a: a teammate made before it was bound on creation can be
 *                 turned on) or, in OASIS's own workspace only, an OASIS house
 *                 agent; a house agent is refused in every other workspace.
 *   - "enable"  — flips enabled=true on an existing binding.
 *   - "disable" — flips enabled=false on an existing binding. Refused
 *                 for core agents (core=true cannot be disabled).
 *   - "remove"  — drops the binding entirely. Refused for core agents.
 * The rules and the write live in lib/manifest/agent-bindings.ts, shared with
 * POST /api/agents (a new teammate is bound when it is created).
 *
 * Returns the updated agents array on success so the client can
 * re-render without a follow-up GET, and a message that names the teammate
 * the way the workspace's roster does (never a persona).
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { resolveAgentKey } from "@/lib/agents";
import { changeAgentLineup, type AgentLineupAction } from "@/lib/manifest/agent-bindings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_ACTIONS = new Set<AgentLineupAction>(["add", "enable", "disable", "remove"]);

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { action?: string; slug?: string };
  try {
    body = (await req.json()) as { action?: string; slug?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const action = (body.action || "").trim();
  const slug = resolveAgentKey((body.slug || "").trim().toLowerCase());
  if (!VALID_ACTIONS.has(action as AgentLineupAction)) {
    return NextResponse.json({ ok: false, error: "invalid_action" }, { status: 400 });
  }
  if (!slug) {
    return NextResponse.json({ ok: false, error: "missing_slug" }, { status: 400 });
  }

  // Owner check — only the workspace owner can mutate the agent lineup.
  if (!session.isAdmin) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Administrator access is required to manage agents." },
      { status: 403 },
    );
  }

  const result = await changeAgentLineup({ tenantId: session.tenantId, action: action as AgentLineupAction, slug });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error, message: result.message }, { status: result.status });
  }
  return NextResponse.json({ ok: true, agents: result.agents, message: result.message });
}
