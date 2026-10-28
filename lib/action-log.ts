/**
 * A6: Persist a dashboard-action result to agent_events so /runs can
 * show CC every mutation the chat agent has made. Never throws: the chat
 * stream must not break if the audit write fails.
 *
 * It logs its own failures (2026-09-30). It used to swallow them, including
 * the insert's returned error, which it never read, so a /runs log that
 * stayed empty could not be told apart from "no agent changed anything".
 * Returns whether the row was written, for callers and tests that care.
 */

import { getServiceSupabase } from "./supabase-server";
import { redactAll, redactTenantVaultSecrets, type VaultSecret } from "./secret-redaction";

const SNAPSHOT_KEYS = 40;
const SNAPSHOT_STRING = 500;
const SNAPSHOT_DEPTH = 3;
const SNAPSHOT_BYTES = 4_000;

function scrubbed(value: unknown, depth: number, scrub: (text: string) => string): unknown {
  if (typeof value === "string") return scrub(value).slice(0, SNAPSHOT_STRING);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= SNAPSHOT_DEPTH) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, SNAPSHOT_KEYS).map((v) => scrubbed(v, depth + 1, scrub));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, SNAPSHOT_KEYS)
        .map(([k, v]) => [scrub(k).slice(0, 80), scrubbed(v, depth + 1, scrub)]),
    );
  }
  return scrub(String(value)).slice(0, SNAPSHOT_STRING);
}

/**
 * What an agent's action ASKED to set, for the Execution trace (2026-10-28,
 * Codex review of #768): its request, not proof of what was written (a
 * handler may ignore a field, and a failed action wrote nothing), so it is
 * stored as `requested`, never as `after`. Every string and key is scrubbed of
 * environment secrets, URL key parameters AND the workspace's saved
 * credentials (`vault`, Codex review of #768) BEFORE it is shortened; at most
 * 40 keys, 3 levels and 4 KB; null when there is nothing to show. `vault`
 * null means the credentials could not be read: then nothing is kept, rather
 * than a request that may hold one of them in plain text.
 */
export function actionSnapshot(payload: unknown, vault: readonly VaultSecret[] | null): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (vault === null) return { note: "not kept: the workspace's saved credentials could not be checked" };
  const secrets = [...vault];
  const copy = scrubbed(payload, 0, (text) => redactTenantVaultSecrets(redactAll(text), secrets)) as Record<string, unknown>;
  if (Object.keys(copy).length === 0) return null;
  return JSON.stringify(copy).length <= SNAPSHOT_BYTES ? copy : { note: "too large to keep" };
}

export type LoggedAction = {
  agent_key: string;
  tenant_id: string;
  user_id: string;
  type: string;
  ok: boolean;
  summary?: string;
  error?: string;
  before?: unknown;
  after?: unknown;
  /** What the action asked to set (actionSnapshot): its request, not proof of what was written. */
  requested?: unknown;
};

export async function logAction(input: LoggedAction): Promise<boolean> {
  try {
    const db = getServiceSupabase();
    const r = await db.from("agent_events").insert({
      event_type: "dashboard_action",
      publisher_agent: input.agent_key,
      severity: input.ok ? "info" : "warn",
      payload: {
        type: input.type,
        ok: input.ok,
        summary: input.summary || null,
        error: input.error || null,
        before: input.before ?? null,
        after: input.after ?? null,
        requested: input.requested ?? null,
        tenant_id: input.tenant_id,
        user_id: input.user_id,
      },
      correlation_id: input.tenant_id,
    });
    if (r.error) {
      console.error("[action-log] agent_events insert failed", { type: input.type, tenant_id: input.tenant_id, error: r.error.message });
      return false;
    }
    return true;
  } catch (err) {
    console.error("[action-log] agent_events insert threw", { type: input.type, tenant_id: input.tenant_id, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
