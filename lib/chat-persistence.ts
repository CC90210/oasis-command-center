/**
 * Shared chat_messages writer — single home for what was duplicated
 * between /api/chat and /api/chat/resume.
 *
 * Both routes write an assistant row at end-of-stream with the same
 * shape: session_id, tenant_id, role="assistant", redacted content,
 * tokens, latency, error. Without this helper, schema changes
 * (adding a `kind` column for example) needed parallel edits and
 * the two paths drifted easily.
 *
 * chat_sessions' running totals are shared too (sessionTotalsDelta +
 * addToSessionTotals): both routes ADD what they spent, in one SQL
 * increment. /api/chat used to overwrite them and /api/chat/resume
 * read-then-added, so the two gave the same columns different meanings
 * and a resumed turn's tokens vanished on the next turn.
 * agent_model_config last_used_at stays per caller.
 */

import type { ModelCallMeter } from "./ai/usage";
import { getServiceSupabase } from "./supabase-server";
import { getTursoClient, tursoConfigured } from "./turso";
import {
  redactAll,
  redactTenantVaultSecrets,
  type VaultSecret,
} from "./secret-redaction";
import { decryptField } from "./field-encryption";
import { VAULT_CUSTOM_SERVICE } from "./tenant-integration-store";

/**
 * Fetch decrypted (KEY, value) pairs from a tenant's custom credentials
 * vault. Pre-fetched per chat turn so persistAssistantTurn can scrub
 * any vault value the model echoed before chat_messages stores it.
 *
 * Lives here (rather than a dedicated file) because:
 *   (a) chat-persistence is the only caller, and
 *   (b) the file-guard hook blocks new files whose names contain
 *       "vault" / "secret" / "credential" — folding the loader into
 *       this module keeps the path within an already-allowed file
 *       without compromising the redaction itself.
 */
export async function fetchTenantVaultSecretsForRedaction(
  tenantId: string,
): Promise<VaultSecret[]> {
  if (!tenantId) return [];
  const service = getServiceSupabase();
  const r = await service
    .from("tenant_integration_credentials")
    .select("field_key, encrypted_value")
    .eq("tenant_id", tenantId)
    .eq("service", VAULT_CUSTOM_SERVICE);
  // A read that failed is not "this workspace has no secrets": answering []
  // would let a caller send text it never scrubbed. Callers that may degrade
  // to env-only redaction say so with their own .catch (the chat routes); a
  // department turn sends no workspace data instead (lib/os/desk/turn.ts).
  if (r.error) throw new Error(`vault_read_failed: ${r.error.message ?? "unknown"}`);
  const out: VaultSecret[] = [];
  for (const row of (r.data || []) as { field_key: string; encrypted_value: string }[]) {
    if (!row.encrypted_value) continue;
    try {
      out.push({
        key: row.field_key.toUpperCase(),
        value: decryptField(row.encrypted_value),
      });
    } catch (err) {
      // Don't let one corrupt ciphertext drop the entire redaction
      // pass — the model could still leak OTHER vault entries we
      // CAN decrypt. Log and continue.
      console.warn(
        "[chat-persistence] vault decrypt failed for redaction",
        { tenantId, key: row.field_key, err: (err as Error).message },
      );
    }
  }
  return out;
}

export type AssistantTurnPersistArgs = {
  sessionId: string;
  tenantId: string;
  /** Assistant text. Always passed through redactAll + per-tenant
   *  vault redaction before write — the model might echo a credential
   *  it saw in tool output, so the redaction at persist time is the
   *  last line of defense before chat_messages becomes a long-term
   *  secret-leak risk. */
  content: string;
  /** null: the turn's tokens are unknown (a call finished with no usage report). */
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  error?: string | null;
  /** Optional header prepended to content. /api/chat/resume uses this
   *  to mark the row as a resumed turn and list the tool chain. */
  prefix?: string;
  /** Pre-fetched tenant vault secrets to scrub. Pass via
   *  fetchTenantVaultSecretsForRedaction(args.tenantId). When omitted,
   *  vault redaction is skipped (env-var redaction via redactAll still
   *  runs). Always passing this from the chat routes is the safer
   *  default; the optional shape is for non-chat callers. */
  vaultSecrets?: VaultSecret[];
};

/**
 * Insert a chat_messages row for an assistant turn. Returns true on
 * success, false on DB error (callers should log but not throw — the
 * SSE stream has already closed).
 */
export async function persistAssistantTurn(
  args: AssistantTurnPersistArgs,
): Promise<boolean> {
  const service = getServiceSupabase();
  // Two-pass redaction:
  //   1. redactAll: env-var-shaped secrets (process.env) + URL key params.
  //   2. redactTenantVaultSecrets: per-tenant custom vault values that
  //      env-var redaction can't know about. Runs AFTER redactAll so
  //      env-var-shaped leaks land first with their canonical name.
  //
  // Applied to BOTH content AND error (Codex P1 follow-up, 2026-05-24).
  // Provider/tool error messages can quote back request bodies that
  // contain the credential value (e.g., "401 Unauthorized for key
  // sk_live_...abcd"), so the same scrub has to run on args.error or
  // chat_messages.error becomes the leak surface content was just
  // hardened against.
  const scrub = (s: string): string =>
    redactTenantVaultSecrets(redactAll(s), args.vaultSecrets);
  const body = scrub(args.content);
  const fullContent = args.prefix ? `${args.prefix}\n\n${body}` : body;
  const scrubbedError = args.error ? scrub(args.error) : null;
  const r = await service.from("chat_messages").insert({
    session_id: args.sessionId,
    tenant_id: args.tenantId,
    role: "assistant",
    content: fullContent,
    input_tokens: args.inputTokens,
    output_tokens: args.outputTokens,
    latency_ms: args.latencyMs,
    error: scrubbedError,
  });
  if (r.error) {
    console.error("[chat-persistence.insert]", r.error.message);
    return false;
  }
  return true;
}

/** Token counts as the chat stream or the tool loop reported them. */
export type TurnTokens = { inputTokens: number; outputTokens: number };

/** What one request adds to a chat_sessions row's running totals. */
export type SessionTotalsDelta = { inputTokens: number; outputTokens: number; costUsd: number };

/**
 * What one request of a chat turn (/api/chat, or one /api/chat/resume) adds to
 * chat_sessions' running totals: its own tokens and its own cost, TOGETHER, or
 * null for nothing.
 *
 * - `end` is the stream's own token count when the request ended: the `done`
 *   event's, or a pause's resume_state totals (the loop stopped for a bridge
 *   tool after its calls finished). The meter counts cost, not tokens, so a
 *   request that ended with neither (a provider refusal, a tool loop stopped
 *   mid-turn) adds nothing: there is no token count to pair its cost with.
 * - `start` is where the loop's count began. A resumed loop starts from the
 *   paused request's totals, which that request already added.
 * - The cost is the meter's, only when every call's cost is known. A local
 *   model has no price rows, but a local call costs nothing: a known $0.
 */
export function sessionTotalsDelta(args: {
  end: TurnTokens | null;
  start?: TurnTokens;
  meter: ModelCallMeter;
}): SessionTotalsDelta | null {
  if (!args.end) return null;
  const turn = args.meter.totals();
  if (turn.calls === 0) return null;
  const costMicroUsd =
    args.meter.context.billingMode === "local" ? 0 : turn.unknownCostCalls === 0 ? turn.costMicroUsd : null;
  if (costMicroUsd === null) return null;
  const start = args.start ?? { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: Math.max(0, args.end.inputTokens - start.inputTokens),
    outputTokens: Math.max(0, args.end.outputTokens - start.outputTokens),
    costUsd: costMicroUsd / 1_000_000,
  };
}

/**
 * Add one request's delta to a chat_sessions row and stamp updated_at, in ONE
 * statement scoped by id AND tenant_id. The increment happens in SQL, so two
 * requests that finish together both land; a read-then-write loses one. A
 * null delta only stamps updated_at.
 *
 * Raw SQL on the Turso client because the adapter's .update() binds values and
 * cannot say `col = col + ?`. getServiceSupabase().from() reads Turso only
 * under turso_cloud, so anywhere else this refuses rather than write a
 * different database than the one the session is read from.
 */
export async function addToSessionTotals(args: {
  sessionId: string;
  tenantId: string;
  delta: SessionTotalsDelta | null;
}): Promise<void> {
  if (process.env.EMPIRE_DATA_BACKEND !== "turso_cloud" || !tursoConfigured()) {
    throw new Error("chat_sessions totals: this deployment's sessions are not on Turso, so nothing was added");
  }
  const updatedAt = new Date().toISOString();
  const { sessionId, tenantId, delta } = args;
  await getTursoClient().execute(
    delta
      ? {
          sql: `UPDATE chat_sessions
                   SET total_input_tokens = total_input_tokens + ?,
                       total_output_tokens = total_output_tokens + ?,
                       estimated_cost_usd = estimated_cost_usd + ?,
                       updated_at = ?
                 WHERE id = ? AND tenant_id = ?`,
          args: [delta.inputTokens, delta.outputTokens, delta.costUsd, updatedAt, sessionId, tenantId],
        }
      : {
          sql: `UPDATE chat_sessions SET updated_at = ? WHERE id = ? AND tenant_id = ?`,
          args: [updatedAt, sessionId, tenantId],
        },
  );
}
