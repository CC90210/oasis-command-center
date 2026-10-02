/**
 * lib/ai/workspace-account.ts - the ONE AI account a workspace connects, and
 * the one place every surface reads it from, to use it or to say whether it
 * is connected.
 *
 * WHY (AIP-01, AIP-02, AIP-10). Settings > AI brain stamped a pasted key onto
 * one agent_model_config row per enabled teammate, but every department chat
 * and Slack mention read only the `bravo` row. A client workspace's teammates
 * are neutral leads (sdr, customer-support, ...), so its owner pasted a key,
 * the card turned green, and every department chat still answered "No AI
 * account is connected". "Connected" also counted any saved key, a teammate's
 * personal one included, so the card and the chats disagreed.
 *
 * THE ROW. agent_model_config with agent_key WORKSPACE_AI_AGENT_KEY
 * ("__workspace__") and user_id IS NULL. The team-wide connect
 * (app/api/agent-config/bulk-provider) writes it on every connect, whatever
 * teammates the workspace has. No migration: the partial unique index
 * idx_agent_model_config_default_per_agent (tenant_id, agent_key) WHERE
 * user_id IS NULL keeps it one row per workspace, and agent_key has no CHECK.
 * It is not a teammate: the agent-config routes never list it or accept it as
 * one.
 *
 * DISCONNECT KEEPS THE ROW. Disconnecting the account's provider RETIRES the
 * row (retireWorkspaceAiAccount: key wiped, switched off) instead of deleting
 * it. The row is the record that this workspace connected through Settings,
 * so the legacy row below can never answer for it again: deleting it would
 * have revived whatever older key was still on the legacy row (Codex review,
 * PR #535). A retired row is not usable, so every surface says not connected,
 * and the next connect simply fills it in again.
 *
 * THE LEGACY ROW. A workspace with NO __workspace__ row (live or retired)
 * answers on its `bravo` workspace row, the row every channel read before this
 * file. That is how OASIS's own workspace keeps answering exactly as it does
 * today until someone connects an account for it here (which key OASIS's
 * default AI uses is decision D12), and how a workspace that saved a key
 * before this change keeps working until the backfill copies it.
 *
 * A LOCAL MODEL ACCOUNT. Provider "ollama" is a server address, not a key. A
 * row with it answers only for the verified platform operator, at every
 * reader (see LOCAL_MODEL_PROVIDER); lib/providers.ts refuses to call one
 * without that verdict too.
 *
 * WHO READS IT (all through readWorkspaceAiAccount, so they cannot disagree):
 *   - lib/os/department-agent.ts prepareAgentTurn: every department chat,
 *     direct agent chat and Slack mention;
 *   - components/os/department/channel.ts providerReady: is a channel ready;
 *   - app/api/agent-config/test-connection: "Test" on the saved key;
 *   - lib/queries.ts aiServicesWithKey: "Connected" in Settings, the setup
 *     checklist, Health and the integrations page;
 *   - the agent builder and the manifest editor (readPersonAiAccount), after
 *     a key the person saved for their own chats.
 *
 * A failed read THROWS, naming the table and never the tenant: "couldn't
 * check" is never "not connected".
 */
import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { isPlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { PROVIDER_TO_SERVICE, type Provider } from "@/lib/providers";

/** The agent_model_config.agent_key of the workspace's AI account row. */
export const WORKSPACE_AI_AGENT_KEY = "__workspace__";

/** The row channels read before the account row existed (OASIS still answers on it). */
export const LEGACY_WORKSPACE_AI_AGENT_KEY = "bravo";

/**
 * Provider "ollama" is a local model server: its "key" is a web address the
 * server itself calls (lib/agents/provider-probe.ts, lib/providers.ts). Anyone
 * allowed to save, test OR USE one could make the server call any address
 * (AIP-11), so only the verified platform operator may: the agent-config
 * routes refuse to save or test it, and every reader that turns a saved row
 * into a request refuses it too (a row saved before that rule, or by another
 * path, must not answer for anyone else). Everyone else gets this sentence.
 */
export const LOCAL_MODEL_PROVIDER = "ollama";
export const LOCAL_MODEL_REFUSAL = "Local AI models can't be connected here. Connect a cloud AI account instead.";

/** Whether this signed-in person may save, test or use a local model server (see LOCAL_MODEL_REFUSAL). */
export async function mayUseLocalModel(authUserId: string | null | undefined, email: string | null | undefined): Promise<boolean> {
  return isPlatformOperatorForAuthUser(authUserId, email);
}

export type WorkspaceAiAccount = {
  /**
   * Which row answered: the account row, the legacy `bravo` workspace row, or
   * (readPersonAiAccount only) the person's own key.
   */
  source: "workspace" | "legacy" | "personal";
  provider: Provider;
  model: string;
  encryptedApiKey: string | null;
  enabled: boolean;
};

/** An account the channels would really send: switched on, with a key. */
export type UsableAiAccount = WorkspaceAiAccount & { encryptedApiKey: string };

type ConfigRow = {
  agent_key?: string | null;
  provider: string | null;
  model: string | null;
  encrypted_api_key: string | null;
  enabled: unknown;
};

/** SQLite has no boolean: true, 1 and "1" are on (lib/turso-postgrest.ts). */
function isOn(value: unknown): boolean {
  return value === true || Number(value) === 1;
}

function accountFrom(row: ConfigRow, source: WorkspaceAiAccount["source"]): WorkspaceAiAccount {
  return {
    source,
    provider: String(row.provider || "") as Provider,
    model: String(row.model || ""),
    encryptedApiKey: row.encrypted_api_key || null,
    enabled: isOn(row.enabled),
  };
}

/** True when the account is on and holds a key: the only "connected". */
export function hasUsableKey(account: WorkspaceAiAccount | null | undefined): account is UsableAiAccount {
  return !!account && account.enabled && !!account.encryptedApiKey;
}

/**
 * The workspace's AI account: its __workspace__ row, else its legacy `bravo`
 * workspace row, else null. Never a teammate's personal key. Throws when the
 * read fails.
 */
export async function readWorkspaceAiAccount(tenantId: string): Promise<WorkspaceAiAccount | null> {
  const { data, error } = await getServiceSupabase()
    .from("agent_model_config")
    .select("agent_key, provider, model, encrypted_api_key, enabled")
    .eq("tenant_id", tenantId)
    .is("user_id", null)
    .in("agent_key", [WORKSPACE_AI_AGENT_KEY, LEGACY_WORKSPACE_AI_AGENT_KEY]);
  if (error) throw new Error(`workspace AI account: agent_model_config read failed: ${error.message}`);
  const rows = (data || []) as ConfigRow[];
  const account = rows.find((r) => r.agent_key === WORKSPACE_AI_AGENT_KEY);
  if (account) return accountFrom(account, "workspace");
  const legacy = rows.find((r) => r.agent_key === LEGACY_WORKSPACE_AI_AGENT_KEY);
  return legacy ? accountFrom(legacy, "legacy") : null;
}

/**
 * The key a signed-in person's own AI tools answer on (the agent builder, the
 * manifest editor): a key they saved for their own chats, as before, else the
 * workspace's AI account. null = neither is usable. Throws when a read fails.
 */
export async function readPersonAiAccount(tenantId: string, userId: string): Promise<UsableAiAccount | null> {
  const { data, error } = await getServiceSupabase()
    .from("agent_model_config")
    .select("provider, model, encrypted_api_key, enabled")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("agent_key", LEGACY_WORKSPACE_AI_AGENT_KEY)
    .maybeSingle();
  if (error) throw new Error(`personal AI key: agent_model_config read failed: ${error.message}`);
  const own = data ? accountFrom(data as ConfigRow, "personal") : null;
  if (hasUsableKey(own)) return own;
  const account = await readWorkspaceAiAccount(tenantId);
  return hasUsableKey(account) ? account : null;
}

/**
 * The AI services (lib/providers.ts PROVIDER_TO_SERVICE slugs) this person has
 * a key on file for in their OWN rows (user_id = them). Department chats and
 * Slack never use these, so they are reported apart from the workspace
 * account. Throws when the read fails.
 */
export async function readPersonalAiServices(tenantId: string, userId: string): Promise<Set<string>> {
  const { data, error } = await getServiceSupabase()
    .from("agent_model_config")
    .select("provider, encrypted_api_key, enabled")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId);
  if (error) throw new Error(`personal AI keys: agent_model_config read failed: ${error.message}`);
  const out = new Set<string>();
  for (const row of (data || []) as ConfigRow[]) {
    if (!row.encrypted_api_key || !isOn(row.enabled)) continue;
    const service = PROVIDER_TO_SERVICE[String(row.provider || "")];
    if (service) out.add(service);
  }
  return out;
}

/**
 * Save the workspace's AI account (the team-wide connect): update its row, or
 * insert it. A concurrent connect that inserted first (the partial unique
 * index refuses a second row) is updated instead. Never throws.
 */
export async function saveWorkspaceAiAccount(
  tenantId: string,
  account: { provider: Provider; model: string; encryptedApiKey: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const payload = {
    tenant_id: tenantId,
    user_id: null,
    agent_key: WORKSPACE_AI_AGENT_KEY,
    provider: account.provider,
    model: account.model,
    enabled: true,
    encrypted_api_key: account.encryptedApiKey,
  };
  const findRow = () =>
    db
      .from("agent_model_config")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("agent_key", WORKSPACE_AI_AGENT_KEY)
      .is("user_id", null)
      .maybeSingle();
  try {
    const found = await findRow();
    if (found.error) return { ok: false, error: `lookup_failed:${found.error.code || found.error.message}` };
    const update = async (id: string) => {
      const { error } = await db.from("agent_model_config").update(payload).eq("id", id);
      return error ? { ok: false as const, error: error.code || error.message } : { ok: true as const };
    };
    const existing = found.data as { id: string } | null;
    if (existing?.id) return await update(existing.id);
    const inserted = await db.from("agent_model_config").insert(payload);
    if (!inserted.error) return { ok: true };
    const again = await findRow();
    const raced = again.data as { id: string } | null;
    if (!again.error && raced?.id) return await update(raced.id);
    return { ok: false, error: inserted.error.code || inserted.error.message };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The team-wide disconnect of `provider`: when the workspace's account is on
 * it, wipe its key and switch it off, and KEEP the row (see DISCONNECT KEEPS
 * THE ROW above). A workspace with no account row (OASIS until someone
 * connects one here) gets none: nothing changes for it. Never throws.
 */
export async function retireWorkspaceAiAccount(
  tenantId: string,
  provider: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { error } = await getServiceSupabase()
      .from("agent_model_config")
      .update({ enabled: false, encrypted_api_key: null })
      .eq("tenant_id", tenantId)
      .eq("agent_key", WORKSPACE_AI_AGENT_KEY)
      .is("user_id", null)
      .eq("provider", provider);
    return error ? { ok: false, error: error.code || error.message } : { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
