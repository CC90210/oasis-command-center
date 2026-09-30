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
