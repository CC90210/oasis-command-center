/**
 * POST /api/agent-config/workspace-provider  { provider, model? }
 *
 * Settings > AI brain's PROVIDER switch (CC, 2026-10-09: "I can't switch
 * between different providers, like Anthropic or OpenAI"). The workspace AI
 * account (lib/ai/workspace-account.ts) moves to another cloud provider whose
 * team key is already saved in this workspace (lib/ai/agent-engine-store.ts
 * readSavedKey), without pasting it again. A provider with no saved key is
 * connected on its card (/api/agent-config/bulk-provider), as before.
 *
 *   - Owners and admins only (403).
 *   - The model: the one asked for, else the one saved with that key, else the
 *     provider's first offered model; it must pass saveCheck (400).
 *   - BEFORE anything is written, the saved key answers one short department
 *     reply on that model (probeDepartmentAnswer, the same Test as everywhere):
 *     a provider the departments would fail on is never switched to (422).
 *   - The account's current key is kept on its own row first (keepSavedKey), so
 *     switching back needs no paste either.
 *   - Then ONE step, guarded on the account as read
 *     (connectWorkspaceAccountInOneStep with a fresh ciphertext and no named
 *     teammates: the team rows that held the previous key move with it, as on
 *     every connect). Another window's change meanwhile changes nothing (409).
 *
 * Returns { ok, provider, model, label }. Every non-ok answer has one plain `message`.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAuthedSupabase } from "@/lib/supabase-server";
import { canManageTeam, getSessionContext } from "@/lib/team";
import { decryptField, encryptField } from "@/lib/field-encryption";
import { PROVIDER_LABEL, type Provider } from "@/lib/providers";
import {
  connectWorkspaceAccountInOneStep,
  hasUsableKey,
  readAccountStamp,
  readWorkspaceAiAccount,
  type WorkspaceAiAccount,
} from "@/lib/ai/workspace-account";
import { SWITCHABLE_PROVIDERS, keepSavedKey, readSavedKey } from "@/lib/ai/agent-engine-store";
import { defaultModelFor, isRegistryProvider, modelInfo, saveCheck } from "@/lib/ai/model-registry";
import { probeDepartmentAnswer } from "@/lib/agents/provider-probe";
import { billingForKey, modelCallMeter } from "@/lib/ai/usage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SIGNED_OUT = "Your session ended. Sign in again, then try again.";
const NOT_SAVED = "The provider couldn't be switched just now. Nothing was changed. Try again in a moment.";
const CONFLICT = "The AI account was changed in another window, so nothing was switched. Check the card, then try again.";

const fail = (status: number, error: string, message: string) => NextResponse.json({ ok: false, error, message }, { status });
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The model to switch to: asked, else saved with the key, else the provider's first offered one. */
function switchModel(provider: Provider, asked: string, savedWithKey: string | null): string {
  if (asked) return asked;
  if (savedWithKey && saveCheck(provider, savedWithKey).ok && modelInfo(provider, savedWithKey)) return savedWithKey;
  return isRegistryProvider(provider) ? defaultModelFor(provider) : savedWithKey || "";
}

export async function POST(req: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx?.tenantId) return fail(401, "unauthorized", SIGNED_OUT);
  if (!(ctx.isOwner || canManageTeam(ctx.teamRole, ctx.adminAccess))) {
    return fail(403, "admin_required", "Only an owner or admin can change the AI provider your agents use.");
  }
  const tenantId = ctx.tenantId;

  let body: { provider?: unknown; model?: unknown };
  try {
    body = (await req.json()) as { provider?: unknown; model?: unknown };
  } catch {
    return fail(400, "invalid_json", "That request could not be read. Try again.");
  }
  const provider = (typeof body.provider === "string" ? body.provider.trim() : "") as Provider;
  if (!SWITCHABLE_PROVIDERS.includes(provider)) return fail(400, "invalid_provider", "Pick Anthropic, OpenAI, Google or OpenRouter.");
  const label = PROVIDER_LABEL[provider];
  const asked = typeof body.model === "string" ? body.model.trim() : "";

  let account: WorkspaceAiAccount | null;
  let saved: Awaited<ReturnType<typeof readSavedKey>>;
  try {
    [account, saved] = await Promise.all([readWorkspaceAiAccount(tenantId), readSavedKey(tenantId, provider)]);
  } catch (err) {
    console.error("[workspace-provider.read]", { tenantId, error: errText(err) });
    return fail(503, "config_unavailable", "We could not read this workspace's AI keys just now. Nothing was changed.");
  }
  if (hasUsableKey(account) && account.provider === provider) {
    return NextResponse.json({ ok: true, provider, model: account.model, label: modelInfo(provider, account.model)?.label ?? account.model, unchanged: true });
  }
  if (!saved) {
    return fail(409, "no_saved_key", `No ${label} key is saved for this workspace yet. Connect it on the ${label} card below.`);
  }
  const model = switchModel(provider, asked, saved.model);
  const check = saveCheck(provider, model);
  if (!check.ok) return fail(400, "model_not_offered", check.message);
  const modelLabel = modelInfo(provider, model)?.label ?? model;

  let key: string;
  try {
    key = decryptField(saved.encryptedApiKey);
  } catch {
    return fail(500, "key_unreadable", `The saved ${label} key could not be read. Connect it again on its card.`);
  }
  const tested = await probeDepartmentAnswer(provider, key, {
    model,
    meter: modelCallMeter({ tenantId, surface: "probe", ...billingForKey(provider, "tenant"), userId: ctx.authUserId }),
  });
  if (!tested.ok) {
    return NextResponse.json(
      { ok: false, error: "provider_test_failed", code: tested.code, message: `${label} (${modelLabel}) did not pass the test, so nothing was changed. ${tested.message}` },
      { status: 422 },
    );
  }

  try {
    // Keep the outgoing key, so switching back needs no paste.
    if (hasUsableKey(account) && SWITCHABLE_PROVIDERS.includes(account.provider)) {
      await keepSavedKey({ tenantId, provider: account.provider, model: account.model, encryptedApiKey: account.encryptedApiKey });
    }
    // And this one, so it stays saved whatever the connect moves.
    if (saved.source !== "kept") await keepSavedKey({ tenantId, provider, model, encryptedApiKey: saved.encryptedApiKey });
  } catch (err) {
    console.error("[workspace-provider.keep]", { tenantId, provider, error: errText(err) });
    return fail(500, "save_failed", NOT_SAVED);
  }

  let committed = false;
  try {
    const stamp = await readAccountStamp(tenantId);
    const outcome = await connectWorkspaceAccountInOneStep({
      tenantId,
      stamp,
      provider,
      model,
      encryptedApiKey: encryptField(key),
      agentKeys: [],
    });
    committed = outcome.committed;
  } catch (err) {
    console.error("[workspace-provider.write]", { tenantId, provider, error: errText(err) });
    return fail(500, "save_failed", NOT_SAVED);
  }
  if (!committed) return fail(409, "conflict", CONFLICT);

  try {
    const authed = await getAuthedSupabase();
    await authed.rpc("log_tenant_event", {
      p_tenant_id: tenantId,
      p_action_type: "agent_config.tenant_provider",
      p_target_table: "agent_model_config",
      p_target_id: `${tenantId}:tenant:provider`,
      p_before: { provider: account?.provider ?? null, model: account?.model ?? null },
      p_after: { provider, model },
    });
  } catch {
    // audit-log soft-fail, as the connect route does
  }
  return NextResponse.json({ ok: true, provider, model, label: modelLabel });
}
