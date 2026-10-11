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
 * PER-PERSON ENGINE (O3b, "your engine and your computer's status are
 * yours"). The workspace row above answers for everyone who has not chosen
 * for themselves. A person may save their OWN row instead -- agent_model_config,
 * the SAME agent_key ("__engine__"), but user_id = their own auth user id
 * (the partial unique index idx_agent_model_config_engine_per_user,
 * bravo__212, is one row per tenant+user+agent_key). Its vocabulary is
 * smaller than the workspace row's: 'computer' (Claude Code on MY OWN paired
 * computer, O3a's bridge_pairings -- never the workspace's shared tunnel) or
 * 'api' (the workspace API key). EFFECTIVE ENGINE precedence: the person's
 * own row, else the workspace row (readAgentEngine, unchanged, O1's pause
 * included), else the OASIS default inside it. NO KEY FALLBACK (Adon,
 * 2026-10-11): an explicit 'computer' choice is never silently answered on an
 * API key when the computer cannot be reached -- it is refused, with the
 * reason (lib/os/runs/session.ts).
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

/**
 * The workspace's engine choice. No row: OASIS's own workspace runs on the CLI
 * bridge (CC, 2026-10-09: "for my workspace they don't use API keys ... you
 * should know our workflow"), Claude Code by default; every other workspace
 * runs on its API account. Throws when the read fails.
 */
export async function readAgentEngine(tenantId: string): Promise<AgentEngineChoice> {
  const [{ data, error }, oasis] = await Promise.all([
    getServiceSupabase()
      .from("agent_model_config")
      .select("provider, model")
      .eq("tenant_id", tenantId)
      .is("user_id", null)
      .eq("agent_key", ENGINE_AGENT_KEY)
      .maybeSingle(),
    isOasisWorkspace(tenantId),
  ]);
  if (error) throw new Error(`agent engine: agent_model_config read failed: ${error.message}`);
  if (!data) return oasis ? OASIS_DEFAULT_ENGINE : { kind: "api" };
  return engineFromRow(data as { provider?: unknown; model?: unknown } | null);
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
export async function saveAgentEngineIfCurrent(tenantId: string, choice: AgentEngineChoice, expectedVersion: string | null): Promise<boolean> {
  const row = engineRow(choice);
  const now = new Date().toISOString();
  const res =
    expectedVersion === null
      ? await writeClient().execute({
          sql:
            "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)" +
            " VALUES (?, NULL, ?, ?, ?, NULL, 1, ?)" +
            " ON CONFLICT (tenant_id, agent_key) WHERE user_id IS NULL DO NOTHING",
          args: [tenantId, ENGINE_AGENT_KEY, row.provider, row.model, now],
        })
      : await writeClient().execute({
          sql:
            "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = NULL, enabled = 1, updated_at = ?" +
            " WHERE tenant_id = ? AND agent_key = ? AND user_id IS NULL AND updated_at = ?",
          args: [row.provider, row.model, now, tenantId, ENGINE_AGENT_KEY, expectedVersion],
        });
  return res.rowsAffected === 1;
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
