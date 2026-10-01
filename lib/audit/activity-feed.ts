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
import { canonicalizeTenantMembers, getTenantMembers, isActiveMember, type MemberRow } from "@/lib/team";
import { getTenantManifestForUser } from "@/lib/manifest/tenant-scope";
import { AGENT_REGISTRY, resolveAgentKey } from "@/lib/agents";
import { resolveEnabledAgentSlugs } from "@/lib/manifest/agent-roster";
import { teammateNameFor } from "@/lib/os/teammate-names";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";

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
  /** The integration or automation that wrote the row (lead_interactions.agent_source); part of the grouping key. */
  sourceKey?: string;
  /** The lead the row is about, when its source records one. Never rendered: `target` carries the name. */
  leadId?: string | null;
  /** On a folded row: how many consecutive identical rows it stands for (always >= 2), and those rows. */
  count?: number;
  items?: ActivityRow[];
};

export type ActivityFeed = {
  rows: ActivityRow[];
  /** Every name a row may carry, deactivated members included: the ?actor= filter resolves against this. */
  actors: ActivityActor[];
  /** Current members, this workspace's enabled agents, and System: the chips and the roster counts. */
  activeActors: ActivityActor[];
  /** Deactivated members with at least one row in the window: the collapsed "Former teammates" group. */
  formerActors: ActivityActor[];
  errors: string[];
};

const SYSTEM_ACTOR: ActivityActor = { key: "system", label: "System", type: "system" };

export function memberActivityLabel(
  member: Pick<MemberRow, "display_name" | "full_name" | "email">,
): string {
  return (member.display_name || member.full_name || member.email || "Team member").trim();
}

/**
 * Build authoritative identity maps from this tenant's actual members.
 * `formerKeys` are the deactivated members' actor keys: they stay in `actors`
 * so their old rows keep their name, and the feed keeps them out of the live
 * roster (chips, counts) with this set.
 */
export function buildHumanActorMaps(
  members: MemberRow[],
): {
  actors: ActivityActor[];
  byEmail: Map<string, ActivityActor>;
  byId: Map<string, ActivityActor>;
  formerKeys: Set<string>;
} {
  const actors: ActivityActor[] = [];
  const byEmail = new Map<string, ActivityActor>();
  const byId = new Map<string, ActivityActor>();
  const formerKeys = new Set<string>();
  for (const member of canonicalizeTenantMembers(members)) {
    const actor: ActivityActor = {
      key: `human:${member.id}`,
      label: memberActivityLabel(member),
      type: "human",
    };
    actors.push(actor);
    if (!isActiveMember(member)) formerKeys.add(actor.key);
    if (member.email) byEmail.set(member.email.trim().toLowerCase(), actor);
    if (member.auth_user_id) byId.set(member.auth_user_id, actor);
  }
  return { actors, byEmail, byId, formerKeys };
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

/** Consecutive rows this close together fold into one line (a bulk claim is one action, not thirty). */
export const GROUP_WINDOW_MS = 2 * 60 * 1000;

function sameGroup(a: ActivityRow, b: ActivityRow): boolean {
  return (
    a.actorKey === b.actorKey &&
    a.action === b.action &&
    (a.sourceKey ?? "") === (b.sourceKey ?? "") &&
    a.source === b.source
  );
}

function withinWindow(head: ActivityRow, row: ActivityRow, windowMs: number): boolean {
  const a = Date.parse(head.time);
  const b = Date.parse(row.time);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= windowMs;
}

/**
 * Fold consecutive rows with the same (actor, action, source) that fall within
 * `windowMs` of the group's newest row into one row carrying `count` and
 * `items`. Rows must already be sorted newest first. A lone row is returned
 * as it was; the folded row is the newest one, so filters and ids still hold.
 */
export function groupActivityRows(rows: ActivityRow[], windowMs = GROUP_WINDOW_MS): ActivityRow[] {
  const out: ActivityRow[] = [];
  let group: ActivityRow[] = [];
  const flush = () => {
    if (group.length === 1) out.push(group[0]);
    else if (group.length > 1) out.push({ ...group[0], count: group.length, items: group });
    group = [];
  };
  for (const row of rows) {
    const head = group[0];
    if (head && sameGroup(head, row) && withinWindow(head, row, windowMs)) {
      group.push(row);
      continue;
    }
    flush();
    group = [row];
  }
  flush();
  return out;
}

/**
 * What the feed calls an agent: the department or job it has in THIS kind of
 * workspace (lib/os/teammate-names), never the persona slug behind it. A slug
 * that file does not know is one the workspace built itself, so it keeps the
 * name its owner gave it.
 */
export function activityAgentLabel(
  slug: string,
  binding: { display_name?: string | null; slug?: string } | undefined,
  oasis: boolean,
): string {
  return teammateNameFor(slug, { oasis })?.name || binding?.display_name || binding?.slug || slug;
}

async function loadTenantAgents(tenantId: string, oasis?: boolean): Promise<ActivityActor[]> {
  const manifest = await getTenantManifestForUser(tenantId).catch(() => null);
  const bindings = manifest?.agents || [];
  const enabledSlugs = resolveEnabledAgentSlugs({
    manifestAgents: manifest ? bindings : null,
  });
  const scope = oasis ?? isOasisSurfaceTenant(manifest?.tenant_slug);
  return enabledSlugs.map((slug) => {
    const binding = bindings.find(
      (agent) => resolveAgentKey(agent.slug.toLowerCase()) === slug,
    );
    return {
      key: `agent:${slug}`,
      label: activityAgentLabel(slug, binding, scope),
      type: "agent" as const,
    };
  });
}

/** The lead's name as the pipeline shows it (lib/web-leads/data.ts), or null. */
function leadNameFrom(data: unknown): string | null {
  let record: Record<string, unknown> | null = null;
  if (typeof data === "string") {
    try {
      record = JSON.parse(data) as Record<string, unknown>;
    } catch {
      record = null;
    }
  } else if (data && typeof data === "object") {
    record = data as Record<string, unknown>;
  }
  if (!record) return null;
  for (const key of ["business_name", "name", "company"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
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
  /**
   * `sales_team` is the manager-safe feed: human sales actions only. The
   * caller must provide the allowed actor ids; internal audits, agents, chats,
   * crons and unattributed/system activity are never queried in this mode.
   */
  scope?: "workspace" | "sales_team";
  salesActorUserIds?: string[];
  /**
   * Whether this is OASIS's own workspace, which decides what the agents are
   * called (lib/os/teammate-names). Omitted: read off the manifest.
   */
  oasis?: boolean;
  /**
   * Fold consecutive identical rows (groupActivityRows) into one row carrying
   * `count` and `items`. Only a caller that renders the count may ask for it:
   * a panel that prints `actor · action` alone would show a 30-lead bulk claim
   * as one lead and lose the other 29. Off by default; `limit` then counts rows,
   * with it on, folded rows.
   */
  group?: boolean;
  /** Test/consumer injection: production callers omit these. */
  db?: ReturnType<typeof getServiceSupabase>;
  members?: MemberRow[];
  agents?: ActivityActor[];
};

/** Aggregate the activity feed. Every source is independently tenant-scoped. */
export async function getActivityFeed(
  tenantId: string,
  opts: ActivityFeedOptions = {},
): Promise<ActivityFeed> {
  const limit = opts.limit ?? 200;
  // Manager mode has one permitted source, so fetch the full advertised limit.
  // Workspace mode merges several sources and keeps the smaller per-source cap.
  const perSource = opts.scope === "sales_team" ? limit : 150;
  const db = opts.db ?? getServiceSupabase();
  const errors: string[] = [];
  const salesTeamScope = opts.scope === "sales_team";
  const allowedSalesIds = new Set(
    (opts.salesActorUserIds || []).map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
  let loadedMembers = opts.members;
  if (!loadedMembers) {
    try {
      // Past actions by a deactivated teammate still need their name.
      loadedMembers = await getTenantMembers(tenantId, { includeInactive: true });
    } catch (error) {
      console.error("[activity-feed.members]", { tenantId, error });
      return {
        rows: [],
        actors: [],
        activeActors: [],
        formerActors: [],
        errors: [`team_members: ${error instanceof Error ? error.message : "failed"}`],
      };
    }
  }
  const members = salesTeamScope
    ? loadedMembers.filter(
        (member) =>
          Boolean(member.auth_user_id) &&
          allowedSalesIds.has(String(member.auth_user_id).trim().toLowerCase()),
      )
    : loadedMembers;
  const humanMaps = buildHumanActorMaps(members);
  const requestedActor = (opts.actor || "").trim();
  const requestedSalesActor =
    salesTeamScope && requestedActor
      ? humanMaps.actors.find(
          (candidate) =>
            candidate.key === requestedActor ||
            candidate.label.toLowerCase() === requestedActor.toLowerCase(),
        ) || null
      : null;
  const requestedSalesUserId = requestedSalesActor
    ? [...humanMaps.byId.entries()].find(([, actor]) => actor.key === requestedSalesActor.key)?.[0] || null
    : null;
  const agentActors = salesTeamScope
    ? []
    : dedupeActors(opts.agents ?? (await loadTenantAgents(tenantId, opts.oasis)));
  const human = (email?: string | null, userId?: string | null): ActivityActor | null =>
    (userId && humanMaps.byId.get(userId)) ||
    (email && humanMaps.byEmail.get(email.trim().toLowerCase())) ||
    null;
  const out: ActivityRow[] = [];
  const currentHumans = humanMaps.actors.filter((actor) => !humanMaps.formerKeys.has(actor.key));
  const emptyFeed = (): ActivityFeed => ({
    rows: [],
    actors: humanMaps.actors,
    activeActors: currentHumans,
    formerActors: [],
    errors: [],
  });

  // Empty IN clauses are not portable across the Supabase/Turso adapters. More
  // importantly, an empty manager roster must never fall through to a tenant-
  // wide query. Return the honest empty feed before touching an activity table.
  if (salesTeamScope && allowedSalesIds.size === 0) {
    return emptyFeed();
  }
  if (salesTeamScope && requestedActor && !requestedSalesUserId) {
    return emptyFeed();
  }

  const push = (row: Omit<ActivityRow, "actorKey" | "actor" | "actorType">, actor: ActivityActor) => {
    out.push({
      ...row,
      actorKey: actor.key,
      actor: actor.label,
      actorType: actor.type,
    });
  };

  if (!salesTeamScope) try {
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
    let query = db
      .from("lead_interactions")
      .select(
        "id, type, channel, direction, agent_source, actor_user_id, metadata, to_email, subject, content, lead_id, created_at",
      )
      .eq("tenant_id", tenantId);
    if (salesTeamScope) {
      // Query-level actor scope is the security boundary. Metadata attribution
      // is intentionally not enough for a manager because it is free-form.
      query = requestedSalesUserId
        ? query.eq("actor_user_id", requestedSalesUserId)
        : query.in("actor_user_id", [...allowedSalesIds]);
    }
    const result = await query
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
      // The writer's own words, not its identifier: a claim stores
      // "Lead claimed" / "Lead claimed and moved prospect pool -> assigned.",
      // which beats printing "web_leads_claim". An internal note's body is
      // the note; for a message to a lead only the subject line is shown.
      const subject = typeof row.subject === "string" ? row.subject.trim() : "";
      const content = typeof row.content === "string" ? row.content.trim() : "";
      const note = row.direction === "internal" ? content || subject : subject;
      const leadId = typeof row.lead_id === "string" && row.lead_id ? row.lead_id : null;
      push(
        {
          id: `li:${row.id}`,
          time: String(row.created_at || ""),
          action: String(row.type || `${row.channel || "message"} ${row.direction || ""}`).trim(),
          target: row.to_email ? `→ ${row.to_email}` : String(row.channel || ""),
          detail:
            humanActor || agentActor
              ? safeDetail(note || String(row.agent_source || ""))
              : "Automated or unattributed action",
          source: "comms",
          sourceKey: String(row.agent_source || ""),
          leadId,
        },
        actor,
      );
    }
  } catch (error) {
    errors.push(`lead_interactions: ${error instanceof Error ? error.message : "failed"}`);
  }

  // Name the lead a row is about: one tenant-scoped read for the window's lead
  // ids, never one per row, and only when a row names a lead at all (the
  // manager feed queries nothing else when its rows carry none). A failed read
  // leaves the row's channel as its target and is reported, so no row prints
  // a bare id.
  const leadIds = [...new Set(out.flatMap((row) => (row.leadId ? [row.leadId] : [])))];
  if (leadIds.length > 0) try {
    const result = await db
      .from("tenant_records")
      .select("id, data")
      .eq("tenant_id", tenantId)
      .in("id", leadIds);
    if (result.error) throw new Error(result.error.message);
    const names = new Map<string, string>();
    for (const row of (result.data || []) as Array<Record<string, unknown>>) {
      const name = leadNameFrom(row.data);
      if (name) names.set(String(row.id), name);
    }
    for (const row of out) {
      const name = row.leadId ? names.get(row.leadId) : undefined;
      if (name) row.target = scrubValue(name).slice(0, 80);
    }
  } catch (error) {
    errors.push(`lead_names: ${error instanceof Error ? error.message : "failed"}`);
  }

  if (!salesTeamScope) try {
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

  if (!salesTeamScope) try {
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

  if (!salesTeamScope) try {
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

  const systemActors = out.some((row) => row.actorKey === SYSTEM_ACTOR.key) ? [SYSTEM_ACTOR] : [];
  // Every name the rows may carry, for attribution and for the ?actor= filter.
  const actors = dedupeActors([...humanMaps.actors, ...agentActors, ...systemActors]);
  // The live roster: current members only. A deactivated member is "former"
  // when they still have a row in the window, and absent otherwise; either way
  // they are never a current chip or counted as a team member (S1-C1).
  const rowActorKeys = new Set(out.map((row) => row.actorKey));
  const activeActors = dedupeActors([...currentHumans, ...agentActors, ...systemActors]);
  const formerActors = humanMaps.actors.filter(
    (actor) => humanMaps.formerKeys.has(actor.key) && rowActorKeys.has(actor.key),
  );
  let rows = out.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  if (requestedActor) {
    const match = actors.find(
      (candidate) =>
        candidate.key === requestedActor ||
        candidate.label.toLowerCase() === requestedActor.toLowerCase(),
    );
    rows = match ? rows.filter((row) => row.actorKey === match.key) : [];
  }
  return {
    rows: (opts.group ? groupActivityRows(rows) : rows).slice(0, limit),
    actors,
    activeActors,
    formerActors,
    errors,
  };
}
