/**
 * Shared chat-auth resolver — given a Supabase user + agent key, returns
 * the resolved provider/model/api_key/system_prompt_override the chat
 * routes need to dispatch a turn. Single home for what used to be
 * duplicated character-for-character between /api/chat and
 * /api/chat/resume (Phase 2 of giggly-reef caught this).
 *
 * Auth priority — strict resolution hierarchy. The first match wins:
 *
 *   1. USER OVERRIDE  (agent_model_config row where user_id = caller.id):
 *      Per-employee override. Set when a teammate pastes their own key
 *      under "Just-for-me overrides" in Settings. If this row has an
 *      encrypted_api_key, that key + its provider/model are used and
 *      cfgScope is "user".
 *
 *   2. TENANT DEFAULT (agent_model_config row where user_id IS NULL):
 *      Workspace-wide default. Set by "AI Setup" (bulk-provider writes
 *      identical rows for every enabled chat agent) and by per-agent
 *      "Override an Agent's Provider" edits at scope=tenant. Used when
 *      no user override exists. cfgScope is "tenant".
 *
 *   3. PLATFORM FALLBACK (operatorPlatformFallback env var):
 *      Last-resort default for the platform operator's email only.
 *      Used when:
 *        - No row exists at all (fresh tenant pre-AI-setup), OR
 *        - A row exists but its encrypted_api_key is null.
 *      Non-operator users in either of those states get a typed error
 *      (412 agent_not_configured / no_api_key) so they can't accidentally
 *      bill the platform owner's key.
 *
 * Returns a discriminated union so callers don't have to remember which
 * NextResponse status maps to which error code.
 */

import type { Provider } from "./providers";
import { getServiceSupabase } from "./supabase-server";
import { decryptField } from "./field-encryption";
import { isOperatorEmail, operatorPlatformFallback } from "./operator-credentials";

export type ChatAuthContext = {
  tenantId: string;
  provider: Provider;
  model: string;
  apiKey: string;
  /** Per-agent system prompt override, if the operator set one in
   *  Settings → Agents. Null otherwise (use the default persona). */
  cfgOverride: string | null;
  /** True when the user matches isOperatorEmail. Useful for routes that
   *  want to grant operator-only features beyond what auth covers. */
  isOperator: boolean;
  /** Which config row actually supplied the model/key, if any. */
  cfgScope: "user" | "tenant" | null;
};

export type ChatAuthError = {
  status: 401 | 403 | 412 | 500;
  code:
    | "no_tenant"
    | "agent_disabled"
    | "no_api_key"
    | "agent_not_configured"
    | "admin_no_platform_key"
    | "key_decrypt_failed";
  detail?: string;
};

export type ChatAuthResult =
  | ({ ok: true } & ChatAuthContext)
  | ({ ok: false } & ChatAuthError);

/**
 * Resolve the chat context for (authed user, agent_key). Returns a
 * structured result — callers map ok=false to a JSON error response.
 *
 * Caller must have already validated agent_key against chatAgentKeys();
 * this helper trusts the input and only handles the auth/tenant/key plumbing.
 */
export async function resolveChatContext(
  user: { id: string; email: string | null | undefined },
  agentKey: string,
): Promise<ChatAuthResult> {
  const service = getServiceSupabase();

  const { data: profileRow } = await service
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profileRow as { tenant_id: string | null } | null)?.tenant_id ?? null;
  if (!tenantId) {
    return { ok: false, status: 403, code: "no_tenant" };
  }

  // Phase B (per-user agent config, 2026-05-17): prefer the user-scoped
  // override row before falling back to the tenant default. Migration 052
  // added the user_id column + partial unique indexes that let both rows
  // coexist. The resolver semantics live in lib/agent-resolver.ts; the
  // two-step lookup is inlined here to keep the chat-auth path on one
  // service-role client + minimize round-trips.
  const userOverride = await service
    .from("agent_model_config")
    .select("provider, model, encrypted_api_key, system_prompt_override, enabled")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("agent_key", agentKey)
    .maybeSingle();

  const tenantDefault = userOverride.data?.encrypted_api_key
    ? { data: null as null }
    : await service
        .from("agent_model_config")
        .select("provider, model, encrypted_api_key, system_prompt_override, enabled")
        .eq("tenant_id", tenantId)
        .is("user_id", null)
        .eq("agent_key", agentKey)
        .maybeSingle();

  const cfg = userOverride.data?.encrypted_api_key ? userOverride.data : tenantDefault.data;
  const cfgScope: "user" | "tenant" | null = userOverride.data?.encrypted_api_key
    ? "user"
    : tenantDefault.data
      ? "tenant"
      : null;

  const isOperator = isOperatorEmail(user.email || "");
  let provider: Provider;
  let model: string;
  let apiKey = "";
  let cfgOverride: string | null = null;

  if (cfg) {
    if (!cfg.enabled) {
      return { ok: false, status: 403, code: "agent_disabled" };
    }
    provider = cfg.provider as Provider;
    model = cfg.model as string;
    cfgOverride = (cfg.system_prompt_override as string | null) || null;
    if (!cfg.encrypted_api_key) {
      // Row exists but key wasn't set — try operator fallback before failing.
      const fallback = isOperator ? operatorPlatformFallback() : null;
      if (!fallback) {
        return { ok: false, status: 412, code: "no_api_key" };
      }
      provider = fallback.provider;
      model = fallback.model;
      apiKey = fallback.apiKey;
    } else {
      try {
        apiKey = decryptField(cfg.encrypted_api_key as string);
      } catch (err) {
        return {
          ok: false,
          status: 500,
          code: "key_decrypt_failed",
          detail: err instanceof Error ? err.message : "key_decrypt_failed",
        };
      }
    }
  } else {
    // No per-agent row at all.
    const fallback = isOperator ? operatorPlatformFallback() : null;
    if (!fallback) {
      return {
        ok: false,
        status: 412,
        code: isOperator ? "admin_no_platform_key" : "agent_not_configured",
      };
    }
    provider = fallback.provider;
    model = fallback.model;
    apiKey = fallback.apiKey;
  }

  return {
    ok: true,
    tenantId,
    provider,
    model,
    apiKey,
    cfgOverride,
    isOperator,
    cfgScope,
  };
}
