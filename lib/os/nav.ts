/**
 * lib/os/nav.ts — the OASIS OS rail, computed rather than stored.
 *
 * WHY COMPUTED. The old shell had three nav sources (nav-config arrays via
 * seeds, inline manifest navs, founders rows injected in the layout) plus a
 * persona allowlist on top, and an unknown slug fell back to CC's own nav. Here
 * there is one catalog and one pure function:
 *
 *   OS_NAV_CATALOG
 *     → drop rows whose module the workspace does not have
 *     → drop OASIS-only rows outside an OASIS workspace
 *     → drop rows whose audience this viewer is not in
 *     → filterNavForPersona  (LAST — defence in depth, the existing allowlists)
 *     → group into sections; a section with no rows is not rendered
 *
 * PURE. No session, no database, no next/* — tests/os-nav.test.ts runs the
 * whole matrix in bare node. app/layout.tsx gathers the inputs and calls it once
 * per render; the result is plain data handed to the client rail.
 *
 * HIDING IS NOT ENFORCING (lib/role-surfaces.ts). Every route below still
 * carries its own server gate. This decides which doors are drawn, and it draws
 * none it cannot show is open: each row's `audience` names the same flag its
 * page gate reads.
 */

import type { NavIconKey } from "@/lib/nav-config";
import {
  capabilitiesFor,
  filterNavForPersona,
  isOasisSurfaceTenant,
  maySeeCommissionSurface,
  type Persona,
  type SurfaceCapabilities,
} from "@/lib/role-surfaces";
import { OS_DEPARTMENTS, type OsDepartment } from "@/lib/os/departments";
import type {
  ModuleKey,
  OsAudience,
  OsNavEntry,
  OsNavGroup,
  OsNavRow,
  OsNavSection,
  OsSectionKey,
} from "@/lib/os/types";

/** Mode order and labels. Team is the landing mode. */
export const OS_SECTIONS: ReadonlyArray<{ key: OsSectionKey; label: string; icon: NavIconKey }> = [
  { key: "team", label: "Team", icon: "UsersRound" },
  { key: "growth", label: "Growth", icon: "TrendingUp" },
  { key: "clients", label: "Clients", icon: "Handshake" },
  { key: "money", label: "Money", icon: "Wallet" },
  { key: "admin", label: "Admin", icon: "Shield" },
];

const departmentRow = (d: OsDepartment): OsNavEntry => ({
  id: `dept-${d.slug}`,
  href: d.href,
  label: d.label,
  icon: "Hash",
  section: "team",
  group: "Departments",
  department: d.key,
  ...(d.module ? { module: d.module } : {}),
  audience: d.audience,
  badgeKey: `dept:${d.key}`,
});

/**
 * Every row the OS can draw. Order here is order on screen.
 *
 * Projects has ONE home: Team (design doc §(a), the TEAM table). Clients links
 * a client's projects from the client record once /clients ships, rather than
 * listing the same route twice — two rows for one route both light up as
 * "active", which is the double-highlight longest-prefix exists to prevent.
 */
export const OS_NAV_CATALOG: readonly OsNavEntry[] = [
  // ── TEAM ────────────────────────────────────────────────────────────────
  { id: "today", href: "/", label: "Today", icon: "Home", section: "team", audience: "everyone", unprovisioned: true },
  { id: "feed", href: "/feed", label: "Feed", icon: "Rss", section: "team", audience: "everyone", badgeKey: "approvals" },
  { id: "schedule", href: "/schedule", label: "Schedule", icon: "CalendarDays", section: "team", audience: "everyone" },
  { id: "projects", href: "/projects", label: "Projects", icon: "FolderKanban", section: "team", audience: "delivery" },
  // OASIS-only until playbooks are stored per tenant (W10, `playbook_docs`):
  // /playbook reads OASIS's own SOPs from content/playbooks, and those are not
  // another workspace's to browse.
  { id: "playbook", href: "/playbook", label: "Playbook", icon: "Library", section: "team", audience: "everyone", oasisOnly: true },
  // The AI Team (the workspace's manifest roster, app/agents/page.tsx), for
  // owners and admins of ANY workspace (decision 22, 2026-10-01). It was
  // OASIS-only while /agents was the operator fleet, which now lives at
  // Admin > Fleet; a client owner's only agent surface was a Settings card.
  { id: "ai-team", href: "/agents", label: "AI Team", icon: "Bot", section: "team", audience: "manage" },
  ...OS_DEPARTMENTS.map(departmentRow),

  // ── GROWTH › Sales ──────────────────────────────────────────────────────
  { id: "pipeline", href: "/pipeline", label: "Pipeline", icon: "GitBranch", section: "growth", group: "Sales", audience: "everyone" },
  { id: "prospects", href: "/web-leads", label: "Prospects", icon: "Users", section: "growth", group: "Sales", module: "prospects", oasisOnly: true, audience: "everyone" },
  { id: "enablement", href: "/training", label: "Enablement", icon: "GraduationCap", section: "growth", group: "Sales", module: "enablement", oasisOnly: true, audience: "everyone" },
  // Its own row until Enablement grows Training · Objections tabs. Reps open
  // the objection library daily; it shipped once with no nav row and nobody
  // could find it (lib/role-surfaces.ts, SALES_NAV_ALLOWLIST).
  { id: "objections", href: "/objections", label: "Objections", icon: "MessageSquare", section: "growth", group: "Sales", module: "enablement", oasisOnly: true, audience: "everyone" },
  { id: "commissions", href: "/commissions", label: "Commissions", icon: "DollarSign", section: "growth", group: "Sales", module: "commissions", audience: "commissions" },

  // ── GROWTH › Marketing ──────────────────────────────────────────────────
  { id: "forms", href: "/forms", label: "Forms", icon: "FileCode2", section: "growth", group: "Marketing", audience: "everyone" },
  { id: "ads", href: "/growth/ads", label: "Ads", icon: "Megaphone", section: "growth", group: "Marketing", module: "ads", audience: "everyone" },
  { id: "content", href: "/founders/marketing", label: "Content", icon: "FileText", section: "growth", group: "Marketing", module: "content", oasisOnly: true, audience: "founders_content" },

  // ── CLIENTS ─────────────────────────────────────────────────────────────
  { id: "clients", href: "/clients", label: "All clients", icon: "Building2", section: "clients", audience: "client_identities" },
  { id: "support", href: "/tickets", label: "Support desk", icon: "LifeBuoy", section: "clients", audience: "delivery", badgeKey: "sla_breaches" },

  // ── MONEY (owners; OASIS until fin_* carries tenant_id) ─────────────────
  { id: "money", href: "/money", label: "Overview", icon: "Wallet", section: "money", module: "finance", oasisOnly: true, audience: "finance_owner" },
  { id: "analytics", href: "/analytics", label: "Analytics", icon: "BarChart3", section: "money", module: "finance", oasisOnly: true, audience: "company_financials" },

  // ── ADMIN (platform operators, from the shield) ─────────────────────────
  { id: "admin-operations", href: "/operations", label: "Operations", icon: "Activity", section: "admin", audience: "operator", oasisOnly: true },
  { id: "admin-automations", href: "/automations", label: "Automations", icon: "RefreshCcw", section: "admin", audience: "operator", oasisOnly: true },
  // One System health (2026-09-30): /system-health folded into /health and
  // redirects there, so it has no row of its own.
  { id: "admin-health", href: "/health", label: "System health", icon: "ShieldCheck", section: "admin", audience: "operator", oasisOnly: true },
  // The operator's workbench: Claude Code / Codex in a department's repo on
  // the operator's computer. Everyday questions go to Chief of Staff.
  { id: "admin-agent", href: "/agent", label: "Coding harness", icon: "SquareTerminal", section: "admin", audience: "operator", oasisOnly: true },
  { id: "admin-fleet", href: "/admin/agents", label: "Fleet", icon: "Cpu", section: "admin", audience: "operator", oasisOnly: true },
  { id: "admin-runs", href: "/runs", label: "Runs", icon: "History", section: "admin", audience: "operator", oasisOnly: true },
  { id: "admin-inbox", href: "/inbox", label: "Inbox", icon: "Inbox", section: "admin", audience: "operator", oasisOnly: true },
];

export type BuildOsNavInput = {
  /**
   * Null when the viewer's persona could not be resolved (no profile, no
   * tenant, a failed read). The rail then shows Today only: an unknown viewer
   * is not handed a guess at what they may open.
   */
  persona: Persona | null;
  /** From resolveViewerSurface. Derived from persona + tenantSlug when absent. */
  capabilities?: SurfaceCapabilities | null;
  /** resolvePlatformOperator(): auth-user-verified, never an email string. */
  isOperator: boolean;
  /** The viewer's workspace slug (raw tenants.slug). */
  tenantSlug: string | null;
  /**
   * Caller's OASIS verdict. OASIS-only rows need BOTH this and the slug to say
   * OASIS, so a caller that computed it from a different tenant than the slug
   * it passed fails closed instead of showing OASIS rows.
   */
  isOasisTenant: boolean;
  /** resolveOsModules() — what the workspace has. */
  modules: readonly ModuleKey[];
  /** False for UNPROVISIONED_SEED: Today only. Defaults to true. */
  provisioned?: boolean;
  /**
   * The founders-portal gates app/layout.tsx already computes:
   * content  = shouldShowFoundersNav(...) (FOUNDERS_TENANT_IDS + canSeeMarketing + own shell)
   * finances = content && isFinanceOwnerEmail(profile.email)
   * Absent → both closed.
   */
  founders?: { content: boolean; finances: boolean } | null;
};

type VisibilityContext = {
  persona: Persona;
  capabilities: SurfaceCapabilities;
  isOperator: boolean;
  oasis: boolean;
  modules: ReadonlySet<ModuleKey>;
  founders: { content: boolean; finances: boolean };
};

function audienceAllows(audience: OsAudience, ctx: VisibilityContext): boolean {
  switch (audience) {
    case "everyone":
      return true;
    case "manage":
      return ctx.persona === "founder";
    case "system":
      return ctx.capabilities.canSeeSystemSurfaces;
    case "delivery":
      // lib/delivery/access.ts: a non-founder inside OASIS is denied; anyone
      // in another workspace reads it as that workspace's own view.
      return !ctx.oasis || ctx.persona === "founder";
    case "client_identities":
      return ctx.capabilities.canSeeClientIdentities;
    case "commissions":
      return maySeeCommissionSurface(ctx.capabilities);
    case "company_financials":
      // capabilitiesFor already ANDs this with an OASIS slug; ANDed again so a
      // caller passing unadjusted capabilities still cannot light Money. And
      // owners only: the grandfathered SunBiz `legacy` persona inherits the
      // founder money flag, but Money is an owner's mode, not a loan officer's.
      return ctx.capabilities.canSeeCompanyFinancials && ctx.oasis && ctx.persona === "founder";
    case "founders_content":
      return ctx.founders.content && ctx.oasis;
    case "finance_owner":
      // Money is for owners. The layout only sets `finances` for CC or Adon,
      // who are founders; requiring the persona too means a caller that sets
      // the flag wrongly still cannot put Money on a worker's rail.
      return ctx.founders.finances && ctx.founders.content && ctx.oasis && ctx.persona === "founder";
    case "operator":
      return ctx.isOperator && ctx.oasis;
    default: {
      // A new audience word with no rule here is a row nobody decided about.
      const unhandled: never = audience;
      void unhandled;
      return false;
    }
  }
}

function entryVisible(entry: OsNavEntry, ctx: VisibilityContext): boolean {
  if (entry.module && !ctx.modules.has(entry.module)) return false;
  if (entry.oasisOnly && !ctx.oasis) return false;
  return audienceAllows(entry.audience, ctx);
}

function toRow(entry: OsNavEntry): OsNavRow {
  return {
    id: entry.id,
    href: entry.href,
    label: entry.label,
    icon: entry.icon,
    ...(entry.badgeKey ? { badgeKey: entry.badgeKey } : {}),
  };
}

/** Group visible entries into ordered sections; empty sections vanish. */
function groupIntoSections(entries: readonly OsNavEntry[]): OsNavSection[] {
  const sections: OsNavSection[] = [];
  for (const meta of OS_SECTIONS) {
    const inSection = entries.filter((e) => e.section === meta.key);
    if (inSection.length === 0) continue;
    const groups: OsNavGroup[] = [];
    const byLabel = new Map<string, OsNavGroup>();
    for (const entry of inSection) {
      const label = entry.group ?? null;
      const id = `${meta.key}:${label ?? "_"}`;
      let group = byLabel.get(id);
      if (!group) {
        group = { id, label, rows: [] };
        byLabel.set(id, group);
        groups.push(group);
      }
      group.rows.push(toRow(entry));
    }
    sections.push({ ...meta, home: groups[0].rows[0].href, groups });
  }
  return sections;
}

/** The rows a viewer may see, flat, in catalog order, before grouping. */
function visibleEntries(input: BuildOsNavInput): OsNavEntry[] {
  const provisioned = input.provisioned !== false;
  // Fail closed twice over: an unprovisioned workspace and an unresolved
  // viewer both get the one row every member has — never OASIS's rail.
  if (!provisioned || !input.persona) {
    return OS_NAV_CATALOG.filter((e) => e.unprovisioned === true);
  }
  const persona = input.persona;
  const ctx: VisibilityContext = {
    persona,
    capabilities: input.capabilities ?? capabilitiesFor(persona, input.tenantSlug),
    isOperator: input.isOperator === true,
    oasis: input.isOasisTenant === true && isOasisSurfaceTenant(input.tenantSlug),
    modules: new Set(input.modules),
    founders: {
      content: input.founders?.content === true,
      finances: input.founders?.finances === true,
    },
  };
  const visible = OS_NAV_CATALOG.filter((e) => entryVisible(e, ctx));
  // LAST, over the fully assembled list, so no future row can skip it.
  return filterNavForPersona(visible, persona);
}

export function buildOsNav(input: BuildOsNavInput): OsNavSection[] {
  return groupIntoSections(visibleEntries(input));
}

/**
 * Would the rail draw a row for `href` for this viewer? For page gates (e.g.
 * `app/team/[dept]`) that want the same answer the rail gave, so a tab can
 * never be visible over a 404 or hidden over a page that works. Exact href
 * match against the catalog; a route with no catalog row answers false —
 * gate those with their own rule.
 */
export function mayOpenOsHref(input: BuildOsNavInput, href: string): boolean {
  return visibleEntries(input).some((e) => e.href === href);
}

/** Every row in the built sections, flat — for the breadcrumb and active mode. */
export function osNavRows(sections: readonly OsNavSection[]): Array<OsNavRow & { section: OsSectionKey }> {
  return sections.flatMap((s) => s.groups.flatMap((g) => g.rows.map((r) => ({ ...r, section: s.key }))));
}

/** The department channel the Ask button opens (plan D2), when this viewer has it. */
export const ASK_HREF = "/team/chief-of-staff";

export function askHrefFor(sections: readonly OsNavSection[]): string | null {
  return osNavRows(sections).some((r) => r.href === ASK_HREF) ? ASK_HREF : null;
}
