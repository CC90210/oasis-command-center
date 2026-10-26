/**
 * /api/connections/agents - which agents may use each app and each custom key.
 *
 *   GET  every app card's choice in force: { slug: { access, saved, suggested } },
 *        and the agents an owner can pick from.
 *   PUT  { kind: "connector" | "custom", id, agents: "all" | DepartmentKey[] | null }
 *        saves one choice; null puts it back to the suggestion.
 *
 * Owners and admins only, like every key on Settings > Connections. The rules
 * and defaults are lib/os/agent-access.ts; where a choice is kept and how it is
 * enforced is lib/os/agent-access-store.ts and lib/cloud-tool-runner.ts.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { AGENT_CHOICES, APP_TOOLS, normalizeAgentAccess, sameAgentAccess, type AccessTarget } from "@/lib/os/agent-access";
import {
  clearAgentAccess,
  defaultAccess,
  effectiveAccess,
  readAgentAccessOverrides,
  saveAgentAccess,
} from "@/lib/os/agent-access-store";
import { CONNECTOR_CATALOG } from "@/lib/os/connectors";
import { VAULT_KEY_PATTERN } from "@/lib/tenant-integration-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


async function ownerSession() {
  const sess = await resolveSessionContext();
  if (!sess.ok) return { error: NextResponse.json({ ok: false, error: sess.reason }, { status: 401 }) } as const;
  if (!sess.isAdmin) return { error: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) } as const;
  return { sess } as const;
}

export async function GET() {
  const auth = await ownerSession();
  if ("error" in auth) return auth.error;
  const overrides = await readAgentAccessOverrides(auth.sess.tenantId);
  if (!overrides.ok) {
    console.error("[connections.agents] read failed", { tenantId: auth.sess.tenantId, error: overrides.error });
    return NextResponse.json({ ok: false, error: "agent_access_read_failed" }, { status: 500 });
  }
  // Every card, and every app an agent tool uses even without a card. A choice
  // that cannot be read comes back as access null so the owner can save it again.
  const connectors: Record<string, { access: unknown; saved: boolean; suggested: unknown; unreadable: boolean }> = {};
  for (const slug of knownApps()) {
    const target: AccessTarget = { kind: "connector", slug };
    const { access, saved } = effectiveAccess(overrides, target);
    connectors[slug] = { access, saved, suggested: defaultAccess(target), unreadable: access === null };
  }
  return NextResponse.json({ ok: true, choices: AGENT_CHOICES, connectors });
}

/** The apps a choice may be saved for: every card, plus the apps agent tools use (TextTorrent, Kixie have no card). */
function knownApps(): string[] {
  return [...new Set([...CONNECTOR_CATALOG.map((d) => d.slug), ...Object.values(APP_TOOLS)])];
}

export async function PUT(req: NextRequest) {
  const auth = await ownerSession();
  if ("error" in auth) return auth.error;
  let body: { kind?: unknown; id?: unknown; agents?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  let target: AccessTarget;
  if (body.kind === "connector" && typeof body.id === "string" && knownApps().includes(body.id)) {
    target = { kind: "connector", slug: body.id };
  } else if (body.kind === "custom" && typeof body.id === "string" && VAULT_KEY_PATTERN.test(body.id.trim().toUpperCase())) {
    target = { kind: "custom", key: body.id.trim().toUpperCase() };
  } else {
    return NextResponse.json({ ok: false, error: "unknown_target" }, { status: 400 });
  }

  if (body.agents === null) {
    const r = await clearAgentAccess({ tenantId: auth.sess.tenantId, target });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 500 });
    return NextResponse.json({ ok: true, access: defaultAccess(target), saved: false });
  }
  const access = normalizeAgentAccess(body.agents);
  if (access === null) return NextResponse.json({ ok: false, error: "invalid_agents" }, { status: 400 });
  const r = await saveAgentAccess({ tenantId: auth.sess.tenantId, target, access, createdBy: auth.sess.profileId });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 500 });
  // Saving the suggestion itself clears the row (saveAgentAccess), so a later change to the suggestion applies.
  return NextResponse.json({ ok: true, access, saved: !sameAgentAccess(access, defaultAccess(target)) });
}
