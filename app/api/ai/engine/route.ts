/**
 * /api/ai/engine - WHAT POWERS YOUR AGENTS (lib/ai/agent-engine.ts), read and
 * switched from Settings > AI brain (components/settings/AgentEnginePanel.tsx).
 *
 *   GET  -> { ok, engine, account, savedProviders, bridge: { reachable } }
 *        engine          the workspace's choice (api / cli / local)
 *        account         the AI account the departments use on "api", and as
 *                        the fallback: { provider, providerLabel, model, modelLabel } or null
 *        savedProviders  cloud providers with a saved team key (switchable
 *                        without pasting again, lib/ai/agent-engine-store.ts)
 *        bridge.reachable whether the paired computer can be reached for THIS
 *                        person, by the coding harness's own gate
 *
 *   PUT  { engine } -> { ok, engine, test? }
 *        Owners and admins only (403). Before an engine on the paired computer
 *        is saved, it answers ONE short department reply through the road a
 *        department turn takes (lib/ai/bridge-turn.ts testBridgeEngine); if it
 *        fails, nothing is changed (422, the test's own sentence). "api" needs a
 *        usable AI account (409 otherwise); its key is tested by the account's
 *        own Test and by every model or provider switch.
 *
 *   POST { engine } -> { ok, latency_ms, reply } | { ok:false, message }
 *        "Test": one short department answer on an engine on the paired
 *        computer, WITHOUT saving it. (The API account's Test is
 *        /api/agent-config/test-connection.)
 *
 * Every non-ok answer carries one plain `message`, the only thing the panel shows.
 */
import { NextRequest, NextResponse } from "next/server";
import { canManageTeam, getSessionContext } from "@/lib/team";
import { getTenant } from "@/lib/queries";
import { hasUsableKey, readWorkspaceAiAccount } from "@/lib/ai/workspace-account";
import { departmentBrain } from "@/lib/ai/department-brain";
import { isOasisWorkspace, readAgentEngine, readSavedProviders, saveAgentEngine } from "@/lib/ai/agent-engine-store";
import { parseEngineChoice, type AgentEngineChoice } from "@/lib/ai/agent-engine";
import { bridgeCallerForSession, testBridgeEngine } from "@/lib/ai/bridge-turn";
import { DEPARTMENT_REPLY_MAX_TOKENS, DEPARTMENT_TEST_ASK, DEPARTMENT_TEST_SYSTEM } from "@/lib/os/channel/reply-budget";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";
import { harnessForDepartment } from "@/lib/admin/harness-targets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const SIGNED_OUT = "Your session ended. Sign in again, then try again.";
const fail = (status: number, error: string, message: string) => NextResponse.json({ ok: false, error, message }, { status });
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** OASIS: the Test answers in the Chief of Staff's harness, the road a real department turn takes. */
function testHarness(tenantSlug: string | null): { agent: string; department: string } | null {
  const target = isOasisSurfaceTenant(tenantSlug) ? harnessForDepartment("chief_of_staff") : null;
  return target ? { agent: target.agent, department: "Chief of Staff" } : null;
}

export async function GET() {
  const ctx = await getSessionContext();
  if (!ctx?.tenantId) return fail(401, "unauthorized", SIGNED_OUT);
  const tenantId = ctx.tenantId;
  try {
    const [engine, account, savedProviders, caller, oasis] = await Promise.all([
      readAgentEngine(tenantId),
      readWorkspaceAiAccount(tenantId),
      readSavedProviders(tenantId),
      bridgeCallerForSession(tenantId),
      isOasisWorkspace(tenantId),
    ]);
    const brain = hasUsableKey(account) ? departmentBrain(account) : null;
    return NextResponse.json(
      {
        ok: true,
        engine,
        account: brain
          ? { provider: brain.provider, providerLabel: brain.providerLabel, model: brain.savedModel ?? brain.model, modelLabel: brain.modelLabel }
          : null,
        savedProviders,
        bridge: { reachable: caller !== null },
        // OASIS's own workspace runs its agents' harnesses through the bridge;
        // AI brain shows that workflow first (API keys stay for clients).
        workspace: oasis ? "oasis" : "client",
        canManage: ctx.isOwner || canManageTeam(ctx.teamRole, ctx.adminAccess),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    console.error("[ai.engine.read]", { tenantId, error: errText(err) });
    return fail(503, "config_unavailable", "We could not read what powers your agents just now. Refresh to try again.");
  }
}

export async function POST(req: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx?.tenantId) return fail(401, "unauthorized", SIGNED_OUT);
  if (!(ctx.isOwner || canManageTeam(ctx.teamRole, ctx.adminAccess))) {
    return fail(403, "admin_required", "Only an owner or admin can test what powers your agents.");
  }
  let raw: { engine?: unknown };
  try {
    raw = (await req.json()) as { engine?: unknown };
  } catch {
    return fail(400, "invalid_json", "That request could not be read. Try again.");
  }
  const choice = parseEngineChoice(raw.engine);
  if (!choice || choice.kind === "api") {
    return fail(400, "invalid_engine", "Pick an app or a local model on your paired computer to test.");
  }
  const caller = await bridgeCallerForSession(ctx.tenantId);
  if (!caller) {
    return fail(409, "bridge_unavailable", "Your paired computer can't be reached from this account right now. Start the bridge on it, then try again.");
  }
  const tenant = await getTenant(ctx.tenantId);
  const tested = await testBridgeEngine({
    caller,
    engine: choice,
    tenantSlug: tenant?.slug ?? "",
    harness: testHarness(tenant?.slug ?? null),
    system: DEPARTMENT_TEST_SYSTEM,
    ask: DEPARTMENT_TEST_ASK,
    maxTokens: DEPARTMENT_REPLY_MAX_TOKENS,
  });
  if (!tested.ok) return NextResponse.json({ ok: false, error: "engine_test_failed", code: tested.code, message: tested.message }, { status: 422 });
  return NextResponse.json({ ok: true, latency_ms: tested.latency_ms, reply: tested.reply });
}

export async function PUT(req: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx?.tenantId) return fail(401, "unauthorized", SIGNED_OUT);
  if (!(ctx.isOwner || canManageTeam(ctx.teamRole, ctx.adminAccess))) {
    return fail(403, "admin_required", "Only an owner or admin can change what powers your agents.");
  }
  const tenantId = ctx.tenantId;
  let raw: { engine?: unknown };
  try {
    raw = (await req.json()) as { engine?: unknown };
  } catch {
    return fail(400, "invalid_json", "That request could not be read. Try again.");
  }
  const choice: AgentEngineChoice | null = parseEngineChoice(raw.engine);
  if (!choice) return fail(400, "invalid_engine", "Pick an AI account, an app on your paired computer, or a local model.");

  let test: { latency_ms: number; reply: string } | null = null;
  if (choice.kind === "api") {
    let account;
    try {
      account = await readWorkspaceAiAccount(tenantId);
    } catch (err) {
      console.error("[ai.engine.account]", { tenantId, error: errText(err) });
      return fail(503, "config_unavailable", "We could not read this workspace's AI account just now. Nothing was changed.");
    }
    if (!hasUsableKey(account)) {
      return fail(409, "no_account", "No AI account is connected yet. Connect one below first, then choose it here.");
    }
  } else {
    const caller = await bridgeCallerForSession(tenantId);
    if (!caller) {
      return fail(
        409,
        "bridge_unavailable",
        "Your paired computer can't be reached from this account right now, so it can't be tested. Start the bridge on it, then try again. Nothing was changed.",
      );
    }
    const tenant = await getTenant(tenantId);
    const tested = await testBridgeEngine({
      caller,
      engine: choice,
      tenantSlug: tenant?.slug ?? "",
      harness: testHarness(tenant?.slug ?? null),
      system: DEPARTMENT_TEST_SYSTEM,
      ask: DEPARTMENT_TEST_ASK,
      maxTokens: DEPARTMENT_REPLY_MAX_TOKENS,
    });
    if (!tested.ok) {
      return NextResponse.json(
        { ok: false, error: "engine_test_failed", code: tested.code, message: `It did not pass the test, so nothing was changed. ${tested.message}` },
        { status: 422 },
      );
    }
    test = { latency_ms: tested.latency_ms, reply: tested.reply };
  }

  try {
    await saveAgentEngine(tenantId, choice);
  } catch (err) {
    console.error("[ai.engine.write]", { tenantId, error: errText(err) });
    return fail(500, "save_failed", "The choice couldn't be saved just now. Nothing was changed. Try again in a moment.");
  }
  return NextResponse.json({ ok: true, engine: choice, ...(test ? { test } : {}) });
}
