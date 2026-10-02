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
 *   - scope=tenant ALWAYS saves the workspace's AI account first (lib/ai/
 *     workspace-account.ts, agent_key "__workspace__"): the account every
 *     department chat and Slack mention answers on, whatever teammates the
 *     workspace has. Before this, a client whose teammates are neutral leads
 *     got rows nobody read, and every chat said "No AI account is connected"
 *     (AIP-01). If that save fails, nothing else is written.
 *   - Resolves the agent set: explicit `agent_keys[]` if supplied,
 *     otherwise the tenant's enabled chat-eligible agents.
 *   - Upserts (provider, model, encrypted_api_key) for each agent.
 *     Existing per-agent customizations (system_prompt_override, etc.)
 *     are preserved — only the provider/model/key triple is replaced.
 *   - Defaults model to the provider's first registry entry (the
 *     recommended one) unless the caller passed a specific model.
 *   - Provider "ollama" (a local model server, whose "key" is a web address
 *     the server calls) is the verified platform operator's only (403).
 *
 * Body shape:
 *   {
 *     provider: "anthropic" | "openai" | "google" | "openrouter",
 *     api_key: string,                    // required, encrypted server-side
 *     model?: string,                     // optional, default = first registry entry
 *     agent_keys?: string[]               // optional, default = enabled agents
 *   }
 *
 * Returns: { ok, scope, workspace_account, applied_to: [agent_key,...], failed, count }
 *   ok is the workspace account saved (scope=tenant), or at least one personal
 *   row saved (scope=user).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthedSupabase, getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { PROVIDER_MODELS, PROVIDER_REGISTRY, type Provider } from "@/lib/providers";
import { encryptField } from "@/lib/field-encryption";
import { getTenantChatAgentKeys } from "@/lib/manifest/tenant-scope";
import { canManageTeam, getSessionContext } from "@/lib/team";
import { resolveAgentKey } from "@/lib/agents";
import { LOCAL_MODEL_REFUSAL, mayUseLocalModel, saveWorkspaceAiAccount } from "@/lib/ai/workspace-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

  // The workspace's AI account (lib/ai/workspace-account.ts), written first and
  // never filtered by the teammate list: it is the row every department chat
  // and Slack mention answers on. If it cannot be saved, nothing else is.
  if (scope === "tenant") {
    const saved = await saveWorkspaceAiAccount(tenantId, {
      provider: provider as Provider,
      model,
      encryptedApiKey: encryptedKey,
    });
    if (!saved.ok) {
      console.error("[bulk-provider.workspace_account]", { tenantId, provider, error: saved.error });
      return NextResponse.json(
        { ok: false, error: "save_failed", message: "The key could not be saved just now. Nothing was changed. Try again in a moment." },
        { status: 500 },
      );
    }
  }

  const service = getServiceSupabase();
  const applied: string[] = [];
  const failed: Array<{ agent_key: string; error: string }> = [];
  // Sequential — Supabase upsert with onConflict isn't reliable across the
  // current PostgREST setup for compound keys (we'd need a real unique
  // index on (tenant_id, agent_key)). Doing it as N small writes is fine
  // — N is bounded by chat-eligible agent count (5-ish today).
  //
  // Partial-failure semantics: if any agent fails to save, the response
  // surfaces the failing agents + their error codes (logged by the card,
  // never shown as slugs). For a team-wide connect the workspace account above
  // is what makes the chats work, so ok is true once it saved; for a personal
  // one, ok is true iff at least one row saved.
  for (const agentKey of targetAgents) {
    let lookupQ = service
      .from("agent_model_config")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("agent_key", agentKey);
    lookupQ = effectiveUserId
      ? lookupQ.eq("user_id", effectiveUserId)
      : lookupQ.is("user_id", null);
    const { data: existing, error: lookupErr } = await lookupQ.maybeSingle();
    if (lookupErr) {
      failed.push({ agent_key: agentKey, error: `lookup_failed:${lookupErr.code || lookupErr.message}` });
      continue;
    }
    const payload: Record<string, unknown> = {
      tenant_id: tenantId,
      user_id: effectiveUserId,
      agent_key: agentKey,
      provider,
      model,
      enabled: true,
      encrypted_api_key: encryptedKey,
    };
    if (existing) {
      const { error } = await service
        .from("agent_model_config")
        .update(payload)
        .eq("id", existing.id);
      if (error) failed.push({ agent_key: agentKey, error: error.code || error.message });
      else applied.push(agentKey);
    } else {
      const { error } = await service.from("agent_model_config").insert(payload);
      if (error) failed.push({ agent_key: agentKey, error: error.code || error.message });
      else applied.push(agentKey);
    }
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
        failed,
        has_key: scope === "tenant" || applied.length > 0,
      },
    });
  } catch {
    // audit-log soft-fail
  }

  return NextResponse.json({
    ok: scope === "tenant" || applied.length > 0,
    scope,
    workspace_account: scope === "tenant",
    applied_to: applied,
    failed,
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
 * removes every workspace row (user_id IS NULL) on that provider, the
 * workspace's AI account row among them.
 *
 * Query: provider=<provider>&scope=tenant|user
 * Returns: { ok, scope, provider, count }
 */
export async function DELETE(req: NextRequest) {
  const { tenantId, userId, canManageTenant } = await resolveTenant();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl;
  const provider = String(url.searchParams.get("provider") || "");
  if (!Object.keys(PROVIDER_MODELS).includes(provider)) {
    return NextResponse.json(
      { ok: false, error: `invalid_provider:${provider}` },
      { status: 400 },
    );
  }
  const scope = url.searchParams.get("scope") === "user" ? "user" : "tenant";
  if (scope === "tenant" && !canManageTenant) {
    return NextResponse.json({ ok: false, error: "admin_required" }, { status: 403 });
  }
  if (scope === "user" && !userId) {
    return NextResponse.json({ ok: false, error: "no_user" }, { status: 401 });
  }
  const service = getServiceSupabase();
  let q = service
    .from("agent_model_config")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("provider", provider);
  q = scope === "user" ? q.eq("user_id", userId!) : q.is("user_id", null);
  const { error, count } = await q.select("agent_key");
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
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

  return NextResponse.json({ ok: true, scope, provider, count: count ?? 0 });
}
