/**
 * Tenant-scoped activity timeline.
 *
 * Human actors come from this tenant's user_profiles rows and agent actors
 * come from this tenant's enabled manifest agents. There is deliberately no
 * platform-wide fallback roster: missing attribution renders as System instead
 * of leaking another workspace's people or personas.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { canonicalizeTenantMembers, getTenantMembers, type MemberRow } from "@/lib/team";
import { getTenantManifestForUser } from "@/lib/manifest/tenant-scope";
import { AGENT_REGISTRY, resolveAgentKey } from "@/lib/agents";
import { resolveEnabledAgentSlugs } from "@/lib/manifest/agent-roster";

export type ActivityActor = {
  /** Stable filter key. Display labels can be renamed or duplicated. */
  key: string;
  label: string;
  type: "human" | "agent" | "system";
};

export type ActivityRow = {
  id: string;
  time: string;
  actorKey: string;
  actor: string;
  actorType: "human" | "agent" | "system";
  action: string;
  target: string;
  detail: string;
  source: string;
};

const SYSTEM_ACTOR: ActivityActor = { key: "system", label: "System", type: "system" };

export function memberActivityLabel(
  member: Pick<MemberRow, "display_name" | "full_name" | "email">,
): string {
  return (member.display_name || member.full_name || member.email || "Team member").trim();
}

/** Build authoritative identity maps from this tenant's actual members. */
export function buildHumanActorMaps(
  members: MemberRow[],
): {
  actors: ActivityActor[];
  byEmail: Map<string, ActivityActor>;
  byId: Map<string, ActivityActor>;
} {
  const actors: ActivityActor[] = [];
  const byEmail = new Map<string, ActivityActor>();
  const byId = new Map<string, ActivityActor>();
  for (const member of canonicalizeTenantMembers(members)) {
    const actor: ActivityActor = {
      key: `human:${member.id}`,
      label: memberActivityLabel(member),
      type: "human",
    };
    actors.push(actor);
    if (member.email) byEmail.set(member.email.trim().toLowerCase(), actor);
    if (member.auth_user_id) byId.set(member.auth_user_id, actor);
  }
  return { actors, byEmail, byId };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve an automated source only against this tenant's enabled agents.
 * Direct slug/name matches work for every tenant. Legacy funding aliases are
 * considered only if that specific agent is enabled for this workspace.
 */
export function resolveActivityAgent(
  source: string | null | undefined,
  agents: ActivityActor[],
): ActivityActor | null {
  const normalized = (source || "").trim().toLowerCase();
  if (!normalized) return null;

  for (const agent of agents) {
    const slug = agent.key.replace(/^agent:/, "").toLowerCase();
    const label = agent.label.toLowerCase();
    const slugBoundary = new RegExp(`(^|[^a-z0-9])${escapeRegex(slug)}([^a-z0-9]|$)`);
    if (normalized === slug || normalized === label || slugBoundary.test(normalized)) {
      return agent;
    }
  }

  const bySlug = new Map(
    agents.map((agent) => [agent.key.replace(/^agent:/, "").toLowerCase(), agent]),
  );
  if (
    normalized.includes("cold_outreach") ||
    normalized.includes("sequence") ||
    normalized.includes("drip") ||
    normalized.includes("form_intake") ||
    normalized.includes("texttorrent")
  ) {
    return bySlug.get("helios") || null;
  }
  if (
    normalized.includes("sunbiz") ||
    normalized.includes("follow_up") ||
    normalized.includes("daily_plan") ||
    normalized.includes("underwriting") ||
    normalized.includes("classifier") ||
    normalized.includes("renewal") ||
    normalized.includes("shop_out_sender")
  ) {
    return bySlug.get("solara") || null;
  }
  return null;
}

/** True when a source explicitly names a registered agent outside the roster. */
export function sourceNamesDisabledAgent(
  source: string | null | undefined,
  enabledAgents: ActivityActor[],
): boolean {
  const normalized = (source || "").trim().toLowerCase();
  if (!normalized) return false;
  const enabled = new Set(
    enabledAgents.map((agent) => resolveAgentKey(agent.key.replace(/^agent:/, "")).toLowerCase()),
  );
  const familyAgent =
    normalized.includes("cold_outreach") ||
    normalized.includes("sequence") ||
    normalized.includes("drip") ||
    normalized.includes("form_intake") ||
    normalized.includes("texttorrent")
      ? "helios"
      : normalized.includes("sunbiz") ||
          normalized.includes("follow_up") ||
          normalized.includes("daily_plan") ||
          normalized.includes("underwriting") ||
          normalized.includes("classifier") ||
          normalized.includes("renewal") ||
          normalized.includes("shop_out_sender")
        ? "solara"
        : null;
  if (familyAgent && !enabled.has(familyAgent)) return true;
  return Object.keys(AGENT_REGISTRY).some((key) => {
    const resolved = resolveAgentKey(key).toLowerCase();
    const boundary = new RegExp(`(^|[^a-z0-9])${escapeRegex(key.toLowerCase())}([^a-z0-9]|$)`);
    return boundary.test(normalized) && !enabled.has(resolved);
  });
}

function dedupeActors(actors: ActivityActor[]): ActivityActor[] {
  const seen = new Set<string>();
  return actors.filter((actor) => {
    if (seen.has(actor.key)) return false;
    seen.add(actor.key);
    return true;
  });
}

async function loadTenantAgents(tenantId: string): Promise<ActivityActor[]> {
  const manifest = await getTenantManifestForUser(tenantId).catch(() => null);
  const bindings = manifest?.agents || [];
  const enabledSlugs = resolveEnabledAgentSlugs({
    manifestAgents: manifest ? bindings : null,
  });
  return enabledSlugs.map((slug) => {
    const binding = bindings.find(
      (agent) => resolveAgentKey(agent.slug.toLowerCase()) === slug,
    );
    return {
      key: `agent:${slug}`,
      label: binding?.display_name || binding?.slug || slug,
      type: "agent" as const,
    };
  });
}

// Keys whose values must never render in the activity feed.
const SENSITIVE_KEY =
  /(url|token|signature|ssn|dob|birth|tax_id|ein|account_number|routing|secret|password)/i;

function scrubValue(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[link]")
    .replace(/\b\d{3}-?\d{2}-?\d{4}\b/g, "[redacted]")
    .replace(/\b\d{9,}\b/g, "[redacted]");
}

function safeDetail(value: unknown, max = 160): string {
  if (value == null) return "";
  if (typeof value === "string") return scrubValue(value).slice(0, max);
  if (typeof value !== "object") return String(value).slice(0, max);
  const safe: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) safe[key] = "[redacted]";
    else if (item !== null && typeof item === "object") safe[key] = "{…}";
    else if (typeof item === "string") safe[key] = scrubValue(item);
    else safe[key] = item;
  }
  try {
    const serialized = scrubValue(JSON.stringify(safe));
    return serialized.length > max ? `${serialized.slice(0, max)}…` : serialized;
  } catch {
    return "";
  }
}

/** Best-effort audit write; a logging failure never blocks the primary action. */
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
    const result = await db.from("tenant_audit_log").insert({
      tenant_id: input.tenantId,
      actor_email: input.actorEmail ?? null,
      actor_user_id: input.actorUserId ?? null,
      action_type: input.actionType,
      target_table: input.targetTable,
      target_id: input.targetId ?? null,
      after: input.after ?? {},
    });
    if (result.error) return { ok: false, error: result.error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "insert_failed" };
  }
}

export type ActivityFeedOptions = {
  actor?: string | null;
  limit?: number;
  /** Test/consumer injection: production callers omit these. */
  db?: ReturnType<typeof getServiceSupabase>;
  members?: MemberRow[];
  agents?: ActivityActor[];
};

/** Aggregate the activity feed. Every source is independently tenant-scoped. */
export async function getActivityFeed(
  tenantId: string,
  opts: ActivityFeedOptions = {},
): Promise<{ rows: ActivityRow[]; actors: ActivityActor[]; errors: string[] }> {
  const limit = opts.limit ?? 200;
  const perSource = 150;
  const db = opts.db ?? getServiceSupabase();
  const errors: string[] = [];
  const members = opts.members ?? (await getTenantMembers(tenantId).catch(() => []));
  const humanMaps = buildHumanActorMaps(members);
  const agentActors = dedupeActors(opts.agents ?? (await loadTenantAgents(tenantId)));
  const human = (email?: string | null, userId?: string | null): ActivityActor | null =>
    (userId && humanMaps.byId.get(userId)) ||
    (email && humanMaps.byEmail.get(email.trim().toLowerCase())) ||
    null;
  const out: ActivityRow[] = [];

  const push = (row: Omit<ActivityRow, "actorKey" | "actor" | "actorType">, actor: ActivityActor) => {
    out.push({
      ...row,
      actorKey: actor.key,
      actor: actor.label,
      actorType: actor.type,
    });
  };

  try {
    const result = await db
      .from("tenant_audit_log")
      .select("id, actor_email, actor_user_id, action_type, target_table, target_id, after, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(perSource);
    if (result.error) throw new Error(result.error.message);
    for (const row of (result.data || []) as Array<Record<string, unknown>>) {
      const actor = human(row.actor_email as string, row.actor_user_id as string) || SYSTEM_ACTOR;
      push(
        {
          id: `audit:${row.id}`,
          time: String(row.created_at || ""),
          action: String(row.action_type || "change"),
          target: String(row.target_table || ""),
          detail: safeDetail(row.after),
          source: "team/settings",
        },
        actor,
      );
    }
  } catch (error) {
    errors.push(`audit_log: ${error instanceof Error ? error.message : "failed"}`);
  }

  try {
    const result = await db
      .from("lead_interactions")
      .select("id, type, channel, direction, agent_source, actor_user_id, metadata, to_email, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(perSource);
    if (result.error) throw new Error(result.error.message);
    for (const row of (result.data || []) as Array<Record<string, unknown>>) {
      const metadata = (
        row.metadata && typeof row.metadata === "object" ? row.metadata : {}
      ) as Record<string, unknown>;
      const requestedBy =
        typeof metadata.requested_by_email === "string" ? metadata.requested_by_email : null;
      const humanActor = human(requestedBy, row.actor_user_id as string);
      // A stale/mis-stamped interaction that explicitly names another
      // workspace's agent is not downgraded to "System" because its target and
      // payload can still expose that workspace's sales activity. Drop it.
      if (!humanActor && sourceNamesDisabledAgent(row.agent_source as string, agentActors)) {
        continue;
      }
      const agentActor =
        !humanActor && row.direction !== "inbound"
          ? resolveActivityAgent(row.agent_source as string, agentActors)
          : null;
      const actor = humanActor || agentActor || SYSTEM_ACTOR;
      push(
        {
          id: `li:${row.id}`,
          time: String(row.created_at || ""),
          action: String(row.type || `${row.channel || "message"} ${row.direction || ""}`).trim(),
          target: row.to_email ? `→ ${row.to_email}` : String(row.channel || ""),
          detail:
            humanActor || agentActor
              ? safeDetail(String(row.agent_source || ""))
              : "Automated or unattributed action",
          source: "comms",
        },
        actor,
      );
    }
  } catch (error) {
    errors.push(`lead_interactions: ${error instanceof Error ? error.message : "failed"}`);
  }

  try {
    const result = await db
      .from("agent_events")
      .select("id, event_type, publisher_agent, payload, created_at, published_at")
      .eq("correlation_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(perSource);
    if (result.error) throw new Error(result.error.message);
    for (const row of (result.data || []) as Array<Record<string, unknown>>) {
      const agent = resolveActivityAgent(row.publisher_agent as string, agentActors);
      if (!agent) continue;
      const payload = (
        row.payload && typeof row.payload === "object" ? row.payload : {}
      ) as Record<string, unknown>;
      if (typeof payload.tenant_id === "string" && payload.tenant_id !== tenantId) continue;
      const target = payload.entity
        ? `${payload.entity}${payload.record_id ? ` ${String(payload.record_id).slice(0, 8)}` : ""}`
        : "";
      push(
        {
          id: `ev:${row.id}`,
          time: String(row.created_at || row.published_at || ""),
          action: String(row.event_type || "event"),
          target,
          detail: safeDetail(payload),
          source: "automation",
        },
        agent,
      );
    }
  } catch (error) {
    errors.push(`agent_events: ${error instanceof Error ? error.message : "failed"}`);
  }

  try {
    const result = await db
      .from("chat_sessions")
      .select("id, agent_key, user_id, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(perSource);
    if (result.error) throw new Error(result.error.message);
    for (const row of (result.data || []) as Array<Record<string, unknown>>) {
      const humanActor = human(null, row.user_id as string);
      const agentActor = resolveActivityAgent(row.agent_key as string, agentActors);
      // A chat with an agent outside this tenant's roster is not this tenant's
      // activity surface, even if a stale row was accidentally stamped here.
      if (!agentActor) continue;
      push(
        {
          id: `chat:${row.id}`,
          time: String(row.created_at || ""),
          action: "chat session",
          target: `with ${agentActor.label}`,
          detail: "",
          source: "chat",
        },
        humanActor || agentActor,
      );
    }
  } catch (error) {
    errors.push(`chat_sessions: ${error instanceof Error ? error.message : "failed"}`);
  }

  try {
    const result = await db
      .from("tenant_cron_jobs")
      .select("id, name, agent_key, schedule, last_run_at, last_run_status, run_count")
      .eq("tenant_id", tenantId)
      .not("last_run_at", "is", null)
      .order("last_run_at", { ascending: false })
      .limit(perSource);
    if (result.error) throw new Error(result.error.message);
    for (const row of (result.data || []) as Array<Record<string, unknown>>) {
      const agent = resolveActivityAgent(row.agent_key as string, agentActors);
      if (!agent) continue;
      push(
        {
          id: `cron:${row.id}`,
          time: String(row.last_run_at || ""),
          action: `ran "${row.name}"`,
          target: String(row.schedule || ""),
          detail: `${row.last_run_status || ""}${row.run_count ? ` · ${row.run_count} runs` : ""}`.trim(),
          source: "automation",
        },
        agent,
      );
    }
  } catch (error) {
    errors.push(`cron_jobs: ${error instanceof Error ? error.message : "failed"}`);
  }

  const actors = dedupeActors([
    ...humanMaps.actors,
    ...agentActors,
    ...(out.some((row) => row.actorKey === SYSTEM_ACTOR.key) ? [SYSTEM_ACTOR] : []),
  ]);
  let rows = out.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  const requestedActor = (opts.actor || "").trim();
  if (requestedActor) {
    const match = actors.find(
      (candidate) =>
        candidate.key === requestedActor ||
        candidate.label.toLowerCase() === requestedActor.toLowerCase(),
    );
    rows = match ? rows.filter((row) => row.actorKey === match.key) : [];
  }
  return { rows: rows.slice(0, limit), actors, errors };
}
