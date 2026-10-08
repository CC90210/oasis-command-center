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
 *      Last-resort default for the VERIFIED platform operator only
 *      (lib/platform-operator.ts — an alias email is not enough).
 *      Used when:
 *        - No row exists at all (fresh tenant pre-AI-setup), OR
 *        - A row exists but its encrypted_api_key is null.
 *      Non-operator users in either of those states get a typed error
 *      (412 agent_not_configured / no_api_key) so they can't accidentally
 *      bill the platform owner's key.
 *
 * A LOCAL MODEL ROW (provider "ollama": its "key" is a web address the server
 * would call) answers for the verified platform operator only. Anyone else's
 * turn on such a row, personal or workspace, is refused 403
 * local_model_not_allowed before any request is made (Codex review, PR #535):
 * a row saved before the save-time rule, or by any other path, must not make
 * the server call an address for them.
 *
 * Returns a discriminated union so callers don't have to remember which
 * NextResponse status maps to which error code.
 */

import type { Provider } from "./providers";
import { getServiceSupabase } from "./supabase-server";
import { decryptField } from "./field-encryption";
import { operatorPlatformFallback } from "./operator-credentials";
import { isPlatformOperatorForAuthUser } from "./platform-operator";
import { LOCAL_MODEL_PROVIDER, LOCAL_MODEL_REFUSAL } from "./ai/workspace-account";

export type ChatAuthContext = {
  tenantId: string;
  provider: Provider;
  model: string;
  apiKey: string;
  /** Per-agent system prompt override, if the operator set one in
   *  Settings → Agents. Null otherwise (use the default persona). */
  cfgOverride: string | null;
  /** Per-user display-name override (Settings → My Agents). When set,
   *  the agent self-identifies with this name on user-facing surfaces
   *  (chat header, persona self-introduction). Backend daemon logs
   *  still use the canonical agent name. Null = canonical name. */
  displayNameOverride: string | null;
  /** True when the user passed the VERIFIED platform-operator check
   *  (lib/platform-operator.ts: alias AND owner/admin OASIS membership by
   *  auth id). Routes that grant operator-only features beyond what auth
   *  covers read this rather than re-deriving it. */
  isOperator: boolean;
  /** Which config row actually supplied the model/key, if any. */
  cfgScope: "user" | "tenant" | null;
  /**
   * Who pays for the key: "tenant" (a key the workspace or the teammate saved)
   * or "platform" (OASIS's platform key, verified operator only). The AI usage
   * ledger records it as billing_mode (lib/ai/usage.ts billingForKey).
   * cfgScope cannot say this: a config row with no key still names its scope.
   */
  keySource: "tenant" | "platform";
};

export type ChatAuthError = {
  status: 401 | 403 | 412 | 500;
  code:
    | "no_tenant"
    | "agent_disabled"
    | "no_api_key"
    | "agent_not_configured"
    | "admin_no_platform_key"
    | "key_decrypt_failed"
    | "local_model_not_allowed";
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
    .select("provider, model, encrypted_api_key, system_prompt_override, display_name_override, enabled")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("agent_key", agentKey)
    .maybeSingle();

  const tenantDefault = userOverride.data?.encrypted_api_key
    ? { data: null as null }
    : await service
        .from("agent_model_config")
        .select("provider, model, encrypted_api_key, system_prompt_override, display_name_override, enabled")
        .eq("tenant_id", tenantId)
        .is("user_id", null)
        .eq("agent_key", agentKey)
        .maybeSingle();

  // display_name_override is a USER-level concept; we only honour it
  // from the user row, never the tenant default. If the user hasn't
  // set a rename, the canonical persona name applies — even if a
  // tenant-default row exists for the same agent.
  const displayNameOverride: string | null =
    (userOverride.data?.display_name_override as string | null) || null;

  const cfg = userOverride.data?.encrypted_api_key ? userOverride.data : tenantDefault.data;
  const cfgScope: "user" | "tenant" | null = userOverride.data?.encrypted_api_key
    ? "user"
    : tenantDefault.data
      ? "tenant"
      : null;

  // Keyed on the auth user, not the email alone: the platform key bills OASIS,
  // and anyone could register an unclaimed alias. Fails closed (logged).
  const isOperator = await isPlatformOperatorForAuthUser(user.id, user.email);
  let provider: Provider;
  let model: string;
  let apiKey = "";
  let cfgOverride: string | null = null;
  let keySource: "tenant" | "platform" = "tenant";

  if (cfg) {
    if (!cfg.enabled) {
      return { ok: false, status: 403, code: "agent_disabled" };
    }
    provider = cfg.provider as Provider;
    model = cfg.model as string;
    cfgOverride = (cfg.system_prompt_override as string | null) || null;
    if (provider === LOCAL_MODEL_PROVIDER && cfg.encrypted_api_key && !isOperator) {
      return { ok: false, status: 403, code: "local_model_not_allowed", detail: LOCAL_MODEL_REFUSAL };
    }
    if (!cfg.encrypted_api_key) {
      // Row exists but key wasn't set — try operator fallback before failing.
      const fallback = isOperator ? operatorPlatformFallback() : null;
      if (!fallback) {
        return { ok: false, status: 412, code: "no_api_key" };
      }
      provider = fallback.provider;
      model = fallback.model;
      apiKey = fallback.apiKey;
      keySource = "platform";
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
    keySource = "platform";
  }

  return {
    ok: true,
    tenantId,
    provider,
    model,
    apiKey,
    cfgOverride,
    displayNameOverride,
    isOperator,
    cfgScope,
    keySource,
  };
}

/**
 * A chat session id from a request body, kept only when that session is the
 * caller's own: this workspace's (from the session, never the body) and this
 * person's, the same pair /api/chat/sessions lists by. Anything else (another
 * workspace's id, a teammate's, a made-up one, or a failed read) comes back
 * null, so the turn opens a new session instead of writing into someone else's
 * and filing its AI usage under that id.
 */
export async function ownedChatSessionId(
  sessionId: unknown,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  if (typeof sessionId !== "string" || !sessionId.trim()) return null;
  const owner = await chatSessionOwner(sessionId, tenantId, userId);
  if (owner.state === "unavailable") {
    console.error("[chat-auth] could not check a chat session's owner; opening a new one", { tenantId, error: owner.error });
    return null;
  }
  if (owner.state === "not_owned") {
    console.error("[chat-auth] a chat session id that is not the caller's was refused; opening a new one", { tenantId });
    return null;
  }
  return sessionId;
}

/**
 * Whether a chat session is the caller's own, with a failed read kept apart
 * from "not yours": "owned" (this workspace's and this person's), "not_owned"
 * (another workspace's or person's, or no such session, e.g. deleted), or
 * "unavailable" (the read failed, so nobody knows). /api/chat can open a new
 * session on anything but "owned"; /api/chat/resume cannot, because a resumed
 * turn belongs to the session its signed state names, so it refuses instead.
 */
export async function chatSessionOwner(
  sessionId: string,
  tenantId: string,
  userId: string,
): Promise<{ state: "owned" } | { state: "not_owned" } | { state: "unavailable"; error: string }> {
  const { data, error } = await getServiceSupabase()
    .from("chat_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { state: "unavailable", error: error.message };
  return data ? { state: "owned" } : { state: "not_owned" };
}
