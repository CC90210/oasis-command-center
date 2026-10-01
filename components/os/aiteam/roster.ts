/**
 * components/os/aiteam/roster.ts — who is on this workspace's AI team.
 *
 * ONE ROSTER (W4a, 2026-10-01). The workspace's manifest says who is on the
 * team (lib/os/teammates.ts workspaceTeammates), and both pages that list the
 * team load it here: the AI Team page (loadAiTeam) and Settings > AI brain's
 * Workspace agents card (loadWorkspaceRoster). They used to read two unrelated
 * sources and list different teammates (audit S2-01, S5-F04).
 *
 * Two kinds of teammate:
 *   leads    the binding that leads each department, named by its binding
 *            (OASIS's leads are named for their departments, "Chief of Staff ·
 *            Operations"; never for the persona behind them). The AI Team lists
 *            a lead only for departments the viewer can open (the same gate as
 *            the department tabs, components/os/department/gate.ts).
 *   custom   agents this workspace built in the builder: its custom bindings,
 *            plus any tenant-owned `agents` row the manifest does not bind yet
 *            (built before a new teammate was bound on creation), shown Off
 *            with an On control that adds the binding.
 *
 * The custom read is done here rather than through lib/agents/loader's
 * listAgents because listAgents answers [] when the table cannot be read, and
 * an owner told "you have no custom teammates" after a failed read would
 * rebuild ones that exist. Unknown is not zero.
 */

import "server-only";
import { CATEGORY_LABELS, type AgentCategory } from "@/lib/agents/library";
import { getAgentBySlug } from "@/lib/agents/loader";
import { isHouseAgentSlug } from "@/lib/agents";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import type { DepartmentKey } from "@/lib/os/types";
import { workspaceTeammates, type WorkspaceTeammate } from "@/lib/os/teammates";
import { getServiceSupabase } from "@/lib/supabase-server";
import { departmentChannelFor, departmentProfile, type DepartmentScope } from "@/components/os/department/config";
import { lastTurnOn, readWorkspaceTurns, workspaceChatReadiness } from "@/components/os/department/channel";
import { departmentGate } from "@/components/os/department/gate";
import type { Read } from "@/components/os/department/routines";
import type { OsViewer } from "@/components/os/department/viewer";
import { agentChannelKey, departmentChannelKey, failureCopy } from "@/lib/os/channel/outcome";
import type { WebState } from "./TeammateRow";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { loadSlackPresence, slackHomeFor, type SlackHome } from "@/lib/slack/status";

export type TeammateHome = { label: string; href: string };

/**
 * The On/Off switch an owner or admin gets on a teammate's row. `bound: false`
 * is an agent the workspace built that its manifest does not bind yet: turning
 * it on adds the binding (POST /api/tenant/agents/toggle, action "add").
 */
export type TeammateSwitch = { slug: string; enabled: boolean; bound: boolean };

export type LeadTeammate = {
  /** Agent slug, or `dept:<key>` for a department with no teammate yet. */
  id: string;
  name: string;
  summary: string;
  /** The departments this teammate leads, each a Web home. */
  departments: TeammateHome[];
  /**
   * Web channel state, by the department header's own rules: a key on file
   * whose last turn failed is `not_working` (the header says "Not working"),
   * a read that failed is `unknown`, never a green check, and a lead switched
   * off is `off` (its departments' channels say so too).
   */
  web: WebState;
  /** Why it is `not_working`, in the department header's own short words; null otherwise. */
  webReason: string | null;
  /**
   * Where it lives in Slack: its mapped channels, or why it does not
   * (lib/slack/status.ts). Absent for a department with no teammate, or a lead
   * switched off: nothing answers there in Slack either.
   */
  slack?: SlackHome;
  /** On/Off, for an owner or admin, on a lead that has a switch (not core); null otherwise. */
  toggle: TeammateSwitch | null;
};

export type CustomTeammate = {
  slug: string;
  name: string;
  category: string;
  summary: string;
  /** Turned on in this workspace's manifest. */
  enabled: boolean;
  /** Its chat, when the workspace has a chat slug. */
  webHref: string | null;
  /**
   * Whether that chat can answer, by the leads' own rule: a chat slug and an
   * AI provider, and then its last turn (recorded under agentChannelKey). A
   * refusal of the workspace key anywhere, or of this chat's own turn, is
   * `not_working`; a read that failed is `unknown`. Never a green check over a
   * key the provider is refusing.
   */
  web: Exclude<WebState, "not_set_up" | "off">;
  /** Why it is `not_working`, in the department header's own short words; null otherwise. */
  webReason: string | null;
  /** On/Off, for an owner or admin; null otherwise. */
  toggle: TeammateSwitch | null;
};

export type AiTeam = {
  leads: LeadTeammate[];
  custom: Read<CustomTeammate[]>;
  /** The builder, for owners/admins of a workspace the builder accepts. */
  builderHref: string | null;
};

/** A department lead on the workspace roster (Settings and the AI Team list the same ones). */
export type RosterLead = {
  slug: string;
  name: string;
  summary: string;
  departments: DepartmentKey[];
  enabled: boolean;
  core: boolean;
  bound: boolean;
};

/** A teammate the workspace built, bound in its manifest or not yet. */
export type RosterCustom = {
  slug: string;
  name: string;
  category: string;
  summary: string;
  enabled: boolean;
  core: boolean;
  bound: boolean;
};

export type WorkspaceRoster = { leads: RosterLead[]; custom: Read<RosterCustom[]> };

function rosterLead(t: WorkspaceTeammate): RosterLead {
  return {
    slug: t.slug,
    name: t.name,
    summary: t.summary,
    departments: [...t.departments],
    enabled: t.enabled,
    core: t.core,
    bound: t.bound,
  };
}

/**
 * The custom teammates: the manifest's custom bindings (named by their
 * binding, described by their `agents` row), then the workspace's own agents
 * rows its manifest does not bind yet (Off, with an On that binds them). A
 * failed agents read is unknown for the whole list, never "none".
 */
async function loadCustomTeammates(tenantId: string, teammates: readonly WorkspaceTeammate[]): Promise<Read<RosterCustom[]>> {
  const rows = await loadCustom(tenantId);
  if (!rows.ok) return rows;
  const rowBySlug = new Map(rows.value.map((r) => [r.slug.toLowerCase(), r] as const));
  const custom: RosterCustom[] = teammates
    .filter((t) => t.kind === "custom")
    .map((t) => {
      const row = rowBySlug.get(t.slug.toLowerCase());
      return {
        slug: t.slug,
        name: t.name,
        category: row?.category ?? "Custom",
        summary: row?.summary ?? "",
        enabled: t.enabled,
        core: t.core,
        bound: true,
      };
    });
  const onRoster = new Set(teammates.map((t) => t.slug.toLowerCase()));
  for (const r of rows.value) {
    if (onRoster.has(r.slug.toLowerCase()) || isHouseAgentSlug(r.slug)) continue;
    custom.push({ slug: r.slug, name: r.name, category: r.category, summary: r.summary, enabled: false, core: false, bound: false });
  }
  return { ok: true, value: custom };
}

/**
 * The workspace's AI team, as Settings > AI brain lists it: every lead and
 * every custom teammate, with no channel status. The AI Team page builds its
 * rows from the same two reads (loadAiTeam).
 */
export async function loadWorkspaceRoster(input: { tenantId: string; scope: DepartmentScope }): Promise<WorkspaceRoster> {
  const teammates = workspaceTeammates(input.scope);
  return {
    leads: teammates.filter((t) => t.kind === "lead").map(rosterLead),
    custom: await loadCustomTeammates(input.tenantId, teammates),
  };
}

async function loadCustom(tenantId: string): Promise<Read<Array<{ slug: string; name: string; category: string; summary: string }>>> {
  try {
    const res = await getServiceSupabase()
      .from("agents")
      .select("slug, name, category, short_description, is_oasis_managed, tenant_id, updated_at")
      .eq("tenant_id", tenantId)
      .order("updated_at", { ascending: false });
    if (res.error) throw new Error(res.error.message);
    const rows = (res.data || []) as Array<{
      slug: string;
      name: string;
      category: string;
      short_description: string | null;
      is_oasis_managed: unknown;
      tenant_id: string | null;
    }>;
    return {
      ok: true,
      value: rows
        // The query already pins the tenant; this keeps a platform row that
        // was ever stamped with a tenant id from posing as the client's own.
        .filter((r) => r.tenant_id === tenantId && !(r.is_oasis_managed === true || r.is_oasis_managed === 1))
        .map((r) => ({
          slug: r.slug,
          name: r.name,
          category: CATEGORY_LABELS[r.category as AgentCategory] ?? "Custom",
          summary: (r.short_description || "").trim(),
        })),
    };
  } catch (err) {
    console.error("[os.aiteam.custom]", err);
    return { ok: false };
  }
}

export async function loadAiTeam(viewer: OsViewer): Promise<AiTeam> {
  const tenantId = viewer.surface.tenantId;
  const scope: DepartmentScope = { oasis: viewer.oasis, manifest: viewer.manifest };
  const open = OS_DEPARTMENTS.filter((d) => departmentGate(d.slug, viewer.navInput) !== null);
  const teammates = workspaceTeammates(scope);
  // The leads of the departments this viewer can open, each with only those homes.
  const shown = teammates
    .filter((t) => t.kind === "lead")
    .map((t) => ({ teammate: t, depts: open.filter((d) => t.departments.includes(d.key)) }))
    .filter((l) => l.depts.length > 0);

  const [readiness, agents, custom, turns, slackPresence] = await Promise.all([
    workspaceChatReadiness(viewer),
    Promise.all(shown.map((l) => getAgentBySlug(l.teammate.slug, tenantId))),
    loadCustomTeammates(tenantId, teammates),
    readWorkspaceTurns(tenantId),
    loadSlackPresence(tursoConfigured() ? getTursoClient() : null, tenantId),
  ]);
  // Key readiness, the same answer the channel gets: no slug or no key is Not
  // connected; an AI settings read that failed is unknown, not "not connected".
  const web: "ready" | "not_connected" | "unknown" = !readiness.slug
    ? "not_connected"
    : readiness.provider === "ready"
      ? "ready"
      : readiness.provider === "unknown"
        ? "unknown"
        : "not_connected";
  // A ready teammate is only as good as its channels' last turns (the
  // department header's rule, lastTurnOn): one that failed is Not working, and
  // a record that could not be read is unknown. Leads and custom teammates are
  // judged the same way, each on the channel keys the route records them under.
  // The reason travels with the state: the roster chip says why, in the same
  // short words the header uses (StatusPill withLastTurn), so "not working"
  // is never read as a missing web capability (S4-01).
  type WebOn = { web: Exclude<WebState, "not_set_up" | "off">; webReason: string | null };
  const webOn = (channelKeys: readonly string[]): WebOn => {
    if (web !== "ready") return { web, webReason: null };
    const last = channelKeys.map((k) => lastTurnOn(turns, k));
    const failed = last.find((t): t is Extract<typeof t, { kind: "failed" }> => t.kind === "failed");
    if (failed) return { web: "not_working", webReason: failureCopy(failed.code, { canManageAi: false }).short };
    if (last.some((t) => t.kind === "unknown")) return { web: "unknown", webReason: null };
    return { web: "ready", webReason: null };
  };

  // Owners and admins switch teammates on and off (the toggle API's own rule);
  // a core teammate, or a lead with no binding of its own, has no switch.
  const owner = viewer.surface.persona === "founder";
  const switchFor = (t: { slug: string; enabled: boolean; core: boolean; bound: boolean }): TeammateSwitch | null =>
    owner && !t.core ? { slug: t.slug, enabled: t.enabled, bound: t.bound } : null;

  const leads: LeadTeammate[] = [];
  for (const [i, { teammate, depts }] of shown.entries()) {
    const agent = agents[i];
    const departments = depts.map((d) => ({ label: d.label, href: d.href }));
    // A lead is named by its binding (OASIS's are named for their departments),
    // never for the persona behind it. The summary is its first department's
    // own purpose line, written for any business (config.ts PROFILES), not the
    // agent's library blurb.
    leads.push({
      id: teammate.slug,
      name: teammate.name,
      summary: departmentProfile(depts[0].key).purpose,
      departments,
      ...(!teammate.enabled
        ? { web: "off" as const, webReason: null }
        : agent
          ? webOn(depts.map((d) => departmentChannelKey(d.key)))
          : { web: "not_connected" as const, webReason: null }),
      ...(teammate.enabled ? { slack: slackHomeFor(slackPresence, depts.map((d) => d.key)) } : {}),
      toggle: switchFor(teammate),
    });
  }
  for (const dept of open) {
    if (shown.some((l) => l.depts.includes(dept))) continue;
    const binding = departmentChannelFor(dept.key, scope);
    leads.push({
      id: `dept:${dept.key}`,
      name: `${dept.label} lead`,
      summary: binding.kind === "unavailable" ? binding.reason : "",
      departments: [{ label: dept.label, href: dept.href }],
      web: "not_set_up",
      webReason: null,
      toggle: null,
    });
  }

  return {
    leads,
    custom: custom.ok
      ? {
          ok: true,
          value: custom.value.map((c) => ({
            slug: c.slug,
            name: c.name,
            category: c.category,
            summary: c.summary,
            enabled: c.enabled,
            webHref: readiness.slug ? `/t/${readiness.slug}/agent/${encodeURIComponent(c.slug)}` : null,
            ...webOn([agentChannelKey(c.slug)]),
            toggle: switchFor(c),
          })),
        }
      : custom,
    // The builder page itself refuses anyone below owner/admin
    // (app/t/[slug]/marketplace/new), and needs a slug it recognises.
    builderHref: owner && readiness.slug ? `/t/${readiness.slug}/marketplace/new` : null,
  };
}
