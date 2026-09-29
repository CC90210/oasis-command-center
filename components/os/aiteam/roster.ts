/**
 * components/os/aiteam/roster.ts — who is on this workspace's AI team.
 *
 * Two kinds of teammate:
 *   leads    the agent behind each department channel the viewer can open.
 *            Same binding and same gate as the department tabs
 *            (components/os/department/config.ts + gate.ts), so the roster
 *            never lists a department the viewer cannot open, and a client
 *            workspace never lists an OASIS persona.
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
import { departmentChannelFor } from "@/components/os/department/config";
import { workspaceChatReadiness } from "@/components/os/department/channel";
import { departmentGate } from "@/components/os/department/gate";
import type { Read } from "@/components/os/department/routines";
import type { OsViewer } from "@/components/os/department/viewer";

export type TeammateHome = { label: string; href: string };

export type LeadTeammate = {
  /** Agent slug, or `dept:<key>` for a department with no teammate yet. */
  id: string;
  name: string;
  summary: string;
  /** The departments this teammate leads, each a Web home. */
  departments: TeammateHome[];
  /** Web channel state: answering, or why not. */
  web: "ready" | "not_connected" | "not_set_up";
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
  /** Whether that chat can answer (a chat slug and an AI provider). */
  web: "ready" | "not_connected";
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

  const [readiness, agents, custom] = await Promise.all([
    workspaceChatReadiness(viewer),
    Promise.all(slugs.map((s) => getAgentBySlug(s, tenantId))),
    loadCustom(tenantId),
  ]);
  const web: "ready" | "not_connected" = readiness.slug && readiness.provider ? "ready" : "not_connected";

  const leads: LeadTeammate[] = [];
  for (const [i, slug] of slugs.entries()) {
    const agent = agents[i];
    const departments = bindings
      .filter((b) => b.binding.kind === "agent" && b.binding.agentSlug === slug)
      .map((b) => ({ label: b.dept.label, href: b.dept.href }));
    leads.push({
      id: slug,
      name: agent?.name ?? departments.map((d) => d.label).join(" · "),
      summary: agent?.short_description ?? "",
      departments,
      web: agent ? web : "not_connected",
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
