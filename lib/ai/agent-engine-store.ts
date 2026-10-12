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
 *
 * PER-PERSON ENGINE. Workspace and personal rows use the same subscription,
 * local, and API vocabulary. A personal row has user_id = the auth user id;
 * deleting it means inherit the workspace row. Device-backed rows bind one
 * computer_pairing_id. Fallback defaults to none and can use the workspace API
 * only when fallback_policy explicitly says workspace_api.
 */
import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { decryptField, encryptField } from "@/lib/field-encryption";
import type { Provider } from "@/lib/providers";
import { ENGINE_AGENT_KEY, engineFromRow, engineRow, type AgentEngineChoice } from "@/lib/ai/agent-engine";
import { LOCAL_MODEL_PROVIDER, WORKSPACE_AI_AGENT_KEY } from "@/lib/ai/workspace-account";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";

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

type CanonicalEngineRow = {
  provider?: unknown;
  model?: unknown;
  computer_pairing_id?: unknown;
  fallback_policy?: unknown;
  updated_at?: unknown;
  runtime_probe_job_id?: unknown;
  runtime_probe_pairing_id?: unknown;
  runtime_probe_engine_kind?: unknown;
  runtime_probe_engine_name?: unknown;
  runtime_probe_engine_version?: unknown;
  runtime_probe_verified_at?: unknown;
};

export type SavedRuntimeProbeProof = {
  jobId: string;
  pairingId: string;
  engine: { kind: "cli" | "local"; name: string };
  engineVersion: string;
  verifiedAt: string;
};

export type SavedRuntimeProbeProofInput = Omit<SavedRuntimeProbeProof, "engineVersion">;

function missingEngineBindingColumns(message: string): boolean {
  return /(?:no such column|schema cache).*(?:computer_pairing_id|fallback_policy)|(?:computer_pairing_id|fallback_policy).*(?:does not exist|not found)/i.test(
    message,
  );
}

function missingEngineProofColumns(message: string): boolean {
  return /(?:no such column|schema cache).*(?:runtime_probe_)|(?:runtime_probe_).*(?:does not exist|not found)/i.test(message);
}

async function readEngineRow(
  tenantId: string,
  userId: string | null,
): Promise<{ data: CanonicalEngineRow | null; error: { message: string } | null }> {
  const query = (columns: string) => {
    let q = getServiceSupabase().from("agent_model_config").select(columns).eq("tenant_id", tenantId);
    q = userId === null ? q.is("user_id", null) : q.eq("user_id", userId);
    return q.eq("agent_key", ENGINE_AGENT_KEY).maybeSingle();
  };

  const current = await query(
    "provider, model, computer_pairing_id, fallback_policy, updated_at, runtime_probe_job_id, runtime_probe_pairing_id, runtime_probe_engine_kind, runtime_probe_engine_name, runtime_probe_engine_version, runtime_probe_verified_at",
  );
  if (!current.error || (!missingEngineProofColumns(current.error.message) && !missingEngineBindingColumns(current.error.message))) {
    return current as { data: CanonicalEngineRow | null; error: { message: string } | null };
  }

  // Proof columns are additive. Old workers can still read the canonical
  // binding during schema rollout, but cannot invent a durable proof.
  const binding = await query("provider, model, computer_pairing_id, fallback_policy, updated_at");
  if (!binding.error || !missingEngineBindingColumns(binding.error.message)) {
    return binding as { data: CanonicalEngineRow | null; error: { message: string } | null };
  }

  // Old workers remain readable during the additive migration rollout. The
  // result stays deliberately unbound, so no device can be picked implicitly.
  const legacy = await query("provider, model, updated_at");
  return legacy as { data: CanonicalEngineRow | null; error: { message: string } | null };
}

function engineFromCanonicalRow(row: CanonicalEngineRow, personal: boolean): AgentEngineChoice {
  if (personal && row.provider === "computer") return { kind: "cli", cli: "claude" };
  return engineFromRow(row);
}

function savedProbeProofFromRow(
  row: CanonicalEngineRow | null,
  engine: AgentEngineChoice,
): SavedRuntimeProbeProof | null {
  if (!row || engine.kind === "api" || !engine.pairingId) return null;
  const version = typeof row.updated_at === "string" ? row.updated_at : "";
  const jobId = typeof row.runtime_probe_job_id === "string" ? row.runtime_probe_job_id : "";
  const pairingId = typeof row.runtime_probe_pairing_id === "string" ? row.runtime_probe_pairing_id : "";
  const kind = row.runtime_probe_engine_kind;
  const name = typeof row.runtime_probe_engine_name === "string" ? row.runtime_probe_engine_name : "";
  const proofVersion = typeof row.runtime_probe_engine_version === "string" ? row.runtime_probe_engine_version : "";
  const verifiedAt = typeof row.runtime_probe_verified_at === "string" ? row.runtime_probe_verified_at : "";
  const expectedKind = engine.kind === "cli" ? "cli" : "local";
  const expectedName = engine.kind === "cli" ? engine.cli : engine.model;
  if (
    !version || !jobId || !pairingId || !name || !proofVersion ||
    (kind !== "cli" && kind !== "local") ||
    version !== proofVersion || pairingId !== engine.pairingId ||
    kind !== expectedKind || name !== expectedName || !Number.isFinite(Date.parse(verifiedAt))
  ) {
    return null;
  }
  return { jobId, pairingId, engine: { kind, name }, engineVersion: version, verifiedAt };
}

function assertProbeMatchesChoice(choice: AgentEngineChoice, proof: SavedRuntimeProbeProofInput): void {
  if (choice.kind === "api" || !choice.pairingId) throw new Error("agent engine: probe proof requires a bound device engine");
  const kind = choice.kind === "cli" ? "cli" : "local";
  const name = choice.kind === "cli" ? choice.cli : choice.model;
  if (
    proof.pairingId !== choice.pairingId || proof.engine.kind !== kind || proof.engine.name !== name ||
    !proof.jobId || !Number.isFinite(Date.parse(proof.verifiedAt))
  ) {
    throw new Error("agent engine: probe proof does not match the saved pairing/runtime");
  }
}

/** A later failed exact-runtime probe revokes the saved proof. Its age does
 * not: freshness is a Save precondition, while live heartbeat/runtime health
 * remains the execution-time gate. */
export function savedRuntimeProbeProofReady(
  proof: SavedRuntimeProbeProof | null | undefined,
  pairingId: string,
  engine: { kind: "cli" | "local"; name: string },
  latestReceipt?: { jobId?: string; ready: boolean; finishedAt: string } | null,
): boolean {
  if (!proof || proof.pairingId !== pairingId || proof.engine.kind !== engine.kind || proof.engine.name !== engine.name) return false;
  if (latestReceipt) {
    const latestAt = Date.parse(latestReceipt.finishedAt);
    const verifiedAt = Date.parse(proof.verifiedAt);
    const isLater =
      Number.isFinite(latestAt) &&
      Number.isFinite(verifiedAt) &&
      (latestAt > verifiedAt ||
        (latestAt === verifiedAt && Boolean(latestReceipt.jobId) && latestReceipt.jobId !== proof.jobId));
    if (isLater && !latestReceipt.ready) return false;
  }
  return true;
}

/**
 * The workspace's engine choice. No row: OASIS's own workspace runs on the CLI
 * bridge (CC, 2026-10-09: "for my workspace they don't use API keys ... you
 * should know our workflow"), Claude Code by default; every other workspace
 * runs on its API account. Throws when the read fails.
 */
export async function readAgentEngine(tenantId: string): Promise<AgentEngineChoice> {
  const [{ data, error }, oasis] = await Promise.all([
    readEngineRow(tenantId, null),
    isOasisWorkspace(tenantId),
  ]);
  if (error) throw new Error(`agent engine: agent_model_config read failed: ${error.message}`);
  if (!data) return oasis ? OASIS_DEFAULT_ENGINE : { kind: "api" };
  return engineFromRow(
    data as { provider?: unknown; model?: unknown; computer_pairing_id?: unknown; fallback_policy?: unknown } | null,
  );
}

/** OASIS's own workspace, when no choice is saved: its agents' harnesses on CC's computer, through the bridge. */
export const OASIS_DEFAULT_ENGINE: AgentEngineChoice = { kind: "cli", cli: "claude" };

/** Whether this is OASIS's own workspace (lib/role-surfaces.ts). Throws when the read fails. */
export async function isOasisWorkspace(tenantId: string): Promise<boolean> {
  const { data, error } = await getServiceSupabase().from("tenants").select("slug").eq("id", tenantId).maybeSingle();
  if (error) throw new Error(`agent engine: tenants read failed: ${error.message}`);
  return isOasisSurfaceTenant((data as { slug?: string | null } | null)?.slug ?? null);
}

/**
 * The engine row's version: its updated_at, or null when no choice is saved.
 * The panel reads it with the choice and hands it back on a save, so a save
 * that finishes late (a cancelled or slow test) cannot overwrite a newer one.
 * Throws when the read fails.
 */
export async function readAgentEngineVersion(tenantId: string): Promise<string | null> {
  const { data, error } = await getServiceSupabase()
    .from("agent_model_config")
    .select("updated_at")
    .eq("tenant_id", tenantId)
    .is("user_id", null)
    .eq("agent_key", ENGINE_AGENT_KEY)
    .maybeSingle();
  if (error) throw new Error(`agent engine: version read failed: ${error.message}`);
  const at = (data as { updated_at?: unknown } | null)?.updated_at;
  return typeof at === "string" && at ? at : null;
}

/**
 * Save the choice ONLY IF the engine row is still the version the caller read
 * (readAgentEngineVersion; null = no row yet). One statement, so a newer choice
 * saved meanwhile makes this one a no-op: returns false and nothing changes.
 * Throws when the write fails.
 */
export async function saveAgentEngineIfCurrent(
  tenantId: string,
  choice: AgentEngineChoice,
  expectedVersion: string | null,
  probeProof: SavedRuntimeProbeProofInput | null = null,
): Promise<boolean> {
  const row = engineRow(choice);
  const now = new Date().toISOString();
  if (probeProof) assertProbeMatchesChoice(choice, probeProof);
  if (probeProof) {
    const proofArgs = [
      probeProof.jobId,
      probeProof.pairingId,
      probeProof.engine.kind,
      probeProof.engine.name,
      now,
      probeProof.verifiedAt,
    ];
    const res =
      expectedVersion === null
        ? await writeClient().execute({
            sql:
              "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, computer_pairing_id, fallback_policy, updated_at," +
              " runtime_probe_job_id, runtime_probe_pairing_id, runtime_probe_engine_kind, runtime_probe_engine_name, runtime_probe_engine_version, runtime_probe_verified_at)" +
              " VALUES (?, NULL, ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)" +
              " ON CONFLICT (tenant_id, agent_key) WHERE user_id IS NULL DO NOTHING",
            args: [tenantId, ENGINE_AGENT_KEY, row.provider, row.model, row.computerPairingId, row.fallbackPolicy, now, ...proofArgs],
          })
        : await writeClient().execute({
            sql:
              "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = NULL, enabled = 1, computer_pairing_id = ?, fallback_policy = ?, updated_at = ?," +
              " runtime_probe_job_id = ?, runtime_probe_pairing_id = ?, runtime_probe_engine_kind = ?, runtime_probe_engine_name = ?, runtime_probe_engine_version = ?, runtime_probe_verified_at = ?" +
              " WHERE tenant_id = ? AND agent_key = ? AND user_id IS NULL AND updated_at = ?",
            args: [row.provider, row.model, row.computerPairingId, row.fallbackPolicy, now, ...proofArgs, tenantId, ENGINE_AGENT_KEY, expectedVersion],
          });
    return res.rowsAffected === 1;
  }
  const res =
    expectedVersion === null
      ? await writeClient().execute({
          sql:
            "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, computer_pairing_id, fallback_policy, updated_at)" +
            " VALUES (?, NULL, ?, ?, ?, NULL, 1, ?, ?, ?)" +
            " ON CONFLICT (tenant_id, agent_key) WHERE user_id IS NULL DO NOTHING",
          args: [tenantId, ENGINE_AGENT_KEY, row.provider, row.model, row.computerPairingId, row.fallbackPolicy, now],
        })
      : await writeClient().execute({
          sql:
            "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = NULL, enabled = 1, computer_pairing_id = ?, fallback_policy = ?, updated_at = ?" +
            " WHERE tenant_id = ? AND agent_key = ? AND user_id IS NULL AND updated_at = ?",
          args: [row.provider, row.model, row.computerPairingId, row.fallbackPolicy, now, tenantId, ENGINE_AGENT_KEY, expectedVersion],
        });
  return res.rowsAffected === 1;
}

/** Save the choice (one statement, an upsert on the workspace's engine row). Throws when it fails. */
export async function saveAgentEngine(tenantId: string, choice: AgentEngineChoice): Promise<void> {
  const row = engineRow(choice);
  await writeClient().execute({
    sql:
      "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, computer_pairing_id, fallback_policy, updated_at)" +
      " VALUES (?, NULL, ?, ?, ?, NULL, 1, ?, ?, ?)" +
      " ON CONFLICT (tenant_id, agent_key) WHERE user_id IS NULL" +
      " DO UPDATE SET provider = excluded.provider, model = excluded.model, encrypted_api_key = NULL," +
      " computer_pairing_id = excluded.computer_pairing_id, fallback_policy = excluded.fallback_policy, updated_at = excluded.updated_at",
    args: [tenantId, ENGINE_AGENT_KEY, row.provider, row.model, row.computerPairingId, row.fallbackPolicy, new Date().toISOString()],
  });
}

/** The personal override row's version; null means this person inherits. */
export async function readPersonAgentEngineVersion(tenantId: string, userId: string): Promise<string | null> {
  const { data, error } = await getServiceSupabase()
    .from("agent_model_config")
    .select("updated_at")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("agent_key", ENGINE_AGENT_KEY)
    .maybeSingle();
  if (error) throw new Error(`person engine: version read failed: ${error.message}`);
  const at = (data as { updated_at?: unknown } | null)?.updated_at;
  return typeof at === "string" && at ? at : null;
}

/** A person's engine using the same vocabulary and columns as the workspace row. */
export async function readPersonAgentEngine(tenantId: string, userId: string): Promise<AgentEngineChoice | null> {
  const { data, error } = await readEngineRow(tenantId, userId);
  if (error) throw new Error(`person engine: agent_model_config read failed: ${error.message}`);
  if (!data) return null;
  const row = data as CanonicalEngineRow;
  // Rollout compatibility for O3b's old personal vocabulary. It stays
  // deliberately unbound; callers surface "Choose a computer" rather than
  // silently selecting whichever machine happens to answer first.
  if (row.provider === "computer") return { kind: "cli", cli: "claude" };
  return engineFromRow(row);
}

/** Persist a person's canonical selection; inheritance is clearPersonEngine. */
export async function savePersonAgentEngine(tenantId: string, userId: string, choice: AgentEngineChoice): Promise<void> {
  const row = engineRow(choice);
  await writeClient().execute({
    sql:
      "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, computer_pairing_id, fallback_policy, updated_at)" +
      " VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)" +
      " ON CONFLICT (tenant_id, user_id, agent_key) WHERE user_id IS NOT NULL AND agent_key = '__engine__'" +
      " DO UPDATE SET provider = excluded.provider, model = excluded.model, encrypted_api_key = NULL," +
      " computer_pairing_id = excluded.computer_pairing_id, fallback_policy = excluded.fallback_policy, updated_at = excluded.updated_at",
    args: [tenantId, userId, ENGINE_AGENT_KEY, row.provider, row.model, row.computerPairingId, row.fallbackPolicy, new Date().toISOString()],
  });
}

/**
 * Upgrade one still-unbound legacy device engine to an exact pairing without
 * overwriting a choice saved concurrently. A personal upgrade is update-only
 * (deleting the personal row means inherit, so it must never be recreated).
 * The only row this may insert is OASIS's implicit workspace Claude default.
 */
export async function bindLegacyEngineIfUnchanged(input: {
  tenantId: string;
  userId: string | null;
  engine: Exclude<AgentEngineChoice, { kind: "api" }>;
  pairingId: string;
  probeProof?: SavedRuntimeProbeProofInput | null;
}): Promise<boolean> {
  if (input.engine.pairingId) return false;
  const boundChoice: Exclude<AgentEngineChoice, { kind: "api" }> =
    input.engine.kind === "cli"
      ? {
          kind: "cli",
          cli: input.engine.cli,
          pairingId: input.pairingId,
          fallback: input.engine.fallback ?? "none",
        }
      : {
          kind: "local",
          model: input.engine.model,
          pairingId: input.pairingId,
          fallback: input.engine.fallback ?? "none",
        };
  const row = engineRow(boundChoice);
  const now = new Date().toISOString();
  if (input.probeProof) assertProbeMatchesChoice(boundChoice, input.probeProof);
  const legacyPersonalClaude = input.userId !== null && input.engine.kind === "cli" && input.engine.cli === "claude";
  const legacyProviderClause = legacyPersonalClaude ? " OR provider = 'computer'" : "";
  const userClause = input.userId === null ? "user_id IS NULL" : "user_id = ?";
  const proofSet = input.probeProof
    ? ", runtime_probe_job_id = ?, runtime_probe_pairing_id = ?, runtime_probe_engine_kind = ?, runtime_probe_engine_name = ?, runtime_probe_engine_version = ?, runtime_probe_verified_at = ?"
    : "";
  const proofArgs = input.probeProof
    ? [input.probeProof.jobId, input.probeProof.pairingId, input.probeProof.engine.kind, input.probeProof.engine.name, now, input.probeProof.verifiedAt]
    : [];
  const result = await writeClient().execute({
    sql:
      "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = NULL, enabled = 1," +
      ` computer_pairing_id = ?, fallback_policy = ?, updated_at = ?${proofSet}` +
      ` WHERE tenant_id = ? AND ${userClause} AND agent_key = ?` +
      " AND (computer_pairing_id IS NULL OR computer_pairing_id = '')" +
      ` AND ((provider = ? AND model = ?)${legacyProviderClause})`,
    args: [
      row.provider,
      row.model,
      row.computerPairingId,
      row.fallbackPolicy,
      now,
      ...proofArgs,
      input.tenantId,
      ...(input.userId === null ? [] : [input.userId]),
      ENGINE_AGENT_KEY,
      row.provider,
      row.model,
    ],
  });
  if (result.rowsAffected === 1) return true;

  // A missing personal row means the person chose inheritance while this
  // upgrade was running. Never undo that choice. For workspaces, only the
  // implicit OASIS Claude default has no row and is eligible for insertion.
  if (
    input.userId !== null ||
    input.engine.kind !== "cli" ||
    input.engine.cli !== "claude" ||
    !(await isOasisWorkspace(input.tenantId))
  ) {
    return false;
  }
  const insertProofColumns = input.probeProof
    ? ", runtime_probe_job_id, runtime_probe_pairing_id, runtime_probe_engine_kind, runtime_probe_engine_name, runtime_probe_engine_version, runtime_probe_verified_at"
    : "";
  const insertProofValues = input.probeProof ? ", ?, ?, ?, ?, ?, ?" : "";
  const inserted = await writeClient().execute({
    sql:
      `INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, computer_pairing_id, fallback_policy, updated_at${insertProofColumns})` +
      ` VALUES (?, NULL, ?, ?, ?, NULL, 1, ?, ?, ?${insertProofValues})` +
      " ON CONFLICT (tenant_id, agent_key) WHERE user_id IS NULL DO NOTHING",
    args: [
      input.tenantId,
      ENGINE_AGENT_KEY,
      row.provider,
      row.model,
      row.computerPairingId,
      row.fallbackPolicy,
      now,
      ...proofArgs,
    ],
  });
  return inserted.rowsAffected === 1;
}

/** CAS save for the personal row. A null version means "still inheriting". */
export async function savePersonAgentEngineIfCurrent(
  tenantId: string,
  userId: string,
  choice: AgentEngineChoice,
  expectedVersion: string | null,
  probeProof: SavedRuntimeProbeProofInput | null = null,
): Promise<boolean> {
  const row = engineRow(choice);
  const now = new Date().toISOString();
  if (probeProof) assertProbeMatchesChoice(choice, probeProof);
  if (probeProof) {
    const proofArgs = [
      probeProof.jobId,
      probeProof.pairingId,
      probeProof.engine.kind,
      probeProof.engine.name,
      now,
      probeProof.verifiedAt,
    ];
    const result =
      expectedVersion === null
        ? await writeClient().execute({
            sql:
              "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, computer_pairing_id, fallback_policy, updated_at," +
              " runtime_probe_job_id, runtime_probe_pairing_id, runtime_probe_engine_kind, runtime_probe_engine_name, runtime_probe_engine_version, runtime_probe_verified_at)" +
              " VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)" +
              " ON CONFLICT (tenant_id, user_id, agent_key) WHERE user_id IS NOT NULL AND agent_key = '__engine__' DO NOTHING",
            args: [tenantId, userId, ENGINE_AGENT_KEY, row.provider, row.model, row.computerPairingId, row.fallbackPolicy, now, ...proofArgs],
          })
        : await writeClient().execute({
            sql:
              "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = NULL, enabled = 1," +
              " computer_pairing_id = ?, fallback_policy = ?, updated_at = ?, runtime_probe_job_id = ?, runtime_probe_pairing_id = ?," +
              " runtime_probe_engine_kind = ?, runtime_probe_engine_name = ?, runtime_probe_engine_version = ?, runtime_probe_verified_at = ?" +
              " WHERE tenant_id = ? AND user_id = ? AND agent_key = ? AND updated_at = ?",
            args: [
              row.provider,
              row.model,
              row.computerPairingId,
              row.fallbackPolicy,
              now,
              ...proofArgs,
              tenantId,
              userId,
              ENGINE_AGENT_KEY,
              expectedVersion,
            ],
          });
    return result.rowsAffected === 1;
  }
  const result =
    expectedVersion === null
      ? await writeClient().execute({
          sql:
            "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, computer_pairing_id, fallback_policy, updated_at)" +
            " VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)" +
            " ON CONFLICT (tenant_id, user_id, agent_key) WHERE user_id IS NOT NULL AND agent_key = '__engine__' DO NOTHING",
          args: [tenantId, userId, ENGINE_AGENT_KEY, row.provider, row.model, row.computerPairingId, row.fallbackPolicy, now],
        })
      : await writeClient().execute({
          sql:
            "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = NULL, enabled = 1," +
            " computer_pairing_id = ?, fallback_policy = ?, updated_at = ?" +
            " WHERE tenant_id = ? AND user_id = ? AND agent_key = ? AND updated_at = ?",
          args: [
            row.provider,
            row.model,
            row.computerPairingId,
            row.fallbackPolicy,
            now,
            tenantId,
            userId,
            ENGINE_AGENT_KEY,
            expectedVersion,
          ],
        });
  return result.rowsAffected === 1;
}

/** CAS clear: inheritance is deletion, and cannot erase a newer selection. */
export async function clearPersonEngineIfCurrent(tenantId: string, userId: string, expectedVersion: string | null): Promise<boolean> {
  if (expectedVersion === null) return (await readPersonAgentEngineVersion(tenantId, userId)) === null;
  const result = await writeClient().execute({
    sql: "DELETE FROM agent_model_config WHERE tenant_id = ? AND user_id = ? AND agent_key = ? AND updated_at = ?",
    args: [tenantId, userId, ENGINE_AGENT_KEY, expectedVersion],
  });
  return result.rowsAffected === 1;
}

export type EffectiveAgentEngine = { source: "person" | "workspace"; engine: AgentEngineChoice; legacyUnbound: boolean };
export type EffectiveAgentEngineWithProof = EffectiveAgentEngine & {
  version: string | null;
  probeProof: SavedRuntimeProbeProof | null;
};

/** Canonical effective engine for dispatch and the consolidated AI Brain. */
export async function readEffectiveAgentEngine(tenantId: string, userId: string | null | undefined): Promise<EffectiveAgentEngine> {
  const { source, engine, legacyUnbound } = await readEffectiveAgentEngineWithProof(tenantId, userId);
  return { source, engine, legacyUnbound };
}

/** The same canonical selection plus the successful probe bound to this exact
 * row version. This richer shape is used only at execution/readiness gates;
 * the long-standing public reader above intentionally keeps its old shape. */
export async function readEffectiveAgentEngineWithProof(
  tenantId: string,
  userId: string | null | undefined,
): Promise<EffectiveAgentEngineWithProof> {
  const [personResult, workspaceResult, oasis] = await Promise.all([
    userId ? readEngineRow(tenantId, userId) : Promise.resolve({ data: null, error: null }),
    readEngineRow(tenantId, null),
    isOasisWorkspace(tenantId),
  ]);
  if (personResult.error) throw new Error(`person engine: agent_model_config read failed: ${personResult.error.message}`);
  if (workspaceResult.error) throw new Error(`agent engine: agent_model_config read failed: ${workspaceResult.error.message}`);
  const personRow = personResult.data;
  const workspaceRow = workspaceResult.data;
  const source = personRow ? "person" : "workspace";
  const selectedRow = personRow ?? workspaceRow;
  const engine = personRow
    ? engineFromCanonicalRow(personRow, true)
    : workspaceRow
      ? engineFromCanonicalRow(workspaceRow, false)
      : oasis
        ? OASIS_DEFAULT_ENGINE
        : { kind: "api" as const };
  const version = typeof selectedRow?.updated_at === "string" && selectedRow.updated_at ? selectedRow.updated_at : null;
  return {
    source,
    engine,
    legacyUnbound: engine.kind !== "api" && !engine.pairingId,
    version,
    probeProof: savedProbeProofFromRow(selectedRow, engine),
  };
}

/** A person's own engine choice (O3b): their own paired computer, or the workspace API key. */
export type PersonEngineChoice = { kind: "computer" } | { kind: "api" };

/** The person's choice precedes the workspace row; 'workspace' means nobody chose for themselves. */
export type EffectiveEngine = { source: "person"; kind: PersonEngineChoice["kind"] } | { source: "workspace"; engine: AgentEngineChoice };

export function isPersonEngineChoice(v: unknown): v is PersonEngineChoice["kind"] {
  return v === "computer" || v === "api";
}

/** A request body's choice ({kind:"computer"} / {kind:"api"}, or the bare string), or null when it is neither. */
export function parsePersonEngineChoice(raw: unknown): PersonEngineChoice | null {
  const kind = typeof raw === "string" ? raw : raw && typeof raw === "object" ? (raw as Record<string, unknown>).kind : null;
  return isPersonEngineChoice(kind) ? { kind } : null;
}

function personEngineRow(choice: PersonEngineChoice): { provider: string; model: string } {
  return { provider: choice.kind, model: "-" };
}

function personEngineFromRow(row: { provider?: unknown } | null | undefined): PersonEngineChoice | null {
  return isPersonEngineChoice(row?.provider) ? { kind: row!.provider as PersonEngineChoice["kind"] } : null;
}

/** This person's own engine row; null when they have not chosen (the workspace row answers instead). Throws when the read fails. */
export async function readPersonEngine(tenantId: string, userId: string): Promise<PersonEngineChoice | null> {
  const { data, error } = await getServiceSupabase()
    .from("agent_model_config")
    .select("provider")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("agent_key", ENGINE_AGENT_KEY)
    .maybeSingle();
  if (error) throw new Error(`person engine: agent_model_config read failed: ${error.message}`);
  return personEngineFromRow(data as { provider?: unknown } | null);
}

/**
 * Save THIS PERSON's own engine choice (one upsert on their own row; never
 * touches the workspace row). `userId` must be the SIGNED-IN person's own id
 * — the route this backs (app/api/agent-config/person-engine) is self-only,
 * never accepts a body-supplied user id (O0's lesson: the request body must
 * never pick who a write is for). Throws when the write fails.
 */
export async function savePersonEngine(tenantId: string, userId: string, choice: PersonEngineChoice): Promise<void> {
  const row = personEngineRow(choice);
  await writeClient().execute({
    sql:
      "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)" +
      " VALUES (?, ?, ?, ?, ?, NULL, 1, ?)" +
      " ON CONFLICT (tenant_id, user_id, agent_key) WHERE user_id IS NOT NULL AND agent_key = '__engine__'" +
      " DO UPDATE SET provider = excluded.provider, model = excluded.model, encrypted_api_key = NULL, updated_at = excluded.updated_at",
    args: [tenantId, userId, ENGINE_AGENT_KEY, row.provider, row.model, new Date().toISOString()],
  });
}

/** Clear this person's own engine row, so the workspace default answers for them again. Throws when the write fails. */
export async function clearPersonEngine(tenantId: string, userId: string): Promise<void> {
  await writeClient().execute({
    sql: "DELETE FROM agent_model_config WHERE tenant_id = ? AND user_id = ? AND agent_key = ?",
    args: [tenantId, userId, ENGINE_AGENT_KEY],
  });
}

/**
 * EFFECTIVE ENGINE (O3b): this person's own choice if they made one, else the
 * workspace's (readAgentEngine, unchanged -- O1's pause for a 'cli'/'local'
 * workspace default is NOT reproduced here; it stays exactly where it already
 * runs, in lib/os/runs/session.ts, so a person with no choice of their own
 * sees NO behaviour change). `userId` absent (no session) reads as no
 * person choice. Throws when either read fails.
 */
export async function readEffectiveEngine(tenantId: string, userId: string | null | undefined): Promise<EffectiveEngine> {
  const [person, workspace] = await Promise.all([
    userId ? readPersonEngine(tenantId, userId) : Promise.resolve(null),
    readAgentEngine(tenantId),
  ]);
  // The workspace AI account answers a person only where the workspace itself
  // runs on it (security review, O3b). A saved 'api' choice in a workspace whose
  // owner chose computers would otherwise spend the owner's key against that
  // choice, and in OASIS undo O1's pause. It is ignored, on every read, so a
  // workspace that switches away from the key takes everyone with it.
  if (person && !(person.kind === "api" && workspace.kind !== "api")) return { source: "person", kind: person.kind };
  return { source: "workspace", engine: workspace };
}

/** Whether a person may choose the workspace AI account here: only where the workspace itself runs on it. Throws when the read fails. */
export async function workspaceAllowsPersonApiChoice(tenantId: string): Promise<boolean> {
  return (await readAgentEngine(tenantId)).kind === "api";
}

type KeyRow = {
  agent_key: string;
  provider: string;
  model: string;
  encrypted_api_key: string | null;
  enabled: unknown;
  updated_at?: unknown;
};

async function teamKeyRows(tenantId: string): Promise<KeyRow[]> {
  const { data, error } = await getServiceSupabase()
    .from("agent_model_config")
    .select("agent_key, provider, model, encrypted_api_key, enabled, updated_at")
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
): Promise<{ encryptedApiKey: string; model: string; source: "kept" | "account" | "team"; updatedAt: string | null } | null> {
  const rows = (await teamKeyRows(tenantId)).filter((r) => r.provider === provider);
  const kept = rows.find((r) => r.agent_key === savedKeyAgentKey(provider));
  if (kept?.encrypted_api_key) {
    return {
      encryptedApiKey: kept.encrypted_api_key,
      model: kept.model,
      source: "kept",
      updatedAt: typeof kept.updated_at === "string" ? kept.updated_at : null,
    };
  }
  const account = rows.find((r) => r.agent_key === WORKSPACE_AI_AGENT_KEY && on(r.enabled));
  if (account?.encrypted_api_key) {
    return {
      encryptedApiKey: account.encrypted_api_key,
      model: account.model,
      source: "account",
      updatedAt: typeof account.updated_at === "string" ? account.updated_at : null,
    };
  }
  const team = rows.find((r) => !r.agent_key.startsWith("__") && on(r.enabled));
  if (team?.encrypted_api_key) {
    return {
      encryptedApiKey: team.encrypted_api_key,
      model: team.model,
      source: "team",
      updatedAt: typeof team.updated_at === "string" ? team.updated_at : null,
    };
  }
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
