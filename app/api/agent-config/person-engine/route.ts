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
 *   PUT  { choice: 'computer' | 'api' | 'default' } -> { ok, choice }
 *     Saves ONLY the signed-in person's own row. Accepted whether or not they
 *     currently have an approved computer -- 'computer' is a standing
 *     preference, enforced on every send (lib/os/runs/session.ts), not here:
 *     a person may choose it before connecting a computer, or after.
 *     'default' CLEARS their own row, so the workspace default answers for
 *     them again (the "Workspace default (currently: X)" radio).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionContext } from "@/lib/team";
import { getOwnComputers } from "@/lib/queries";
import {
  clearPersonEngine,
  parsePersonEngineChoice,
  readEffectiveEngine,
  readPersonEngine,
  savePersonEngine,
  workspaceAllowsPersonApiChoice,
} from "@/lib/ai/agent-engine-store";
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
    const [choice, effective, computers, apiChoiceAllowed] = await Promise.all([
      readPersonEngine(tenantId, authUserId),
      readEffectiveEngine(tenantId, authUserId),
      getOwnComputers(tenantId, authUserId),
      workspaceAllowsPersonApiChoice(tenantId),
    ]);
    const hasApprovedComputer = computers.some((c) => Boolean(c.claimEnabledAt));
    const workspaceEngine = effective.source === "workspace" ? effective.engine : null;
    return NextResponse.json(
      {
        ok: true,
        choice: choice?.kind ?? null,
        effective,
        hasApprovedComputer,
        apiChoiceAllowed,
        workspaceDefault: workspaceEngine ? agentsEngineLine(workspaceEngine) : null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    console.error("[agent-config.person-engine.read]", { tenantId, error: errText(err) });
    return fail(503, "config_unavailable", "We could not read how your departments think just now. Refresh to try again.");
  }
}

export async function PUT(req: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx) return fail(401, "unauthorized", SIGNED_OUT);
  const { tenantId, authUserId } = ctx;
  let raw: { choice?: unknown };
  try {
    raw = (await req.json()) as { choice?: unknown };
  } catch {
    return fail(400, "invalid_json", "That request could not be read. Try again.");
  }
  if (raw.choice === "default") {
    try {
      await clearPersonEngine(tenantId, authUserId);
    } catch (err) {
      console.error("[agent-config.person-engine.clear]", { tenantId, error: errText(err) });
      return fail(500, "save_failed", "The choice couldn't be saved just now. Nothing was changed. Try again in a moment.");
    }
    return NextResponse.json({ ok: true, choice: null });
  }
  const choice = parsePersonEngineChoice(raw.choice);
  if (!choice) return fail(400, "invalid_choice", "Pick your own computer, the workspace API key, or the workspace default.");
  try {
    // The workspace AI account only where the workspace itself runs on it
    // (security review, O3b): a person never opts onto the owner's key
    // against the owner's choice. readEffectiveEngine enforces it on every
    // send too; this refusal just says so at the moment of choosing.
    if (choice.kind === "api" && !(await workspaceAllowsPersonApiChoice(tenantId))) {
      return fail(
        409,
        "workspace_key_not_allowed",
        "This workspace runs department chats on each person's own computer, so its AI account can't be chosen here. Ask an owner if that should change.",
      );
    }
    await savePersonEngine(tenantId, authUserId, choice);
  } catch (err) {
    console.error("[agent-config.person-engine.write]", { tenantId, error: errText(err) });
    return fail(500, "save_failed", "The choice couldn't be saved just now. Nothing was changed. Try again in a moment.");
  }
  return NextResponse.json({ ok: true, choice: choice.kind });
}
