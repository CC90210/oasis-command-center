/**
 * activity-feed.ts — actor-filtered activity timeline for the SunBiz audit page.
 *
 * CC's ask (2026-06-18): the audit log should show what each of the 5 actors —
 * the people Matt / Jordan / Alex and the AI agents Helios / Solara — actually
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
 *
 * WRITE SIDE (added 2026-07-23, B2): logTenantAudit() below is the write
 * counterpart to the tenant_audit_log read above. Best-effort, same
 * convention as lib/esign/db.ts::logEvent() — a failed audit write is
 * reported to the caller but must never block the primary action it's
 * logging (e.g. an e-sign envelope completing).
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTenantMembers } from "@/lib/team";

export type ActorName = "Matt" | "Jordan" | "Alex" | "Helios" | "Solara";
export const KNOWN_ACTORS: ActorName[] = ["Matt", "Jordan", "Alex", "Helios", "Solara"];

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

const KNOWN_HUMANS = ["Matt", "Jordan", "Alex"] as const;

/** Canonicalize a member's stored name to one of the known actor labels so the
 *  actor chips match even when the profile name is "Jordan Colleson" rather
 *  than "Jordan". (Codex audit 2026-06-18: exact-name filter could miss.) */
function canonHuman(name: string): string {
  const first = name.trim().split(/\s+/)[0]?.toLowerCase() || "";
  return KNOWN_HUMANS.find((k) => k.toLowerCase() === first) || name;
}

/** Build email→name and authUserId→name maps for the tenant's real members,
 *  canonicalized to the known actor labels. Reused for human attribution. */
function buildHumanMaps(
  members: Array<{ auth_user_id: string | null; email: string; full_name: string; display_name: string | null }>,
): { byEmail: Map<string, string>; byId: Map<string, string> } {
  const byEmail = new Map<string, string>();
  const byId = new Map<string, string>();
  for (const m of members) {
    const raw = (m.display_name || m.full_name || m.email || "").trim();
    if (!raw) continue;
    const name = canonHuman(raw);
    if (m.email) byEmail.set(m.email.trim().toLowerCase(), name);
    if (m.auth_user_id) byId.set(m.auth_user_id, name);
  }
  return { byEmail, byId };
}

// Keys whose VALUES must never be rendered into the admin activity feed: signed
// form-link tokens (grant access to a merchant's application), and KYC / banking
// fields. (Codex audit 2026-06-18 [medium]: raw payload preview leaked these.)
const SENSITIVE_KEY = /(url|token|signature|ssn|dob|birth|tax_id|ein|account_number|routing|secret|password)/i;

/** VALUE-side scrub: redact sensitive content regardless of its key — a signed
 *  form-link URL (grants access to a merchant's application), an SSN, or a long
 *  account/EIN/routing digit-run can ride under a benign key like `message` or
 *  `value`. (Codex audit 2026-06-18 [high]: key-only masking leaked these.) */
function scrubValue(s: string): string {
  return s
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[link]")
    .replace(/\b\d{3}-?\d{2}-?\d{4}\b/g, "[redacted]") // SSN-shaped
    .replace(/\b\d{9,}\b/g, "[redacted]"); // EIN / account / routing / long ids
}

/** Redacting preview for the admin feed: shallow-renders an object with
 *  sensitive KEYS masked, nested objects collapsed (so agent_events.payload.data
 *  — the full post-update record — can't dump), and every scalar VALUE scrubbed
 *  for sensitive content. Defense-in-depth: the serialized output is scrubbed
 *  once more as a catch-all. */
function safeDetail(value: unknown, max = 160): string {
  if (value == null) return "";
  if (typeof value === "string") return scrubValue(value).slice(0, max);
  if (typeof value !== "object") return String(value).slice(0, max);
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k)) safe[k] = "[redacted]";
    else if (v !== null && typeof v === "object") safe[k] = "{…}";
    else if (typeof v === "string") safe[k] = scrubValue(v);
    else safe[k] = v;
  }
  try {
    const scrubbed = scrubValue(JSON.stringify(safe));
    return scrubbed.length > max ? `${scrubbed.slice(0, max)}…` : scrubbed;
  } catch {
    return "";
  }
}

/**
 * Write one row to tenant_audit_log. Only the columns already consumed by
 * getActivityFeed() (above) and components/settings/OperationsTrackerPanel.tsx
 * are written — id/created_at are DB-defaulted. Best-effort: a failed write
 * is returned as { ok: false } for the caller to log, never thrown, so a
 * blip in the audit table can't fail the action being audited.
 */
export async function logTenantAudit(input: {
  tenantId: string;
  actorEmail?: string | null;
  actorUserId?: string | null;
  actionType: string;
  targetTable: string;
  targetId?: string | null;
  after?: Record<string, unknown> | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const db = getServiceSupabase();
    const ins = await db.from("tenant_audit_log").insert({
      tenant_id: input.tenantId,
      actor_email: input.actorEmail ?? null,
      actor_user_id: input.actorUserId ?? null,
      action_type: input.actionType,
      target_table: input.targetTable,
      target_id: input.targetId ?? null,
      after: input.after ?? {},
    });
    if (ins.error) return { ok: false, error: ins.error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "insert_failed" };
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
  // auth_user_id is the authoritative, server-stamped identity; resolve it
  // FIRST and only fall back to a metadata-supplied email (which can be stale /
  // operator-typed). (Codex audit 2026-06-18 [medium].)
  const human = (email?: string | null, userId?: string | null): string | null =>
    (userId && byId.get(userId)) || (email && byEmail.get(email.trim().toLowerCase())) || null;

  const out: ActivityRow[] = [];

  // 1. tenant_audit_log — team / invite / agent-config (human actors).
  try {
    const r = await db
      .from("tenant_audit_log")
      .select("id, actor_email, actor_user_id, action_type, target_table, target_id, after, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(perSource);
    // Supabase query errors don't throw — surface them via the per-source catch
    // below (each pushes a labelled entry to `errors`) instead of silently
    // rendering the source empty. (Codex audit 2026-06-18 [medium].)
    if (r.error) throw new Error(r.error.message);
    for (const row of (r.data || []) as Array<Record<string, unknown>>) {
      const actor = human(row.actor_email as string, row.actor_user_id as string);
      out.push({
        id: `audit:${row.id}`,
        time: String(row.created_at || ""),
        actor: actor || String(row.actor_email || "System"),
        actorType: actor ? "human" : "system",
        action: String(row.action_type || "change"),
        target: String(row.target_table || ""),
        detail: safeDetail(row.after),
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
    // Supabase query errors don't throw — surface them via the per-source catch
    // below (each pushes a labelled entry to `errors`) instead of silently
    // rendering the source empty. (Codex audit 2026-06-18 [medium].)
    if (r.error) throw new Error(r.error.message);
    for (const row of (r.data || []) as Array<Record<string, unknown>>) {
      const md = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>;
      const reqEmail = typeof md.requested_by_email === "string" ? md.requested_by_email : null;
      const h = human(reqEmail, row.actor_user_id as string);
      // Inbound is the MERCHANT replying — never an internal agent's action.
      // Only attribute an AI agent to outbound/system automated rows. (Codex
      // audit 2026-06-18 [medium]: inbound texttorrent was credited to Helios.)
      const agent = h || row.direction === "inbound" ? null : resolveAgent(row.agent_source as string);
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
    // Supabase query errors don't throw — surface them via the per-source catch
    // below (each pushes a labelled entry to `errors`) instead of silently
    // rendering the source empty. (Codex audit 2026-06-18 [medium].)
    if (r.error) throw new Error(r.error.message);
    for (const row of (r.data || []) as Array<Record<string, unknown>>) {
      const agent = resolveAgent(row.publisher_agent as string);
      // Only surface AI-attributable events here; operator/system events come
      // through the audit + comms sources already.
      if (!agent) continue;
      const payload = (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>;
      // Defensive tenant boundary: agent_events has no tenant_id column (scoped
      // by correlation_id, a generic text field with no DB constraint). If a
      // payload carries an explicit tenant_id that disagrees, drop it so a
      // mis-stamped producer can't leak another tenant's event into this admin
      // feed. (Codex audit 2026-06-18 [medium].)
      if (typeof payload.tenant_id === "string" && payload.tenant_id !== tenantId) continue;
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
        detail: safeDetail(payload),
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
    // Supabase query errors don't throw — surface them via the per-source catch
    // below (each pushes a labelled entry to `errors`) instead of silently
    // rendering the source empty. (Codex audit 2026-06-18 [medium].)
    if (r.error) throw new Error(r.error.message);
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

  // 5. tenant_cron_jobs — agent automation runs, attributed by agent_key
  //    (helios / solara). The table keeps only the LATEST run per job (not full
  //    history), so this surfaces the most recent run of each scheduled job —
  //    the clearest "Solara ran the daily plan" / "Helios ran cold outreach"
  //    signal, which agent_events doesn't currently attribute to a named agent.
  try {
    const r = await db
      .from("tenant_cron_jobs")
      .select("id, name, agent_key, schedule, last_run_at, last_run_status, run_count")
      .eq("tenant_id", tenantId)
      .not("last_run_at", "is", null)
      .order("last_run_at", { ascending: false })
      .limit(perSource);
    // Supabase query errors don't throw — surface them via the per-source catch
    // below (each pushes a labelled entry to `errors`) instead of silently
    // rendering the source empty. (Codex audit 2026-06-18 [medium].)
    if (r.error) throw new Error(r.error.message);
    for (const row of (r.data || []) as Array<Record<string, unknown>>) {
      const agent = resolveAgent(row.agent_key as string);
      if (!agent) continue;
      out.push({
        id: `cron:${row.id}`,
        time: String(row.last_run_at || ""),
        actor: agent,
        actorType: "agent",
        action: `ran "${row.name}"`,
        target: String(row.schedule || ""),
        detail: `${row.last_run_status || ""}${row.run_count ? ` · ${row.run_count} runs` : ""}`.trim(),
        source: "automation",
      });
    }
  } catch (e) {
    errors.push(`cron_jobs: ${e instanceof Error ? e.message : "failed"}`);
  }

  // Merge, newest first, optional actor filter, cap.
  let rows = out.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  const wantActor = (opts.actor || "").trim();
  if (wantActor && (KNOWN_ACTORS as string[]).includes(wantActor)) {
    rows = rows.filter((row) => row.actor === wantActor);
  }
  return { rows: rows.slice(0, limit), errors };
}
