/**
 * components/os/aiteam/roster.ts — who is on this workspace's AI team.
 *
 * Two kinds of teammate:
 *   leads    the agent behind each department channel the viewer can open,
 *            NAMED FOR ITS DEPARTMENTS ("Chief of Staff · Operations"), never
 *            for the agent. Same binding and same gate as the department tabs
 *            (components/os/department/config.ts + gate.ts), so the roster
 *            never lists a department the viewer cannot open, and no
 *            workspace, OASIS's own included, sees a persona's name.
 *   custom   agents this workspace built in the builder (the `agents` table,
 *            tenant-owned rows — what the marketplace calls "private").
 *
 * The custom read is done here rather than through lib/agents/loader's
 * listAgents because listAgents answers [] when the table cannot be read, and
 * an owner told "you have no custom teammates" after a failed read would
 * rebuild ones that exist. Unknown is not zero.
 */

import "server-only";
import { CATEGORY_LABELS, type AgentCategory } from "@/lib/agents/library";
import { getAgentBySlug } from "@/lib/agents/loader";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { getServiceSupabase } from "@/lib/supabase-server";
import { departmentChannelFor, departmentProfile } from "@/components/os/department/config";
import { lastTurnFrom, readWorkspaceTurns, workspaceChatReadiness } from "@/components/os/department/channel";
import { departmentGate } from "@/components/os/department/gate";
import type { Read } from "@/components/os/department/routines";
import type { OsViewer } from "@/components/os/department/viewer";
import type { DepartmentKey } from "@/lib/os/types";
import type { WebState } from "./TeammateRow";

export type TeammateHome = { label: string; href: string };

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
   * and a read that failed is `unknown`, never a green check.
   */
  web: WebState;
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
  /** Whether that chat can answer (a chat slug and an AI provider). Its turns
   *  are recorded per agent, not read here, so it is never `not_working`. */
  web: "ready" | "not_connected" | "unknown";
};

export type AiTeam = {
  leads: LeadTeammate[];
  custom: Read<CustomTeammate[]>;
  /** The builder, for owners/admins of a workspace the builder accepts. */
  builderHref: string | null;
};

async function loadCustom(tenantId: string): Promise<Read<Array<Omit<CustomTeammate, "enabled" | "webHref" | "web">>>> {
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

export async function loadAiTeam(viewer: OsViewer, enabledSlugs: readonly string[]): Promise<AiTeam> {
  const tenantId = viewer.surface.tenantId;
  const open = OS_DEPARTMENTS.filter((d) => departmentGate(d.slug, viewer.navInput) !== null);
  const bindings = open.map((d) => ({ dept: d, binding: departmentChannelFor(d.key, { oasis: viewer.oasis }) }));
  const slugs = [
    ...new Set(bindings.flatMap((b) => (b.binding.kind === "agent" ? [b.binding.agentSlug] : []))),
  ];

  const [readiness, agents, custom, turns] = await Promise.all([
    workspaceChatReadiness(viewer),
    Promise.all(slugs.map((s) => getAgentBySlug(s, tenantId))),
    loadCustom(tenantId),
    readWorkspaceTurns(tenantId),
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
  // A ready lead is only as good as its channels' last turns (the department
  // header's rule, lastTurnFrom): one that failed is Not working, and a record
  // that could not be read is unknown.
  const leadWeb = (keys: readonly DepartmentKey[]): WebState => {
    if (web !== "ready") return web;
    const last = keys.map((k) => lastTurnFrom(turns, k));
    if (last.some((t) => t.kind === "failed")) return "not_working";
    if (last.some((t) => t.kind === "unknown")) return "unknown";
    return "ready";
  };

  const leads: LeadTeammate[] = [];
  for (const [i, slug] of slugs.entries()) {
    const agent = agents[i];
    const led = bindings.filter((b) => b.binding.kind === "agent" && b.binding.agentSlug === slug);
    const departments = led.map((b) => ({ label: b.dept.label, href: b.dept.href }));
    // A department lead is named for its departments, never for the agent
    // behind them: OASIS's leads are house agents with personal names, and
    // clients (and CC, in OASIS's own workspace) address "Sales", not a
    // persona. The summary is the department's own purpose line, written for
    // any business (config.ts PROFILES), not the agent's library blurb.
    leads.push({
      id: slug,
      name: departments.map((d) => d.label).join(" · "),
      summary: led[0] ? departmentProfile(led[0].dept.key).purpose : "",
      departments,
      web: agent ? leadWeb(led.map((b) => b.dept.key)) : "not_connected",
    });
  }
  for (const { dept, binding } of bindings) {
    if (binding.kind !== "unavailable") continue;
    leads.push({
      id: `dept:${dept.key}`,
      name: `${dept.label} lead`,
      summary: binding.reason,
      departments: [{ label: dept.label, href: dept.href }],
      web: "not_set_up",
    });
  }

  const enabled = new Set(enabledSlugs.map((s) => s.toLowerCase()));
  const owner = viewer.surface.persona === "founder";
  return {
    leads,
    custom: custom.ok
      ? {
          ok: true,
          value: custom.value.map((c) => ({
            ...c,
            enabled: enabled.has(c.slug.toLowerCase()),
            webHref: readiness.slug ? `/t/${readiness.slug}/agent/${encodeURIComponent(c.slug)}` : null,
            web,
          })),
        }
      : custom,
    // The builder page itself refuses anyone below owner/admin
    // (app/t/[slug]/marketplace/new), and needs a slug it recognises.
    builderHref: owner && readiness.slug ? `/t/${readiness.slug}/marketplace/new` : null,
  };
}
