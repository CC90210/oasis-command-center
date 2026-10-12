/**
 * /api/agent-config/person-engine - YOUR engine choice (O3b, "How your
 * departments think"): SELF ONLY, never a body-supplied user id (the same
 * lesson O0 fixed for pairing: a request body must never pick who a write is
 * for). Backs components/settings/PersonEngineCard.tsx.
 *
 *   GET  -> { ok, choice, effective, hasApprovedComputer, workspaceDefault }
 *     choice            this person's own saved row ('computer' | 'api'), or
 *                       null when they have never chosen (the workspace
 *                       default answers for them -- see `effective`)
 *     effective         what actually answers THEM right now:
 *                       { source: 'person' | 'workspace', kind }
 *     hasApprovedComputer  whether they have at least one of their own
 *                       non-revoked, approved (claim_enabled_at) computers --
 *                       the UI disables "My computer" without this
 *     workspaceDefault  the workspace's own row, in plain words, for the
 *                       "Workspace default (currently: X)" option
 *
 *   PUT  -> 410 upgrade_required
 *     Legacy writes are retired. Engine changes must use /api/ai/engine,
 *     which binds an exact pairing, fresh probe receipt, and engine version.
 *     GET stays available during rollout for old read-only clients.
 */
import { NextResponse } from "next/server";
import { getSessionContext } from "@/lib/team";
import { getOwnComputers } from "@/lib/queries";
import { readAgentEngine, readEffectiveEngine, readPersonEngine } from "@/lib/ai/agent-engine-store";
import { agentsEngineLine } from "@/lib/ai/agent-engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SIGNED_OUT = "Your session ended. Sign in again, then try again.";
const fail = (status: number, error: string, message: string) => NextResponse.json({ ok: false, error, message }, { status });
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function GET() {
  const ctx = await getSessionContext();
  if (!ctx) return fail(401, "unauthorized", SIGNED_OUT);
  const { tenantId, authUserId } = ctx;
  try {
    // The workspace's own engine, read on its own: once a person has chosen,
    // `effective` is theirs, and the card still needs the workspace default
    // (its label, and whether the API option is offered) (Codex review, O3b).
    const [choice, effective, computers, workspaceEngine] = await Promise.all([
      readPersonEngine(tenantId, authUserId),
      readEffectiveEngine(tenantId, authUserId),
      getOwnComputers(tenantId, authUserId),
      readAgentEngine(tenantId),
    ]);
    const hasApprovedComputer = computers.some((c) => Boolean(c.claimEnabledAt));
    const apiChoiceAllowed = workspaceEngine.kind === "api";
    return NextResponse.json(
      {
        ok: true,
        choice: choice?.kind ?? null,
        effective,
        hasApprovedComputer,
        apiChoiceAllowed,
        workspaceDefault: agentsEngineLine(workspaceEngine),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    console.error("[agent-config.person-engine.read]", { tenantId, error: errText(err) });
    return fail(503, "config_unavailable", "We could not read how your departments think just now. Refresh to try again.");
  }
}

export async function PUT() {
  const ctx = await getSessionContext();
  if (!ctx) return fail(401, "unauthorized", SIGNED_OUT);
  return NextResponse.json(
    {
      ok: false,
      error: "upgrade_required",
      message: "This engine setup path is read-only now. Test and save the exact computer and runtime in AI Brain.",
      upgrade_endpoint: "/api/ai/engine",
    },
    { status: 410, headers: { "cache-control": "no-store" } },
  );
}
