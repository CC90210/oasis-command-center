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
import { decryptField, encryptField } from "@/lib/field-encryption";
import { isPlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { PROVIDER_TO_SERVICE, type Provider } from "@/lib/providers";
import { ENGINE_AGENT_KEY, engineRow, type AgentEngineChoice } from "@/lib/ai/agent-engine";

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
 * When the workspace's AI account last changed (a connect, a model switch, a
 * disconnect): the updated_at of the row readWorkspaceAiAccount answers on.
 * A channel failure recorded before it was about an account or model the
 * channels no longer send (components/os/department/channel.ts lastTurnOn).
 * NEVER throws: null (unknown) on any failure, and then every recorded
 * failure counts, as before. A read of its own, so a missing column can never
 * make the account itself unreadable.
 */
export async function readWorkspaceAccountChangedAt(tenantId: string): Promise<string | null> {
  try {
    const { data, error } = await getServiceSupabase()
      .from("agent_model_config")
      .select("agent_key, updated_at")
      .eq("tenant_id", tenantId)
      .is("user_id", null)
      .in("agent_key", [WORKSPACE_AI_AGENT_KEY, LEGACY_WORKSPACE_AI_AGENT_KEY]);
    if (error) throw new Error(error.message);
    const rows = (data || []) as Array<{ agent_key?: string | null; updated_at?: unknown }>;
    const row = rows.find((r) => r.agent_key === WORKSPACE_AI_AGENT_KEY) ?? rows.find((r) => r.agent_key === LEGACY_WORKSPACE_AI_AGENT_KEY);
    return typeof row?.updated_at === "string" && row.updated_at ? row.updated_at : null;
  } catch (err) {
    console.error("[workspace-account.changed_at]", { tenantId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
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
 * changes nothing) and the caller says so in a plain sentence. Connects write
 * the account/engine marker first and every dependent write requires that exact
 * new marker; disconnects keep the guarded retirement last. The only state that
 * can recur is "retired", and a disconnect leaves nothing on that provider
 * behind it, so finding it again is finding the same thing.
 */
type AccountRowStamp = { provider: string; model: string; encryptedApiKey: string | null; enabled: number };

export type AccountStamp =
  | { present: false; legacy?: AccountRowStamp | null }
  | { present: true; provider: string; model: string; encryptedApiKey: string | null; enabled: number };

function stampOf(candidate: Record<string, unknown> | undefined): AccountRowStamp | null {
  return candidate
    ? {
        provider: String(candidate.provider),
        model: String(candidate.model),
        encryptedApiKey: candidate.encrypted_api_key === null ? null : String(candidate.encrypted_api_key),
        enabled: Number(candidate.enabled),
      }
    : null;
}

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
    sql: "SELECT agent_key, provider, model, encrypted_api_key, enabled FROM agent_model_config WHERE tenant_id = ? AND agent_key IN (?, ?) AND user_id IS NULL",
    args: [tenantId, WORKSPACE_AI_AGENT_KEY, LEGACY_WORKSPACE_AI_AGENT_KEY],
  });
  const row = res.rows.find((candidate) => String(candidate.agent_key) === WORKSPACE_AI_AGENT_KEY);
  const legacy = res.rows.find((candidate) => String(candidate.agent_key) === LEGACY_WORKSPACE_AI_AGENT_KEY);
  if (!row) return { present: false, legacy: stampOf(legacy) };
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
    const noWorkspace = "NOT EXISTS (SELECT 1 FROM agent_model_config v WHERE v.tenant_id = ? AND v.agent_key = ? AND v.user_id IS NULL)";
    if (stamp.legacy === undefined) return { sql: noWorkspace, args: [tenantId, WORKSPACE_AI_AGENT_KEY] };
    if (stamp.legacy === null) {
      return {
        sql:
          `${noWorkspace} AND NOT EXISTS (` +
          "SELECT 1 FROM agent_model_config l WHERE l.tenant_id = ? AND l.agent_key = ? AND l.user_id IS NULL)",
        args: [tenantId, WORKSPACE_AI_AGENT_KEY, tenantId, LEGACY_WORKSPACE_AI_AGENT_KEY],
      };
    }
    return {
      sql:
        `${noWorkspace} AND EXISTS (` +
        "SELECT 1 FROM agent_model_config l WHERE l.tenant_id = ? AND l.agent_key = ? AND l.user_id IS NULL" +
        " AND l.provider IS ? AND l.model IS ? AND l.encrypted_api_key IS ? AND l.enabled IS ?)",
      args: [
        tenantId,
        WORKSPACE_AI_AGENT_KEY,
        tenantId,
        LEGACY_WORKSPACE_AI_AGENT_KEY,
        stamp.legacy.provider,
        stamp.legacy.model,
        stamp.legacy.encryptedApiKey,
        stamp.legacy.enabled,
      ],
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
 * takes the new provider, model and key), every OTHER workspace teammate row
 * that still holds the account's previous key (see THE KEY MOVES WITH THE
 * TEAM), and the legacy `bravo` workspace row when the workspace has one and it
 * is not a target (that row is only ever updated, never created). The account
 * marker is committed first; every dependent write requires that exact marker.
 * `committed` is false when the account changed after `stamp` was read: then
 * nothing was written. Throws when the batch fails, and then nothing was
 * written either.
 *
 * THE KEY MOVES WITH THE TEAM (PR #535 review, R5-M3). A connect stamps only
 * the teammates the caller names (by default their own enabled list, which is
 * per person). A teammate an earlier connect stamped with the account's key,
 * and this one did not name, used to keep that key on its old provider: it
 * still answered per-agent chats, while that provider's card read Not
 * connected and offered no Disconnect. Every workspace teammate row whose key
 * IS the account's previous key (the same ciphertext: one connect writes one
 * ciphertext to every row it stamps) now moves with the account. A teammate
 * the owner gave its OWN key (a per-agent override, a different ciphertext) is
 * left as it is. `movedWithTeam` names the rows that moved.
 */
export async function connectWorkspaceAccountInOneStep(input: {
  tenantId: string;
  stamp: AccountStamp;
  provider: string;
  model: string;
  encryptedApiKey: string;
  agentKeys: string[];
  /** Legacy compatibility only: commit only while no canonical engine row exists. */
  requireEngineAbsent?: boolean;
}): Promise<{ committed: boolean; legacyRowMoved: boolean; movedWithTeam: string[] }> {
  const { tenantId, stamp, provider, model, encryptedApiKey } = input;
  const at = new Date().toISOString();
  const accountGuard = stillAsRead(tenantId, stamp);
  const guard = input.requireEngineAbsent
    ? {
        sql:
          `(${accountGuard.sql}) AND NOT EXISTS (` +
          "SELECT 1 FROM agent_model_config e WHERE e.tenant_id = ? AND e.agent_key = ?)",
        args: [...accountGuard.args, tenantId, ENGINE_AGENT_KEY] as InValue[],
      }
    : accountGuard;
  // Commit the account marker first. Every remaining write keys off the exact
  // new marker, so changing a legacy row cannot invalidate the old snapshot
  // guard before the account is committed.
  const stmts: InStatement[] = [
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
  ];
  const accountIndex = 0;
  const after = {
    sql:
      "EXISTS (SELECT 1 FROM agent_model_config v WHERE v.tenant_id = ? AND v.agent_key = ? AND v.user_id IS NULL" +
      " AND v.provider IS ? AND v.model IS ? AND v.encrypted_api_key IS ? AND v.enabled IS 1 AND v.updated_at IS ?)",
    args: [tenantId, WORKSPACE_AI_AGENT_KEY, provider, model, encryptedApiKey, at] as InValue[],
  };
  for (const agentKey of input.agentKeys) {
    stmts.push({
      sql:
        "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)" +
        ` SELECT ?, NULL, ?, ?, ?, ?, 1, ? WHERE ${after.sql}` +
        " ON CONFLICT (tenant_id, agent_key) WHERE user_id IS NULL" +
        " DO UPDATE SET provider = excluded.provider, model = excluded.model, encrypted_api_key = excluded.encrypted_api_key, updated_at = excluded.updated_at",
      args: [tenantId, agentKey, provider, model, encryptedApiKey, at, ...after.args],
    });
  }
  // The account's previous key: the account row's (as the stamp read it), or,
  // for a workspace with no account row yet, the legacy row's (read by this
  // statement itself, before the legacy row's own move below rewrites it).
  const previousKey: { sql: string; args: InValue[] } | null = stamp.present
    ? stamp.encryptedApiKey
      ? { sql: "?", args: [stamp.encryptedApiKey] }
      : null
    : stamp.legacy !== undefined
      ? stamp.legacy?.encryptedApiKey
        ? { sql: "?", args: [stamp.legacy.encryptedApiKey] }
        : null
      : {
          sql: "(SELECT l.encrypted_api_key FROM agent_model_config l WHERE l.tenant_id = ? AND l.agent_key = ? AND l.user_id IS NULL)",
          args: [tenantId, LEGACY_WORKSPACE_AI_AGENT_KEY],
        };
  const moveTeamIndex = previousKey ? stmts.length : -1;
  if (previousKey) {
    stmts.push({
      sql:
        "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = ?, updated_at = ?" +
        " WHERE tenant_id = ? AND user_id IS NULL AND agent_key <> ? AND agent_key <> ?" +
        ` AND encrypted_api_key = ${previousKey.sql} AND ${after.sql} RETURNING agent_key`,
      args: [provider, model, encryptedApiKey, at, tenantId, WORKSPACE_AI_AGENT_KEY, LEGACY_WORKSPACE_AI_AGENT_KEY, ...previousKey.args, ...after.args],
    });
  }
  const moveLegacyRow = !input.agentKeys.includes(LEGACY_WORKSPACE_AI_AGENT_KEY);
  const moveLegacyIndex = moveLegacyRow ? stmts.length : -1;
  if (moveLegacyRow) {
    stmts.push({
      sql:
        "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = ?, updated_at = ?" +
        ` WHERE tenant_id = ? AND agent_key = ? AND user_id IS NULL AND ${after.sql}`,
      args: [provider, model, encryptedApiKey, at, tenantId, LEGACY_WORKSPACE_AI_AGENT_KEY, ...after.args],
    });
  }
  const results = await oneStepClient().batch(stmts, "write");
  const committed = results[accountIndex].rowsAffected === 1;
  return {
    committed,
    legacyRowMoved: committed && moveLegacyIndex >= 0 && results[moveLegacyIndex].rowsAffected === 1,
    movedWithTeam: !committed || moveTeamIndex < 0 ? [] : results[moveTeamIndex].rows.map((r) => String(r.agent_key)),
  };
}

export type AtomicEngineCommit = {
  userId: string | null;
  expectedVersion: string | null;
  choice: AgentEngineChoice;
};

export type AtomicSavedKeyCandidate = {
  source: "kept" | "account" | "team";
  agentKey: string;
  keptAgentKey: string;
  provider: string;
  model: string;
  encryptedApiKey: string;
  enabled: number;
  updatedAt: string | null;
};

export type AtomicOutgoingKeyCache = {
  agentKey: string;
  provider: string;
  model: string;
  encryptedApiKey: string;
  slot:
    | { present: false }
    | {
        present: true;
        provider: string;
        model: string;
        encryptedApiKey: string | null;
        enabled: number;
        updatedAt: string | null;
      };
};

function engineStillAsRead(tenantId: string, commit: AtomicEngineCommit): { sql: string; args: InValue[] } {
  const user = commit.userId === null ? "user_id IS NULL" : "user_id = ?";
  const userArgs: InValue[] = commit.userId === null ? [] : [commit.userId];
  if (commit.expectedVersion === null) {
    return {
      sql: `NOT EXISTS (SELECT 1 FROM agent_model_config e WHERE e.tenant_id = ? AND e.agent_key = ? AND e.${user})`,
      args: [tenantId, ENGINE_AGENT_KEY, ...userArgs],
    };
  }
  return {
    sql: `EXISTS (SELECT 1 FROM agent_model_config e WHERE e.tenant_id = ? AND e.agent_key = ? AND e.${user} AND e.updated_at = ?)`,
    args: [tenantId, ENGINE_AGENT_KEY, ...userArgs, commit.expectedVersion],
  };
}

/** The exact provider key row tested before a paid probe, plus priority. */
function candidateStillAsRead(tenantId: string, candidate: AtomicSavedKeyCandidate): { sql: string; args: InValue[] } {
  const exact =
    "EXISTS (SELECT 1 FROM agent_model_config k WHERE k.tenant_id = ? AND k.agent_key = ? AND k.user_id IS NULL" +
    " AND k.provider IS ? AND k.model IS ? AND k.encrypted_api_key IS ? AND k.enabled IS ? AND k.updated_at IS ?)";
  const args: InValue[] = [
    tenantId,
    candidate.agentKey,
    candidate.provider,
    candidate.model,
    candidate.encryptedApiKey,
    candidate.enabled,
    candidate.updatedAt,
  ];
  if (candidate.source === "kept") return { sql: exact, args };
  return {
    sql:
      `(${exact}) AND NOT EXISTS (` +
      "SELECT 1 FROM agent_model_config priority WHERE priority.tenant_id = ? AND priority.agent_key = ?" +
      " AND priority.user_id IS NULL AND priority.encrypted_api_key IS NOT NULL)",
    args: [...args, tenantId, candidate.keptAgentKey],
  };
}

/** Whether the public account read and write guard describe one snapshot. */
export function accountMatchesStamp(account: WorkspaceAiAccount | null, stamp: AccountStamp): boolean {
  const same = (row: AccountRowStamp) =>
    !!account &&
    account.provider === row.provider &&
    account.model === row.model &&
    account.encryptedApiKey === row.encryptedApiKey &&
    Number(account.enabled) === row.enabled;
  if (stamp.present) return account?.source === "workspace" && same(stamp);
  // Older internal callers may construct {present:false}; only a stamp read
  // here carries an explicit legacy snapshot.
  if (stamp.legacy === undefined) return true;
  if (stamp.legacy === null) return account === null;
  return account?.source === "legacy" && same(stamp.legacy);
}

/**
 * One database read for every field an API-engine switch reasons about. This
 * prevents an older account read from being combined with a newer write stamp
 * or timestamp when another window connects a key concurrently.
 */
export async function readWorkspaceAccountSnapshot(tenantId: string): Promise<{
  account: WorkspaceAiAccount | null;
  stamp: AccountStamp;
  changedAt: string | null;
}> {
  const { data, error } = await getServiceSupabase()
    .from("agent_model_config")
    .select("agent_key, provider, model, encrypted_api_key, enabled, updated_at")
    .eq("tenant_id", tenantId)
    .is("user_id", null)
    .in("agent_key", [WORKSPACE_AI_AGENT_KEY, LEGACY_WORKSPACE_AI_AGENT_KEY]);
  if (error) throw new Error(`workspace AI account snapshot: agent_model_config read failed: ${error.message}`);
  const rows = (data || []) as Array<ConfigRow & { updated_at?: unknown }>;
  const workspace = rows.find((row) => row.agent_key === WORKSPACE_AI_AGENT_KEY);
  const legacy = rows.find((row) => row.agent_key === LEGACY_WORKSPACE_AI_AGENT_KEY);
  const selected = workspace ?? legacy;
  const account = selected ? accountFrom(selected, workspace ? "workspace" : "legacy") : null;
  const stamp = workspace
    ? ({ present: true, ...stampOf(workspace as unknown as Record<string, unknown>)! } satisfies AccountStamp)
    : ({ present: false, legacy: stampOf(legacy as unknown as Record<string, unknown> | undefined) } satisfies AccountStamp);
  return {
    account,
    stamp,
    changedAt: typeof selected?.updated_at === "string" && selected.updated_at ? selected.updated_at : null,
  };
}

/**
 * Save an API engine choice only while both the engine row and the workspace
 * account are still the snapshots the caller read. The legacy provider route
 * is allowed to activate an account only before a canonical engine exists;
 * this matching guard closes the reverse race where that legacy activation
 * commits first while a new AI Brain PUT is between its account read and its
 * engine write.
 */
export async function saveApiEngineIfAccountAndEngineCurrent(input: {
  tenantId: string;
  stamp: AccountStamp;
  engine: AtomicEngineCommit;
}): Promise<boolean> {
  const { tenantId, stamp, engine } = input;
  const row = engineRow(engine.choice);
  const atDate = new Date();
  if (engine.expectedVersion === atDate.toISOString()) atDate.setMilliseconds(atDate.getMilliseconds() + 1);
  const at = atDate.toISOString();
  const accountGuard = stillAsRead(tenantId, stamp);
  const engineGuard = engineStillAsRead(tenantId, engine);
  const guard = {
    sql: `(${accountGuard.sql}) AND (${engineGuard.sql})`,
    args: [...accountGuard.args, ...engineGuard.args] as InValue[],
  };
  const userValues = engine.userId === null ? "NULL" : "?";
  const userArgs: InValue[] = engine.userId === null ? [] : [engine.userId];
  const conflict =
    engine.userId === null
      ? "ON CONFLICT (tenant_id, agent_key) WHERE user_id IS NULL DO NOTHING"
      : "ON CONFLICT (tenant_id, user_id, agent_key) WHERE user_id IS NOT NULL AND agent_key = '__engine__' DO NOTHING";
  const result =
    engine.expectedVersion === null
      ? await oneStepClient().execute({
          sql:
            `INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, computer_pairing_id, fallback_policy, updated_at)` +
            ` SELECT ?, ${userValues}, ?, ?, ?, NULL, 1, ?, ?, ? WHERE ${guard.sql} ${conflict}`,
          args: [tenantId, ...userArgs, ENGINE_AGENT_KEY, row.provider, row.model, row.computerPairingId, row.fallbackPolicy, at, ...guard.args],
        })
      : await oneStepClient().execute({
          sql:
            "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = NULL, enabled = 1," +
            " computer_pairing_id = ?, fallback_policy = ?, updated_at = ?" +
            ` WHERE tenant_id = ? AND agent_key = ? AND ${engine.userId === null ? "user_id IS NULL" : "user_id = ?"} AND ${guard.sql}`,
          args: [
            row.provider,
            row.model,
            row.computerPairingId,
            row.fallbackPolicy,
            at,
            tenantId,
            ENGINE_AGENT_KEY,
            ...userArgs,
            ...guard.args,
          ],
        });
  return result.rowsAffected === 1;
}

/**
 * Switch the workspace API account and save the canonical engine row in the
 * same libSQL transaction. The account mutation is conditional on the engine
 * compare-and-swap succeeding, so a stale AI Brain tab cannot switch the
 * workspace provider and then fail to save its engine choice.
 *
 * The exact saved-key candidate is part of the same guard. If a different key
 * is staged while the paid probe is running, every statement no-ops. Saving
 * the outgoing provider for later reuse is also in this transaction and uses
 * its own slot CAS, so it never overwrites a newer staged replacement.
 */
export async function connectWorkspaceAccountAndEngineInOneStep(input: {
  tenantId: string;
  stamp: AccountStamp;
  provider: string;
  model: string;
  encryptedApiKey: string;
  agentKeys: string[];
  engine: AtomicEngineCommit;
  candidate: AtomicSavedKeyCandidate;
  outgoingCache?: AtomicOutgoingKeyCache | null;
}): Promise<{ committed: boolean; legacyRowMoved: boolean; movedWithTeam: string[] }> {
  const { tenantId, stamp, provider, model, encryptedApiKey } = input;
  const atDate = new Date();
  if (input.engine.expectedVersion === atDate.toISOString()) atDate.setMilliseconds(atDate.getMilliseconds() + 1);
  const at = atDate.toISOString();
  const accountGuard = stillAsRead(tenantId, stamp);
  const engineGuard = engineStillAsRead(tenantId, input.engine);
  const candidateGuard = candidateStillAsRead(tenantId, input.candidate);
  const before = {
    sql: `(${accountGuard.sql}) AND (${engineGuard.sql}) AND (${candidateGuard.sql})`,
    args: [...accountGuard.args, ...engineGuard.args, ...candidateGuard.args],
  };
  const stmts: InStatement[] = [];

  // This write is conditional on the whole pre-commit snapshot. Its own slot
  // CAS deliberately does not block the provider switch: a newer outgoing
  // stage wins the slot while the switch may still use its independent exact
  // candidate. Fresh encryption keeps this cache out of ciphertext-matching
  // teammate moves below.
  if (input.outgoingCache) {
    const cache = input.outgoingCache;
    const fresh = encryptField(decryptField(cache.encryptedApiKey));
    if (cache.slot.present) {
      stmts.push({
        sql:
          "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = ?, enabled = 0, updated_at = ?" +
          " WHERE tenant_id = ? AND agent_key = ? AND user_id IS NULL" +
          " AND provider IS ? AND model IS ? AND encrypted_api_key IS ? AND enabled IS ? AND updated_at IS ?" +
          ` AND ${before.sql}`,
        args: [
          cache.provider,
          cache.model,
          fresh,
          at,
          tenantId,
          cache.agentKey,
          cache.slot.provider,
          cache.slot.model,
          cache.slot.encryptedApiKey,
          cache.slot.enabled,
          cache.slot.updatedAt,
          ...before.args,
        ],
      });
    } else {
      stmts.push({
        sql:
          "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)" +
          ` SELECT ?, NULL, ?, ?, ?, ?, 0, ? WHERE ${before.sql}` +
          " AND NOT EXISTS (SELECT 1 FROM agent_model_config cache WHERE cache.tenant_id = ? AND cache.agent_key = ? AND cache.user_id IS NULL)" +
          " ON CONFLICT (tenant_id, agent_key) WHERE user_id IS NULL DO NOTHING",
        args: [tenantId, cache.agentKey, cache.provider, cache.model, fresh, at, ...before.args, tenantId, cache.agentKey],
      });
    }
  }

  const row = engineRow(input.engine.choice);
  const engineIndex = stmts.length;
  if (input.engine.expectedVersion === null) {
    const userValues = input.engine.userId === null ? "NULL" : "?";
    const userArgs: InValue[] = input.engine.userId === null ? [] : [input.engine.userId];
    const conflict =
      input.engine.userId === null
        ? "ON CONFLICT (tenant_id, agent_key) WHERE user_id IS NULL DO NOTHING"
        : "ON CONFLICT (tenant_id, user_id, agent_key) WHERE user_id IS NOT NULL AND agent_key = '__engine__' DO NOTHING";
    stmts.push({
      sql:
        `INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, computer_pairing_id, fallback_policy, updated_at)` +
        ` SELECT ?, ${userValues}, ?, ?, ?, NULL, 1, ?, ?, ? WHERE ${before.sql} ${conflict}`,
      args: [tenantId, ...userArgs, ENGINE_AGENT_KEY, row.provider, row.model, row.computerPairingId, row.fallbackPolicy, at, ...before.args],
    });
  } else {
    const user = input.engine.userId === null ? "user_id IS NULL" : "user_id = ?";
    const userArgs: InValue[] = input.engine.userId === null ? [] : [input.engine.userId];
    stmts.push({
      sql:
        "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = NULL, enabled = 1," +
        " computer_pairing_id = ?, fallback_policy = ?, updated_at = ?" +
        ` WHERE tenant_id = ? AND agent_key = ? AND ${user} AND updated_at = ? AND ${accountGuard.sql} AND ${candidateGuard.sql}`,
      args: [
        row.provider,
        row.model,
        row.computerPairingId,
        row.fallbackPolicy,
        at,
        tenantId,
        ENGINE_AGENT_KEY,
        ...userArgs,
        input.engine.expectedVersion,
        ...accountGuard.args,
        ...candidateGuard.args,
      ],
    });
  }

  const afterUser = input.engine.userId === null ? "user_id IS NULL" : "user_id = ?";
  const afterUserArgs: InValue[] = input.engine.userId === null ? [] : [input.engine.userId];
  const engineAfter = {
    sql:
      `EXISTS (SELECT 1 FROM agent_model_config e WHERE e.tenant_id = ? AND e.agent_key = ? AND e.${afterUser}` +
      " AND e.provider = ? AND e.model = ? AND e.computer_pairing_id IS ? AND e.fallback_policy = ? AND e.updated_at = ?)",
    args: [tenantId, ENGINE_AGENT_KEY, ...afterUserArgs, row.provider, row.model, row.computerPairingId, row.fallbackPolicy, at] as InValue[],
  };
  // The engine write above proves the exact candidate guard held. No outside
  // writer can interleave inside this libSQL transaction, so later statements
  // follow the engine marker and the still-old account rather than re-reading
  // a candidate row that one of our own legacy/team moves may update.
  const during = { sql: `(${accountGuard.sql}) AND (${engineAfter.sql})`, args: [...accountGuard.args, ...engineAfter.args] };
  const accountIndex = stmts.length;
  stmts.push(
    stamp.present
      ? {
          sql:
            "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = ?, enabled = 1, updated_at = ?" +
            ` WHERE tenant_id = ? AND agent_key = ? AND user_id IS NULL AND ${during.sql}`,
          args: [provider, model, encryptedApiKey, at, tenantId, WORKSPACE_AI_AGENT_KEY, ...during.args],
        }
      : {
          sql:
            "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)" +
            ` SELECT ?, NULL, ?, ?, ?, ?, 1, ? WHERE ${during.sql}`,
          args: [tenantId, WORKSPACE_AI_AGENT_KEY, provider, model, encryptedApiKey, at, ...during.args],
        },
  );
  const accountAfter = {
    sql:
      "EXISTS (SELECT 1 FROM agent_model_config v WHERE v.tenant_id = ? AND v.agent_key = ? AND v.user_id IS NULL" +
      " AND v.provider IS ? AND v.model IS ? AND v.encrypted_api_key IS ? AND v.enabled IS 1 AND v.updated_at IS ?)",
    args: [tenantId, WORKSPACE_AI_AGENT_KEY, provider, model, encryptedApiKey, at] as InValue[],
  };
  const after = { sql: `(${engineAfter.sql}) AND (${accountAfter.sql})`, args: [...engineAfter.args, ...accountAfter.args] };

  for (const agentKey of input.agentKeys) {
    stmts.push({
      sql:
        "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)" +
        ` SELECT ?, NULL, ?, ?, ?, ?, 1, ? WHERE ${after.sql}` +
        " ON CONFLICT (tenant_id, agent_key) WHERE user_id IS NULL" +
        " DO UPDATE SET provider = excluded.provider, model = excluded.model, encrypted_api_key = excluded.encrypted_api_key, updated_at = excluded.updated_at",
      args: [tenantId, agentKey, provider, model, encryptedApiKey, at, ...after.args],
    });
  }
  const previousKey: { sql: string; args: InValue[] } | null = stamp.present
    ? stamp.encryptedApiKey
      ? { sql: "?", args: [stamp.encryptedApiKey] }
      : null
    : stamp.legacy !== undefined
      ? stamp.legacy?.encryptedApiKey
        ? { sql: "?", args: [stamp.legacy.encryptedApiKey] }
        : null
      : {
          sql: "(SELECT l.encrypted_api_key FROM agent_model_config l WHERE l.tenant_id = ? AND l.agent_key = ? AND l.user_id IS NULL)",
          args: [tenantId, LEGACY_WORKSPACE_AI_AGENT_KEY],
        };
  const moveTeamIndex = previousKey ? stmts.length : -1;
  if (previousKey) {
    stmts.push({
      sql:
        "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = ?, updated_at = ?" +
        " WHERE tenant_id = ? AND user_id IS NULL AND agent_key <> ? AND agent_key <> ?" +
        ` AND encrypted_api_key = ${previousKey.sql} AND ${after.sql} RETURNING agent_key`,
      args: [provider, model, encryptedApiKey, at, tenantId, WORKSPACE_AI_AGENT_KEY, LEGACY_WORKSPACE_AI_AGENT_KEY, ...previousKey.args, ...after.args],
    });
  }
  const moveLegacyRow = !input.agentKeys.includes(LEGACY_WORKSPACE_AI_AGENT_KEY);
  const moveLegacyIndex = moveLegacyRow ? stmts.length : -1;
  if (moveLegacyRow) {
    stmts.push({
      sql:
        "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = ?, updated_at = ?" +
        ` WHERE tenant_id = ? AND agent_key = ? AND user_id IS NULL AND ${after.sql}`,
      args: [provider, model, encryptedApiKey, at, tenantId, LEGACY_WORKSPACE_AI_AGENT_KEY, ...after.args],
    });
  }
  const results = await oneStepClient().batch(stmts, "write");
  const committed = results[engineIndex].rowsAffected === 1 && results[accountIndex].rowsAffected === 1;
  return {
    committed,
    legacyRowMoved: committed && moveLegacyIndex >= 0 && results[moveLegacyIndex].rowsAffected === 1,
    movedWithTeam: !committed || moveTeamIndex < 0 ? [] : results[moveTeamIndex].rows.map((r) => String(r.agent_key)),
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
 * Switch the model the workspace's AI account sends, on the SAME provider and
 * key (Settings > AI brain, app/api/agent-config/workspace-model), in ONE
 * statement: every workspace row on that provider holding exactly the key read
 * (the account row, the legacy `bravo` row when that is the account, and the
 * teammate rows a connect stamped with it: the key moves with the team, and so
 * does its model). The ciphertext is the guard: a reconnect (a new ciphertext)
 * or a disconnect (no key) after the read matches nothing, and the answer is
 * committed: false. A teammate given its OWN key keeps its model. Throws when
 * the statement fails; then nothing changed.
 */
export async function changeWorkspaceModelInOneStep(input: {
  tenantId: string;
  account: Pick<UsableAiAccount, "source" | "provider" | "encryptedApiKey">;
  model: string;
}): Promise<{ committed: boolean; changed: string[] }> {
  const { tenantId, account, model } = input;
  const answering = account.source === "legacy" ? LEGACY_WORKSPACE_AI_AGENT_KEY : WORKSPACE_AI_AGENT_KEY;
  // The answering row itself must still hold this key on this provider, or
  // nothing moves: a retired account (key wiped) whose teammates still carry
  // the old key must not have just those teammates switched (CodeRabbit, #561).
  // The guard reads provider and key, never the model this statement changes.
  const res = await oneStepClient().execute({
    sql:
      "UPDATE agent_model_config SET model = ?, updated_at = ?" +
      " WHERE tenant_id = ? AND user_id IS NULL AND provider = ? AND encrypted_api_key = ?" +
      " AND EXISTS (SELECT 1 FROM agent_model_config AS answering WHERE answering.tenant_id = ? AND answering.agent_key = ?" +
      " AND answering.user_id IS NULL AND answering.provider = ? AND answering.encrypted_api_key = ?)" +
      " RETURNING agent_key",
    args: [
      model,
      new Date().toISOString(),
      tenantId,
      account.provider,
      account.encryptedApiKey,
      tenantId,
      answering,
      account.provider,
      account.encryptedApiKey,
    ],
  });
  const changed = res.rows.map((r) => String(r.agent_key));
  return { committed: changed.includes(answering), changed };
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
