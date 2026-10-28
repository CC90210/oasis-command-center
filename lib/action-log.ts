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
import { redactAll } from "./secret-redaction";

const SNAPSHOT_KEYS = 40;
const SNAPSHOT_STRING = 500;
const SNAPSHOT_DEPTH = 3;
const SNAPSHOT_BYTES = 4_000;

function scrubbed(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactAll(value).slice(0, SNAPSHOT_STRING);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= SNAPSHOT_DEPTH) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, SNAPSHOT_KEYS).map((v) => scrubbed(v, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).slice(0, SNAPSHOT_KEYS).map(([k, v]) => [k, scrubbed(v, depth + 1)]),
    );
  }
  return String(value);
}

/**
 * What an agent's action asked to set, for the Execution trace (2026-10-28,
 * Codex review of #768: no producer recorded a snapshot, so the trace's field
 * view never appeared for a real action). Secrets scrubbed in every string,
 * at most 40 keys, 3 levels and 4 KB; null when there is nothing to show.
 */
export function actionSnapshot(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const copy = scrubbed(payload, 0) as Record<string, unknown>;
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
