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
 * teammates the workspace has, together with those teammates' rows in ONE
 * step (see ONE STEP below). No migration: the partial unique index
 * idx_agent_model_config_default_per_agent (tenant_id, agent_key) WHERE
 * user_id IS NULL keeps it one row per workspace, and agent_key has no CHECK.
 * It is not a teammate: the agent-config routes never list it or accept it as
 * one.
 *
 * DISCONNECT KEEPS THE ROW. Disconnecting the account's provider RETIRES the
 * row (disconnectWorkspaceAccountInOneStep: key wiped, switched off) instead
 * of deleting it. The row is the record that this workspace connected through Settings,
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
import type { InStatement, InValue } from "@libsql/client";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { decryptField } from "@/lib/field-encryption";
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
 * ONE STEP (PR #535 reviews). A team-wide connect and a disconnect are each ONE
 * libSQL batch, and a batch runs as one transaction: every row it writes lands,
 * or none does. A key is never left half-saved, and nothing has to be cleaned
 * up after a race (five review rounds of look-backs and clean-ups each left a
 * new half state; this replaces all of them).
 *
 * THE VERSION. Each batch is guarded on the account row exactly as the request
 * read it (its stamp: provider, model, key and on/off switch). Every connect
 * writes a fresh ciphertext (each encryption is unique) and every disconnect
 * clears it, so the stamp changes with every write that changes the account:
 * it is the account's version, with no new column. If another window changed
 * the account after the read, no statement in the batch applies (the loser
 * changes nothing) and the caller says so in a plain sentence. The account row
 * is always the LAST statement, so every statement before it checks the stamp
 * before the batch changes it. The only state that can recur is "retired", and
 * a disconnect leaves nothing on that provider behind it, so finding it again
 * is finding the same thing.
 */
export type AccountStamp =
  | { present: false }
  | { present: true; provider: string; model: string; encryptedApiKey: string | null; enabled: number };

/**
 * The libSQL client every one-step write runs on: the database the readers
 * above use through getServiceSupabase (lib/supabase-server.ts), which is
 * Turso only when EMPIRE_DATA_BACKEND is turso_cloud and Turso is configured.
 * Any other setup (the supabase_legacy rollback) fails closed here, before
 * anything is written, so reads and writes never split across two databases.
 */
function oneStepClient() {
  if (process.env.EMPIRE_DATA_BACKEND !== "turso_cloud" || !tursoConfigured()) {
    throw new Error("workspace AI account: one-step writes run only on the Turso data backend the readers use");
  }
  return getTursoClient();
}

/** The account row as it stands, for the guard of the write that follows. Throws when the read fails. */
export async function readAccountStamp(tenantId: string): Promise<AccountStamp> {
  const res = await oneStepClient().execute({
    sql: "SELECT provider, model, encrypted_api_key, enabled FROM agent_model_config WHERE tenant_id = ? AND agent_key = ? AND user_id IS NULL LIMIT 1",
    args: [tenantId, WORKSPACE_AI_AGENT_KEY],
  });
  const row = res.rows[0];
  if (!row) return { present: false };
  return {
    present: true,
    provider: String(row.provider),
    model: String(row.model),
    encryptedApiKey: row.encrypted_api_key === null ? null : String(row.encrypted_api_key),
    enabled: Number(row.enabled),
  };
}

/** SQL that holds only while the account row is still exactly `stamp`. */
function stillAsRead(tenantId: string, stamp: AccountStamp): { sql: string; args: InValue[] } {
  if (!stamp.present) {
    return {
      sql: "NOT EXISTS (SELECT 1 FROM agent_model_config v WHERE v.tenant_id = ? AND v.agent_key = ? AND v.user_id IS NULL)",
      args: [tenantId, WORKSPACE_AI_AGENT_KEY],
    };
  }
  return {
    sql:
      "EXISTS (SELECT 1 FROM agent_model_config v WHERE v.tenant_id = ? AND v.agent_key = ? AND v.user_id IS NULL" +
      " AND v.provider IS ? AND v.model IS ? AND v.encrypted_api_key IS ? AND v.enabled IS ?)",
    args: [tenantId, WORKSPACE_AI_AGENT_KEY, stamp.provider, stamp.model, stamp.encryptedApiKey, stamp.enabled],
  };
}

/** Whether `stamp` is a live account holding exactly this key, on this provider and model. */
export function stampHoldsKey(stamp: AccountStamp, key: { provider: string; model: string; apiKey: string }): boolean {
  if (!stamp.present || stamp.enabled !== 1 || !stamp.encryptedApiKey) return false;
  if (stamp.provider !== key.provider || stamp.model !== key.model) return false;
  try {
    return decryptField(stamp.encryptedApiKey) === key.apiKey;
  } catch {
    return false;
  }
}

/**
 * The team-wide connect, in one step: the teammate rows it stamps (a new row
 * is switched on; an existing one keeps its prompt, name and on/off switch and
 * takes the new provider, model and key), the legacy `bravo` workspace row
 * when the workspace has one and it is not a target (the old team key moves
 * with the team; that row is only ever updated, never created), then the
 * account row (switched on). `committed` is false when the account changed
 * after `stamp` was read: then nothing was written. Throws when the batch
 * fails, and then nothing was written either.
 */
export async function connectWorkspaceAccountInOneStep(input: {
  tenantId: string;
  stamp: AccountStamp;
  provider: string;
  model: string;
  encryptedApiKey: string;
  agentKeys: string[];
}): Promise<{ committed: boolean; legacyRowMoved: boolean }> {
  const { tenantId, stamp, provider, model, encryptedApiKey } = input;
  const at = new Date().toISOString();
  const guard = stillAsRead(tenantId, stamp);
  const stmts: InStatement[] = input.agentKeys.map((agentKey) => ({
    sql:
      "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)" +
      ` SELECT ?, NULL, ?, ?, ?, ?, 1, ? WHERE ${guard.sql}` +
      " ON CONFLICT (tenant_id, agent_key) WHERE user_id IS NULL" +
      " DO UPDATE SET provider = excluded.provider, model = excluded.model, encrypted_api_key = excluded.encrypted_api_key, updated_at = excluded.updated_at",
    args: [tenantId, agentKey, provider, model, encryptedApiKey, at, ...guard.args],
  }));
  const moveLegacyRow = !input.agentKeys.includes(LEGACY_WORKSPACE_AI_AGENT_KEY);
  if (moveLegacyRow) {
    stmts.push({
      sql:
        "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = ?, updated_at = ?" +
        ` WHERE tenant_id = ? AND agent_key = ? AND user_id IS NULL AND ${guard.sql}`,
      args: [provider, model, encryptedApiKey, at, tenantId, LEGACY_WORKSPACE_AI_AGENT_KEY, ...guard.args],
    });
  }
  stmts.push(
    stamp.present
      ? {
          sql:
            "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = ?, enabled = 1, updated_at = ?" +
            ` WHERE tenant_id = ? AND agent_key = ? AND user_id IS NULL AND ${guard.sql}`,
          args: [provider, model, encryptedApiKey, at, tenantId, WORKSPACE_AI_AGENT_KEY, ...guard.args],
        }
      : {
          sql:
            "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)" +
            ` SELECT ?, NULL, ?, ?, ?, ?, 1, ? WHERE ${guard.sql}`,
          args: [tenantId, WORKSPACE_AI_AGENT_KEY, provider, model, encryptedApiKey, at, ...guard.args],
        },
  );
  const results = await oneStepClient().batch(stmts, "write");
  return {
    committed: results[results.length - 1].rowsAffected === 1,
    legacyRowMoved: moveLegacyRow && results[results.length - 2].rowsAffected === 1,
  };
}

/**
 * The team-wide disconnect of `provider`, in one step: every workspace row on
 * it goes (as the card's confirmation says), and the account, when it is on
 * it, is retired: key wiped, switched off, row kept (see DISCONNECT KEEPS THE
 * ROW). `committed` is false when the account changed after `stamp` was read:
 * then nothing was removed. Throws when the batch fails, and then nothing was
 * removed either.
 */
export async function disconnectWorkspaceAccountInOneStep(input: {
  tenantId: string;
  stamp: AccountStamp;
  provider: string;
}): Promise<{ committed: boolean; removed: number }> {
  const { tenantId, stamp, provider } = input;
  const guard = stillAsRead(tenantId, stamp);
  const stmts: InStatement[] = [
    // Whether the guard held when the batch began (only the last statement
    // changes the account, so it held for every statement or for none).
    { sql: `SELECT 1 AS held WHERE ${guard.sql}`, args: guard.args },
    {
      sql: `DELETE FROM agent_model_config WHERE tenant_id = ? AND provider = ? AND user_id IS NULL AND agent_key <> ? AND ${guard.sql}`,
      args: [tenantId, provider, WORKSPACE_AI_AGENT_KEY, ...guard.args],
    },
    {
      sql:
        "UPDATE agent_model_config SET enabled = 0, encrypted_api_key = NULL, updated_at = ?" +
        ` WHERE tenant_id = ? AND agent_key = ? AND user_id IS NULL AND provider = ? AND ${guard.sql}`,
      args: [new Date().toISOString(), tenantId, WORKSPACE_AI_AGENT_KEY, provider, ...guard.args],
    },
  ];
  const results = await oneStepClient().batch(stmts, "write");
  return { committed: results[0].rows.length === 1, removed: results[1].rowsAffected };
}

/**
 * A person's own key ("Just me"), in one step across the teammates it is for:
 * a new row is switched on; an existing one keeps its prompt, name and on/off
 * switch. Department chats never use these rows, so no account guard. Throws
 * when the batch fails (nothing written).
 */
export async function savePersonalKeyInOneStep(input: {
  tenantId: string;
  userId: string;
  provider: string;
  model: string;
  encryptedApiKey: string;
  agentKeys: string[];
}): Promise<void> {
  const at = new Date().toISOString();
  await oneStepClient().batch(
    input.agentKeys.map((agentKey) => ({
      sql:
        "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, 1, ?)" +
        " ON CONFLICT (tenant_id, user_id, agent_key) WHERE user_id IS NOT NULL" +
        " DO UPDATE SET provider = excluded.provider, model = excluded.model, encrypted_api_key = excluded.encrypted_api_key, updated_at = excluded.updated_at",
      args: [input.tenantId, input.userId, agentKey, input.provider, input.model, input.encryptedApiKey, at],
    })),
    "write",
  );
}

/**
 * Read-only, for a connect whose answer never came back (it timed out): is
 * exactly this key saved now? Team: the account holds it, on this provider
 * and model. Personal: one of the person's own rows on this provider holds it
 * (their save is one step, so one means all). Throws when the read fails.
 */
export async function keyIsSaved(input: {
  tenantId: string;
  userId: string | null;
  scope: "tenant" | "user";
  provider: string;
  model: string;
  apiKey: string;
}): Promise<boolean> {
  if (input.scope === "tenant") return stampHoldsKey(await readAccountStamp(input.tenantId), input);
  const res = await oneStepClient().execute({
    sql: "SELECT encrypted_api_key FROM agent_model_config WHERE tenant_id = ? AND user_id = ? AND provider = ? AND encrypted_api_key IS NOT NULL",
    args: [input.tenantId, input.userId, input.provider],
  });
  return res.rows.some((row) => {
    try {
      return decryptField(String(row.encrypted_api_key)) === input.apiKey;
    } catch {
      return false;
    }
  });
}
