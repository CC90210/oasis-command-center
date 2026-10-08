/**
 * POST /api/agent-config/bulk-provider
 *
 * Single-click connect: paste an API key once, the route stamps it across
 * every enabled chat agent in the tenant. Powers the "Connect Anthropic"
 * button on the Provider Accounts card in /settings.
 *
 * Behavior:
 *   - Validates the provider + key format (light — server-side string
 *     length sanity check, NOT a live provider ping; the Settings card asks
 *     /api/agent-config/test-connection for one real message BEFORE it saves,
 *     and saves anyway only when the provider was down or slow).
 *   - scope=tenant ALWAYS saves the workspace's AI account (lib/ai/
 *     workspace-account.ts, agent_key "__workspace__"): the account every
 *     department chat and Slack mention answers on, whatever teammates the
 *     workspace has. Before this, a client whose teammates are neutral leads
 *     got rows nobody read, and every chat said "No AI account is connected"
 *     (AIP-01).
 *   - ONE STEP: the account and every teammate row it stamps are written in
 *     ONE batch (one transaction), guarded on the account as this request read
 *     it (lib/ai/workspace-account.ts, ONE STEP). All of it lands, or none of
 *     it: a key is never left half-saved. If another window changed the
 *     account meanwhile, nothing is written and the answer is 409 with a plain
 *     sentence; when what changed it was this same key (a retry, or the same
 *     key in another window), it is written again on top, which changes
 *     nothing.
 *   - Resolves the agent set: explicit `agent_keys[]` if supplied,
 *     otherwise the tenant's enabled chat-eligible agents.
 *   - Upserts (provider, model, encrypted_api_key) for each agent. Existing
 *     per-agent customizations (system_prompt_override, display_name_override)
 *     and each row's own on/off switch are preserved: only the
 *     provider/model/key triple is replaced. A row created here is switched on.
 *   - Defaults model to the provider's first registry entry (the
 *     recommended one) unless the caller passed a specific model.
 *   - Provider "ollama" (a local model server, whose "key" is a web address
 *     the server calls) is the verified platform operator's only (403).
 *   - `verify: true` writes nothing: it answers whether exactly this key is
 *     saved now (the card asks when a connect's answer never came back).
 *
 * Body shape:
 *   {
 *     provider: "anthropic" | "openai" | "google" | "openrouter",
 *     api_key: string,                    // required, encrypted server-side
 *     model?: string,                     // optional, default = first registry entry
 *     agent_keys?: string[],              // optional, default = enabled agents
 *     scope?: "tenant" | "user",          // default tenant
 *     verify?: boolean                    // read-only check, see above
 *   }
 *
 * Returns: { ok, scope, workspace_account, applied_to: [agent_key,...], failed: [], count }
 *   (verify: { ok, saved }). Every non-ok answer the card shows carries a
 *   plain `message`, never a code or the database's own words.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthedSupabase, getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { PROVIDER_MODELS, PROVIDER_REGISTRY, type Provider } from "@/lib/providers";
import { encryptField } from "@/lib/field-encryption";
import { getTenantChatAgentKeys } from "@/lib/manifest/tenant-scope";
import { canManageTeam, getSessionContext } from "@/lib/team";
import { resolveAgentKey } from "@/lib/agents";
import {
  LEGACY_WORKSPACE_AI_AGENT_KEY,
  LOCAL_MODEL_REFUSAL,
  connectWorkspaceAccountInOneStep,
  disconnectWorkspaceAccountInOneStep,
  keyIsSaved,
  mayUseLocalModel,
  readAccountStamp,
  savePersonalKeyInOneStep,
  stampHoldsKey,
} from "@/lib/ai/workspace-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NOT_SAVED = "The key couldn't be saved just now. Nothing was changed. Try again in a moment.";
const CONNECT_CONFLICT =
  "The AI account was changed in another window while this key saved, so nothing was changed. Check the card, then connect again if you still want this key.";
const COULD_NOT_TELL = "We couldn't check whether the key was saved. Close this and look at the card in a moment.";
const DISCONNECT_FAILED = "The AI account couldn't be disconnected just now. Nothing was changed. Try again in a moment.";
const DISCONNECT_CONFLICT = "The AI account was changed in another window, so nothing was disconnected. Check the card, then try again.";
const SIGNED_OUT = "Your session ended. Sign in again, then try again.";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function resolveTenant(): Promise<{
  tenantId: string | null;
  userId: string | null;
  canManageTenant: boolean;
  profileEnabledAgents: string[];
}> {
  const ctx = await getSessionContext();
  if (!ctx) {
    return { tenantId: null, userId: null, canManageTenant: false, profileEnabledAgents: [] };
  }
  const db = getServiceSupabase();
  const { data } = await db
    .from("user_profiles")
    .select("tenant_id, agents_enabled")
    .eq("auth_user_id", ctx.authUserId)
    .maybeSingle();
  const enabled = Array.isArray(data?.agents_enabled)
    ? (data!.agents_enabled as string[]).filter((s) => typeof s === "string")
    : [];
  return {
    tenantId: data?.tenant_id || ctx.tenantId || null,
    userId: ctx.authUserId,
    canManageTenant: ctx.isOwner || canManageTeam(ctx.teamRole, ctx.adminAccess),
    profileEnabledAgents: enabled,
  };
}

export async function POST(req: NextRequest) {
  const { tenantId, userId, canManageTenant, profileEnabledAgents } = await resolveTenant();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const provider = String(body?.provider || "");
  if (!Object.keys(PROVIDER_MODELS).includes(provider)) {
    return NextResponse.json({ ok: false, error: `invalid_provider:${provider}` }, { status: 400 });
  }
  const scope = body?.scope === "user" ? "user" : "tenant";
  if (scope === "tenant" && !canManageTenant) {
    return NextResponse.json({ ok: false, error: "admin_required" }, { status: 403 });
  }
  if (scope === "user" && !userId) {
    return NextResponse.json({ ok: false, error: "no_user" }, { status: 401 });
  }
  const effectiveUserId = scope === "user" ? userId : null;
  // A local model server's "key" is a web address the server calls: the
  // verified platform operator's only (lib/ai/workspace-account.ts, AIP-11).
  if (provider === "ollama") {
    const user = await getSessionUser();
    if (!(await mayUseLocalModel(user?.id, user?.email))) {
      return NextResponse.json({ ok: false, error: "local_model_not_allowed", message: LOCAL_MODEL_REFUSAL }, { status: 403 });
    }
  }

  const apiKeyPlain =
    typeof body?.api_key === "string" && body.api_key.trim() ? body.api_key.trim() : null;
  if (!apiKeyPlain) {
    return NextResponse.json({ ok: false, error: "missing_api_key" }, { status: 400 });
  }
  // Generous length cap — long enough for any real provider key, short enough
  // to refuse obvious paste accidents (entire scripts pasted by mistake).
  if (apiKeyPlain.length < 8 || apiKeyPlain.length > 400) {
    return NextResponse.json({ ok: false, error: "invalid_key_length" }, { status: 400 });
  }

  // Pick a default model — the first registry entry per provider IS the
  // recommended choice (balanced cost/quality), so a single-click flow can
  // safely fall through to it. Caller can override via body.model.
  const requestedModel = typeof body?.model === "string" ? body.model.trim() : "";
  const reg = PROVIDER_REGISTRY.find((p) => p.value === (provider as Provider));
  const defaultModel = reg?.models[0]?.id || "";
  const model = requestedModel || defaultModel;
  if (!model) {
    return NextResponse.json({ ok: false, error: "no_default_model" }, { status: 500 });
  }
  // Light validation: the requested model must be in the provider's known
  // registry. Prevents a typo from silently shipping an invalid model name
  // that the first chat turn will fail on.
  const providerModels = PROVIDER_MODELS[provider as Provider] || [];
  if (requestedModel && !providerModels.includes(requestedModel)) {
    return NextResponse.json(
      { ok: false, error: `unknown_model_for_provider:${provider}:${requestedModel}` },
      { status: 400 }
    );
  }

  // Read-only: is exactly this key saved now? The card asks this when a
  // connect's answer never came back (it timed out in the browser): the save
  // may have landed, so it says what is saved instead of guessing.
  if (body?.verify === true) {
    try {
      const saved = await keyIsSaved({ tenantId, userId, scope, provider, model, apiKey: apiKeyPlain });
      return NextResponse.json({ ok: true, saved });
    } catch (err) {
      console.error("[bulk-provider.verify]", { tenantId, provider, error: errText(err) });
      return NextResponse.json({ ok: false, error: "verify_failed", message: COULD_NOT_TELL }, { status: 503 });
    }
  }

  // Resolve target agent set. Caller-supplied list takes precedence; otherwise
  // fall back to the profile's enabled agents. If neither is populated, fall
  // back to the full chat-eligible set — operators on a fresh tenant want
  // every agent wired in one shot.
  const requestedAgents = Array.isArray(body?.agent_keys)
    ? (body.agent_keys as unknown[]).filter((s): s is string => typeof s === "string").map((s) => s.toLowerCase())
    : null;
  // Manifest-aware fallback + allowlist. Empire-wide chat keys is the
  // last-resort default (mid-onboarding tenants with no manifest); manifest-
  // declared custom slugs (e.g. "renewal_specialist") are accepted as
  // targets now. Codex Finding #2 (2026-05-22).
  const tenantChatKeys = await getTenantChatAgentKeys(tenantId);
  const fallbackAgents =
    profileEnabledAgents.length > 0 ? profileEnabledAgents : tenantChatKeys;
  const chatAllowed = new Set(tenantChatKeys);
  const targetAgents = Array.from(
    new Set((requestedAgents || fallbackAgents).map((k) => resolveAgentKey(k))),
  ).filter((k) => chatAllowed.has(k));
  // A team-wide connect always has its target: the workspace's AI account
  // below. A personal one has nothing to save without an agent row.
  if (scope === "user" && targetAgents.length === 0) {
    return NextResponse.json({ ok: false, error: "no_target_agents" }, { status: 400 });
  }

  let encryptedKey: string;
  try {
    encryptedKey = encryptField(apiKeyPlain);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "encrypt_failed" },
      { status: 500 }
    );
  }

  // ONE STEP (lib/ai/workspace-account.ts): every row this connect writes
  // lands together, or none does. Nothing is written row by row, so nothing
  // is ever left half-saved and nothing needs cleaning up after a race.
  let applied = targetAgents;
  if (scope === "user") {
    try {
      await savePersonalKeyInOneStep({ tenantId, userId: userId!, provider, model, encryptedApiKey: encryptedKey, agentKeys: targetAgents });
    } catch (err) {
      console.error("[bulk-provider.personal_save]", { tenantId, provider, error: errText(err) });
      return NextResponse.json({ ok: false, error: "save_failed", message: NOT_SAVED }, { status: 500 });
    }
  } else {
    const thisKey = { provider, model, apiKey: apiKeyPlain };
    let outcome: { committed: boolean; legacyRowMoved: boolean };
    try {
      let stamp = await readAccountStamp(tenantId);
      outcome = await connectWorkspaceAccountInOneStep({ tenantId, stamp, provider, model, encryptedApiKey: encryptedKey, agentKeys: targetAgents });
      if (!outcome.committed) {
        // The account changed after the read. When it now holds this very key
        // (a retry of this connect, or another window saving the same key),
        // this connect is written again on top of it, which changes nothing
        // and stamps this request's rows too. Anything else is someone else's
        // change, and it stands.
        stamp = await readAccountStamp(tenantId);
        if (stampHoldsKey(stamp, thisKey)) {
          outcome = await connectWorkspaceAccountInOneStep({ tenantId, stamp, provider, model, encryptedApiKey: encryptedKey, agentKeys: targetAgents });
        }
      }
    } catch (err) {
      console.error("[bulk-provider.connect]", { tenantId, provider, error: errText(err) });
      return NextResponse.json({ ok: false, error: "save_failed", message: NOT_SAVED }, { status: 500 });
    }
    if (!outcome.committed) {
      return NextResponse.json({ ok: false, error: "conflict", message: CONNECT_CONFLICT }, { status: 409 });
    }
    if (outcome.legacyRowMoved) applied = [...targetAgents, LEGACY_WORKSPACE_AI_AGENT_KEY];
  }

  try {
    const authed = await getAuthedSupabase();
    await authed.rpc("log_tenant_event", {
      p_tenant_id: tenantId,
      p_action_type: scope === "user" ? "agent_config.user_update" : "agent_config.tenant_update",
      p_target_table: "agent_model_config",
      p_target_id: `${tenantId}:${effectiveUserId || "tenant"}:${provider}:bulk`,
      p_after: {
        provider,
        model,
        scope,
        workspace_account: scope === "tenant",
        applied_to: applied,
        has_key: true,
      },
    });
  } catch {
    // audit-log soft-fail
  }

  return NextResponse.json({
    ok: true,
    scope,
    workspace_account: scope === "tenant",
    applied_to: applied,
    failed: [],
    count: applied.length,
  });
}

/**
 * DELETE /api/agent-config/bulk-provider?provider=openrouter&scope=tenant
 *
 * Inverse of POST — disconnects a provider across every agent in the tenant
 * (or just the caller's per-user override row when scope=user). Operators
 * use this to revoke a connected provider before re-pasting a new key or
 * switching providers entirely. Without this they could only paste a new
 * key on top, leaving the old one encrypted-at-rest forever. scope=tenant
 * removes every workspace row (user_id IS NULL) on that provider and RETIRES
 * the workspace's AI account row when it is on that provider (its key is
 * wiped and it is switched off, but the row stays, so an older legacy row can
 * never answer for the workspace again: lib/ai/workspace-account.ts, DISCONNECT
 * KEEPS THE ROW), in ONE step: all of it, or none of it. If another window
 * changed the account meanwhile, nothing is removed and the answer is 409.
 *
 * Query: provider=<provider>&scope=tenant|user
 * Returns: { ok, scope, provider, count } (count = rows removed). Every non-ok
 * answer carries one plain `message`, the only thing the card shows: never a
 * code or the database's own words (PR #535 review).
 */
export async function DELETE(req: NextRequest) {
  const { tenantId, userId, canManageTenant } = await resolveTenant();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized", message: SIGNED_OUT }, { status: 401 });
  }
  const url = req.nextUrl;
  const provider = String(url.searchParams.get("provider") || "");
  if (!Object.keys(PROVIDER_MODELS).includes(provider)) {
    return NextResponse.json(
      { ok: false, error: `invalid_provider:${provider}`, message: "That AI provider can't be disconnected here." },
      { status: 400 },
    );
  }
  const scope = url.searchParams.get("scope") === "user" ? "user" : "tenant";
  if (scope === "tenant" && !canManageTenant) {
    return NextResponse.json(
      { ok: false, error: "admin_required", message: "Only an owner or admin can disconnect the team's AI account." },
      { status: 403 },
    );
  }
  if (scope === "user" && !userId) {
    return NextResponse.json({ ok: false, error: "no_user", message: SIGNED_OUT }, { status: 401 });
  }
  let count = 0;
  if (scope === "user") {
    // One statement: the person's own rows on this provider.
    const deleted = await getServiceSupabase()
      .from("agent_model_config")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("provider", provider)
      .eq("user_id", userId!)
      .select("agent_key");
    if (deleted.error) {
      console.error("[bulk-provider.personal_disconnect]", { tenantId, provider, error: deleted.error.code || deleted.error.message });
      return NextResponse.json({ ok: false, error: "disconnect_failed", message: DISCONNECT_FAILED }, { status: 500 });
    }
    count = Array.isArray(deleted.data) ? deleted.data.length : 0;
  } else {
    let outcome: { committed: boolean; removed: number };
    try {
      const stamp = await readAccountStamp(tenantId);
      outcome = await disconnectWorkspaceAccountInOneStep({ tenantId, stamp, provider });
    } catch (err) {
      console.error("[bulk-provider.disconnect]", { tenantId, provider, error: errText(err) });
      return NextResponse.json({ ok: false, error: "disconnect_failed", message: DISCONNECT_FAILED }, { status: 500 });
    }
    if (!outcome.committed) {
      return NextResponse.json({ ok: false, error: "conflict", message: DISCONNECT_CONFLICT }, { status: 409 });
    }
    count = outcome.removed;
  }

  // Audit-log the disconnect.
  try {
    const authed = await getAuthedSupabase();
    await authed.rpc("log_tenant_event", {
      p_tenant_id: tenantId,
      p_action_type:
        scope === "user"
          ? "agent_config.user_disconnect"
          : "agent_config.tenant_disconnect",
      p_target_table: "agent_model_config",
      p_target_id: `${tenantId}:${scope === "user" ? userId : "tenant"}:${provider}`,
    });
  } catch {
    // audit-log soft-fail
  }

  return NextResponse.json({ ok: true, scope, provider, count });
}
