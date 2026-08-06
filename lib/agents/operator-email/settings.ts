/**
 * lib/agents/operator-email/settings.ts — the Operator Email Agent's config.
 *
 * One row per (tenant, operator) in agent_email_settings (migration 108) is
 * "the agent": its mode (off|monitor|draft|semi|full), which mailboxes it
 * watches, the daily send cap, and the poller cursor. Readiness also requires
 * the operator to have connected Gmail (the gmail_oauth bundle) with a
 * read-capable scope. Service-role only (RLS forced). Fail-closed: unknown /
 * missing config reads as `off`.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getUserIntegrationBundle } from "@/lib/user-integration-store";

export type AgentEmailMode = "off" | "monitor" | "draft" | "semi" | "full";
const MODES: AgentEmailMode[] = ["off", "monitor", "draft", "semi", "full"];

export interface AgentEmailSettings {
  tenantId: string;
  userId: string;
  mode: AgentEmailMode;
  workEnabled: boolean;
  personalEnabled: boolean;
  dailySendCap: number;
  lastProcessedAt: string | null;
}

const READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function coerceMode(m: unknown): AgentEmailMode {
  return typeof m === "string" && (MODES as string[]).includes(m) ? (m as AgentEmailMode) : "off";
}

function rowToSettings(r: Record<string, unknown>): AgentEmailSettings {
  return {
    tenantId: String(r.tenant_id),
    userId: String(r.user_id),
    mode: coerceMode(r.mode),
    workEnabled: r.work_enabled !== false,
    personalEnabled: r.personal_enabled === true,
    dailySendCap: Number(r.daily_send_cap ?? 100),
    lastProcessedAt: (r.last_processed_at as string) ?? null,
  };
}

/** Read one operator's agent settings. Missing row → a safe `off` default. */
export async function getAgentEmailSettings(tenantId: string, userId: string): Promise<AgentEmailSettings> {
  const off: AgentEmailSettings = {
    tenantId, userId, mode: "off", workEnabled: false, personalEnabled: false,
    dailySendCap: 0, lastProcessedAt: null,
  };
  if (!tenantId || !userId) return off;
  try {
    const r = await getServiceSupabase()
      .from("agent_email_settings")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("user_id", userId)
      .maybeSingle();
    if (r.error || !r.data) return off;
    return rowToSettings(r.data as Record<string, unknown>);
  } catch {
    return off; // fail closed
  }
}

/** All agents that are not `off`, ordered by cursor (poll the stalest first). */
export async function listActiveAgents(limit = 10): Promise<AgentEmailSettings[]> {
  try {
    const r = await getServiceSupabase()
      .from("agent_email_settings")
      .select("*")
      .neq("mode", "off")
      .order("last_processed_at", { ascending: true, nullsFirst: true })
      .limit(limit);
    if (r.error || !Array.isArray(r.data)) return [];
    return (r.data as Record<string, unknown>[]).map(rowToSettings);
  } catch {
    return [];
  }
}

/** Advance the poller cursor (call after a successful tick). Best-effort. */
/**
 * @param upToISO advance the cursor only this far. Used when a message was
 *   deferred (classification still running): the cursor must stay BEHIND that
 *   email so the next `after:` read still contains it, but it must still MOVE —
 *   `listActiveAgents` polls the stalest 10 agents, so an agent whose cursor is
 *   frozen holds a polling slot indefinitely and can starve newer agents out of
 *   the rotation entirely. Codex review 2026-08-04.
 */
export async function markProcessed(tenantId: string, userId: string, upToISO?: string): Promise<void> {
  try {
    const stamp = upToISO || new Date().toISOString();
    await getServiceSupabase()
      .from("agent_email_settings")
      .update({ last_processed_at: stamp, updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("user_id", userId);
  } catch { /* best-effort cursor */ }
}

/**
 * Is a given mailbox monitor-ready? Needs a connected bundle whose stored scope
 * includes gmail.readonly. Returns the connected address for logging/routing.
 */
export async function mailboxReady(
  tenantId: string,
  userId: string,
  mailbox: "work" | "personal",
): Promise<{ ready: boolean; address: string | null }> {
  const service = mailbox === "personal" ? "gmail_oauth_personal" : "gmail_oauth";
  try {
    const b = await getUserIntegrationBundle(tenantId, userId, service);
    const ready = !!b.refresh_token && !!b.gmail_address && (b.scope || "").includes(READONLY_SCOPE);
    return { ready, address: b.gmail_address || null };
  } catch {
    return { ready: false, address: null };
  }
}
