/**
 * activity-feed.ts — actor-filtered activity timeline for the SunBiz audit page.
 *
 * CC's ask (2026-06-18): the audit log should show what each of the 5 actors —
 * the people Ezra / Jordan / Alex and the AI agents Helios / Solara — actually
 * did: team changes, sends (email/SMS/call), AI automations + stage changes,
 * and chats. v1 SURFACES signals we already capture (no new instrumentation) by
 * unioning four tables and normalizing to one row shape, resolvable + filterable
 * by actor. Gaps (precise AI attribution on some daemon sends, chat→tool→record
 * tracing) are deferred to a later "deeper instrumentation" pass.
 *
 * Sources (all tenant-scoped, each best-effort — a failing source is skipped,
 * never breaks the feed):
 *   - tenant_audit_log    team / invite / agent-config changes (human)
 *   - lead_interactions   email / SMS / call (human operator OR AI automation)
 *   - agent_events        AI stage-changes, automation/cron runs (agent)
 *   - chat_sessions       chats (human ↔ agent)
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTenantMembers } from "@/lib/team";

export type ActorName = "Ezra" | "Jordan" | "Alex" | "Helios" | "Solara";
export const KNOWN_ACTORS: ActorName[] = ["Ezra", "Jordan", "Alex", "Helios", "Solara"];

export type ActivityRow = {
  id: string;
  time: string;
  actor: string; // an ActorName, or "System" when unattributable
  actorType: "human" | "agent" | "system";
  action: string;
  target: string;
  detail: string;
  source: string;
};

/**
 * Map an automated source string (lead_interactions.agent_source or
 * agent_events.publisher_agent / cron name) to the owning AI agent, per the
 * Settings role split: Helios = sales / outreach / SMS / closing; Solara =
 * operational / backend / workflows / data. Returns null when it's not an
 * AI-attributable source (operator-initiated or system).
 */
export function resolveAgent(source: string | null | undefined): ActorName | null {
  const s = (source || "").trim().toLowerCase();
  if (!s) return null;
  if (s === "helios" || s === "solara") return s === "helios" ? "Helios" : "Solara";
  // Helios — sales / outbound / SMS follow-ups / the inquiry handoff.
  if (
    s.includes("cold_outreach") ||
    s.includes("sequence") ||
    s.includes("drip") ||
    s.includes("form_intake") ||
    s.includes("texttorrent")
  ) {
    return "Helios";
  }
  // Solara — operational / backend / data / underwriting.
  if (
    s.includes("follow_up") ||
    s.includes("daily_plan") ||
    s.includes("underwriting") ||
    s.includes("classifier") ||
    s.includes("renewal") ||
    s.includes("shop_out_sender")
  ) {
    return "Solara";
  }
  // Operator-initiated (manual_cc, dashboard_drawer, dashboard_conversations,
  // shop_out_send_batch) and system publishers (bravo, manifest-data, dashboard)
  // are NOT AI-attributable — caller resolves the human actor instead.
  return null;
}

/** Build email→name and authUserId→name maps for the 5 people (well, the
 *  tenant's real members). Reused for human attribution across sources. */
function buildHumanMaps(
  members: Array<{ auth_user_id: string | null; email: string; full_name: string; display_name: string | null }>,
): { byEmail: Map<string, string>; byId: Map<string, string> } {
  const byEmail = new Map<string, string>();
  const byId = new Map<string, string>();
  for (const m of members) {
    const name = (m.display_name || m.full_name || m.email || "").trim();
    if (!name) continue;
    if (m.email) byEmail.set(m.email.trim().toLowerCase(), name);
    if (m.auth_user_id) byId.set(m.auth_user_id, name);
  }
  return { byEmail, byId };
}

function jsonPreview(value: unknown, max = 160): string {
  if (value == null) return "";
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return "";
  }
}

/**
 * Aggregate the activity feed for a tenant. Optional `actor` filters to one of
 * the five known actors. Each source is queried independently and best-effort.
 */
export async function getActivityFeed(
  tenantId: string,
  opts: { actor?: string | null; limit?: number } = {},
): Promise<{ rows: ActivityRow[]; errors: string[] }> {
  const limit = opts.limit ?? 200;
  const perSource = 150;
  const db = getServiceSupabase();
  const errors: string[] = [];

  const members = await getTenantMembers(tenantId).catch(() => []);
  const { byEmail, byId } = buildHumanMaps(members);
  const human = (email?: string | null, userId?: string | null): string | null =>
    (email && byEmail.get(email.trim().toLowerCase())) || (userId && byId.get(userId)) || null;

  const out: ActivityRow[] = [];

  // 1. tenant_audit_log — team / invite / agent-config (human actors).
  try {
    const r = await db
      .from("tenant_audit_log")
      .select("id, actor_email, actor_user_id, action_type, target_table, target_id, after, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(perSource);
    for (const row of (r.data || []) as Array<Record<string, unknown>>) {
      const actor = human(row.actor_email as string, row.actor_user_id as string);
      out.push({
        id: `audit:${row.id}`,
        time: String(row.created_at || ""),
        actor: actor || String(row.actor_email || "System"),
        actorType: actor ? "human" : "system",
        action: String(row.action_type || "change"),
        target: String(row.target_table || ""),
        detail: jsonPreview(row.after),
        source: "team/settings",
      });
    }
  } catch (e) {
    errors.push(`audit_log: ${e instanceof Error ? e.message : "failed"}`);
  }

  // 2. lead_interactions — sends. Human when an operator queued it; otherwise
  //    attribute to the AI agent that owns the automated source.
  try {
    const r = await db
      .from("lead_interactions")
      .select("id, type, channel, direction, agent_source, actor_user_id, metadata, to_email, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(perSource);
    for (const row of (r.data || []) as Array<Record<string, unknown>>) {
      const md = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>;
      const reqEmail = typeof md.requested_by_email === "string" ? md.requested_by_email : null;
      const h = human(reqEmail, row.actor_user_id as string);
      const agent = h ? null : resolveAgent(row.agent_source as string);
      const actor = h || agent || "System";
      out.push({
        id: `li:${row.id}`,
        time: String(row.created_at || ""),
        actor,
        actorType: h ? "human" : agent ? "agent" : "system",
        action: String(row.type || `${row.channel || "message"} ${row.direction || ""}`).trim(),
        target: row.to_email ? `→ ${row.to_email}` : String(row.channel || ""),
        detail: String(row.agent_source || ""),
        source: "comms",
      });
    }
  } catch (e) {
    errors.push(`lead_interactions: ${e instanceof Error ? e.message : "failed"}`);
  }

  // 3. agent_events — AI stage-changes + automation/cron runs. Scope is the
  //    correlation_id (this table has no tenant_id column).
  try {
    const r = await db
      .from("agent_events")
      .select("id, event_type, publisher_agent, payload, created_at, published_at")
      .eq("correlation_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(perSource);
    for (const row of (r.data || []) as Array<Record<string, unknown>>) {
      const agent = resolveAgent(row.publisher_agent as string);
      // Only surface AI-attributable events here; operator/system events come
      // through the audit + comms sources already.
      if (!agent) continue;
      const payload = (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>;
      const target = payload.entity
        ? `${payload.entity}${payload.record_id ? ` ${String(payload.record_id).slice(0, 8)}` : ""}`
        : "";
      out.push({
        id: `ev:${row.id}`,
        time: String(row.created_at || row.published_at || ""),
        actor: agent,
        actorType: "agent",
        action: String(row.event_type || "event"),
        target,
        detail: jsonPreview(payload),
        source: "automation",
      });
    }
  } catch (e) {
    errors.push(`agent_events: ${e instanceof Error ? e.message : "failed"}`);
  }

  // 4. chat_sessions — chats (human ↔ agent).
  try {
    const r = await db
      .from("chat_sessions")
      .select("id, agent_key, user_id, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(perSource);
    for (const row of (r.data || []) as Array<Record<string, unknown>>) {
      const h = human(null, row.user_id as string);
      const agentKey = resolveAgent(row.agent_key as string);
      out.push({
        id: `chat:${row.id}`,
        time: String(row.created_at || ""),
        actor: h || agentKey || "System",
        actorType: h ? "human" : agentKey ? "agent" : "system",
        action: "chat session",
        target: agentKey ? `with ${agentKey}` : String(row.agent_key || ""),
        detail: "",
        source: "chat",
      });
    }
  } catch (e) {
    errors.push(`chat_sessions: ${e instanceof Error ? e.message : "failed"}`);
  }

  // Merge, newest first, optional actor filter, cap.
  let rows = out.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  const wantActor = (opts.actor || "").trim();
  if (wantActor && (KNOWN_ACTORS as string[]).includes(wantActor)) {
    rows = rows.filter((row) => row.actor === wantActor);
  }
  return { rows: rows.slice(0, limit), errors };
}
