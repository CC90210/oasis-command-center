/**
 * lib/ai/agent-engine-store.ts - where the workspace's engine choice
 * (lib/ai/agent-engine.ts) and its saved provider keys live.
 *
 * THE ENGINE ROW: agent_model_config agent_key "__engine__", user_id NULL, no
 * key (see lib/ai/agent-engine.ts THE ROW). One row per workspace through the
 * partial unique index idx_agent_model_config_default_per_agent.
 *
 * SAVED KEYS (CC, 2026-10-09: "I can't switch between different providers").
 * The workspace AI account holds ONE provider and key at a time, and a connect
 * moves every team row off the previous key, so switching from Google to
 * Anthropic and back meant pasting the Google key again. Now a switch made in
 * AI brain (app/api/agent-config/workspace-provider) keeps the key it moves
 * away from (and the one it moves to) on its own row, agent_key
 * "__key:<provider>", user_id NULL, encrypted SEPARATELY (its own ciphertext).
 * A card's Connect / Replace key still REPLACES the account's key, as PR #535's
 * reviews require (a replaced key is gone); only an explicit switch keeps one.
 * Because of the separate ciphertext:
 *   - the connect's "the key moves with the team" UPDATE, which matches rows
 *     by the previous key's exact ciphertext, never moves it;
 *   - the model switch, which matches provider + exact ciphertext, never
 *     changes it;
 *   - disconnecting that provider (DELETE every user_id NULL row on it except
 *     the account row) removes it, as the card's confirmation says.
 * A provider whose key is not kept yet but sits on another team row (an older
 * team-wide connect) counts as saved too, so an existing workspace can switch
 * at once.
 *
 * A failed read THROWS: "couldn't check" is never "not saved".
 */
import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { decryptField, encryptField } from "@/lib/field-encryption";
import type { Provider } from "@/lib/providers";
import { ENGINE_AGENT_KEY, engineFromRow, engineRow, type AgentEngineChoice } from "@/lib/ai/agent-engine";
import { LOCAL_MODEL_PROVIDER, WORKSPACE_AI_AGENT_KEY } from "@/lib/ai/workspace-account";

/** The agent_key of a provider's saved team key. */
export function savedKeyAgentKey(provider: string): string {
  return `__key:${provider}`;
}

/** Cloud providers whose keys can be saved and switched between (never a local model address). */
export const SWITCHABLE_PROVIDERS: readonly Provider[] = ["anthropic", "openai", "google", "openrouter"];

function writeClient() {
  if (process.env.EMPIRE_DATA_BACKEND !== "turso_cloud" || !tursoConfigured()) {
    throw new Error("agent engine: writes run only on the Turso data backend the readers use");
  }
  return getTursoClient();
}

/** The workspace's engine choice. No row = the API account. Throws when the read fails. */
export async function readAgentEngine(tenantId: string): Promise<AgentEngineChoice> {
  const { data, error } = await getServiceSupabase()
    .from("agent_model_config")
    .select("provider, model")
    .eq("tenant_id", tenantId)
    .is("user_id", null)
    .eq("agent_key", ENGINE_AGENT_KEY)
    .maybeSingle();
  if (error) throw new Error(`agent engine: agent_model_config read failed: ${error.message}`);
  return engineFromRow(data as { provider?: unknown; model?: unknown } | null);
}

/** Save the choice (one statement, an upsert on the workspace's engine row). Throws when it fails. */
export async function saveAgentEngine(tenantId: string, choice: AgentEngineChoice): Promise<void> {
  const row = engineRow(choice);
  await writeClient().execute({
    sql:
      "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)" +
      " VALUES (?, NULL, ?, ?, ?, NULL, 1, ?)" +
      " ON CONFLICT (tenant_id, agent_key) WHERE user_id IS NULL" +
      " DO UPDATE SET provider = excluded.provider, model = excluded.model, encrypted_api_key = NULL, updated_at = excluded.updated_at",
    args: [tenantId, ENGINE_AGENT_KEY, row.provider, row.model, new Date().toISOString()],
  });
}

type KeyRow = { agent_key: string; provider: string; model: string; encrypted_api_key: string | null; enabled: unknown };

async function teamKeyRows(tenantId: string): Promise<KeyRow[]> {
  const { data, error } = await getServiceSupabase()
    .from("agent_model_config")
    .select("agent_key, provider, model, encrypted_api_key, enabled")
    .eq("tenant_id", tenantId)
    .is("user_id", null);
  if (error) throw new Error(`saved AI keys: agent_model_config read failed: ${error.message}`);
  return ((data || []) as KeyRow[]).filter(
    (r) => !!r.encrypted_api_key && r.agent_key !== ENGINE_AGENT_KEY && r.provider !== LOCAL_MODEL_PROVIDER,
  );
}

const on = (v: unknown) => v === true || Number(v) === 1;

/**
 * The saved team key for a provider, as its ciphertext and the model it was
 * saved with: the kept key first, then the account row when it is on this
 * provider, then any other team row on it. null = none. Throws when the read fails.
 */
export async function readSavedKey(
  tenantId: string,
  provider: Provider,
): Promise<{ encryptedApiKey: string; model: string; source: "kept" | "account" | "team" } | null> {
  const rows = (await teamKeyRows(tenantId)).filter((r) => r.provider === provider);
  const kept = rows.find((r) => r.agent_key === savedKeyAgentKey(provider));
  if (kept?.encrypted_api_key) return { encryptedApiKey: kept.encrypted_api_key, model: kept.model, source: "kept" };
  const account = rows.find((r) => r.agent_key === WORKSPACE_AI_AGENT_KEY && on(r.enabled));
  if (account?.encrypted_api_key) return { encryptedApiKey: account.encrypted_api_key, model: account.model, source: "account" };
  const team = rows.find((r) => !r.agent_key.startsWith("__") && on(r.enabled));
  if (team?.encrypted_api_key) return { encryptedApiKey: team.encrypted_api_key, model: team.model, source: "team" };
  return null;
}

/** The cloud providers this workspace has a saved team key for. Throws when the read fails. */
export async function readSavedProviders(tenantId: string): Promise<Provider[]> {
  const rows = await teamKeyRows(tenantId);
  return SWITCHABLE_PROVIDERS.filter((p) =>
    rows.some((r) => r.provider === p && (r.agent_key === savedKeyAgentKey(p) || on(r.enabled))),
  );
}

/**
 * Keep a provider's team key on its own row, encrypted afresh (so its
 * ciphertext matches no other row: see SAVED KEYS). `encryptedApiKey` is the
 * ciphertext as some row holds it; it is decrypted here and never returned.
 * Throws when it cannot be read or written.
 */
export async function keepSavedKey(input: {
  tenantId: string;
  provider: Provider;
  model: string;
  encryptedApiKey: string;
}): Promise<void> {
  if (!SWITCHABLE_PROVIDERS.includes(input.provider)) return;
  const fresh = encryptField(decryptField(input.encryptedApiKey));
  await writeClient().execute({
    sql:
      "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)" +
      " VALUES (?, NULL, ?, ?, ?, ?, 0, ?)" +
      " ON CONFLICT (tenant_id, agent_key) WHERE user_id IS NULL" +
      " DO UPDATE SET provider = excluded.provider, model = excluded.model, encrypted_api_key = excluded.encrypted_api_key, enabled = 0, updated_at = excluded.updated_at",
    args: [input.tenantId, savedKeyAgentKey(input.provider), input.provider, input.model, fresh, new Date().toISOString()],
  });
}
