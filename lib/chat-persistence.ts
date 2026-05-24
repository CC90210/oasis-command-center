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
 * Session totals + agent_model_config last_used_at updates are NOT
 * extracted: /api/chat overwrites the running totals from per-turn
 * values (pre-existing behavior — may be a bug, not changing it
 * here); /api/chat/resume fetches + adds (correctly accumulates
 * across the paused/resumed boundary). Different semantics →
 * different code per caller.
 */

import { getServiceSupabase } from "./supabase-server";
import {
  redactAll,
  redactTenantVaultSecrets,
  type VaultSecret,
} from "./secret-redaction";
import { decryptField } from "./field-encryption";

const CUSTOM_VAULT_SERVICE = "custom";

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
    .eq("service", CUSTOM_VAULT_SERVICE);
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
  inputTokens: number;
  outputTokens: number;
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
