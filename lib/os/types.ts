/**
 * lib/os/types.ts — the vocabulary of the OASIS OS shell.
 *
 * PURE TYPES. No runtime code, no imports beyond other types, so a client
 * component, a server component and a bare-node test can all share them. The
 * catalog and the pure `buildOsNav` that consume these live in lib/os/nav.ts.
 *
 * Design source: docs/os-revamp/01-product-surface-ia-ux.md §(a) and §(e).
 */

import type { NavIconKey } from "@/lib/nav-config";

/**
 * The rail's modes. Team · Growth · Clients · Money are the four mode tabs;
 * Admin is reached from the shield in the rail footer and is never a tab.
 * Settings is reached from the gear and has no section here.
 */
export type OsSectionKey = "team" | "growth" | "clients" | "money" | "admin";

/**
 * Switchable capabilities. A module is something a workspace has BOUGHT or had
 * turned on for it — never something a persona is. Until tenant_entitlements
 * exists (plan D7), lib/os/modules.ts resolves them from the workspace slug and
 * fails closed for every workspace that is not OASIS's own.
 */
export type ModuleKey =
  | "finance"
  | "commissions"
  | "legal"
  | "content"
  | "research"
  | "ads"
  | "meetings"
  | "enablement"
  | "prospects"
  | "portal";

export type DepartmentKey =
  | "chief_of_staff"
  | "sales"
  | "marketing"
  | "client_success"
  | "finance"
  | "operations";

/**
 * Who may see a catalog row, as ONE declarative word per row so the whole
 * matrix is reviewable in the catalog and testable without a session.
 *
 *   everyone            any member of a provisioned workspace
 *   manage              owner / admin (persona `founder`) of the workspace
 *   system              capabilities.canSeeSystemSurfaces — the same flag the
 *                       page's requireSystemSurface() gate reads
 *   delivery            lib/delivery/access.ts: inside OASIS only a founder;
 *                       in any other workspace, its own members (as a client)
 *   client_identities   capabilities.canSeeClientIdentities
 *   commissions         maySeeCommissionSurface(capabilities) — the page's gate
 *   company_financials  capabilities.canSeeCompanyFinancials (already OASIS-only)
 *   founders_content    the founders-portal gate the layout computes today
 *                       (FOUNDERS_TENANT_IDS + canSeeMarketing + own shell)
 *   finance_owner       that gate AND isFinanceOwnerEmail — the Finances rule
 *   operator            a platform operator (resolvePlatformOperator), standing
 *                       in an OASIS workspace
 */
export type OsAudience =
  | "everyone"
  | "manage"
  | "system"
  | "delivery"
  | "client_identities"
  | "commissions"
  | "company_financials"
  | "founders_content"
  | "finance_owner"
  | "operator";

/** One row in the catalog. Declarative; `buildOsNav` decides visibility. */
export type OsNavEntry = {
  /** Stable id — React key, collapse-state key, test handle. */
  id: string;
  href: string;
  label: string;
  icon: NavIconKey;
  section: OsSectionKey;
  /** Sentence-case, collapsible group inside the section. Absent = ungrouped. */
  group?: string;
  department?: DepartmentKey;
  module?: ModuleKey;
  audience: OsAudience;
  /** Only ever rendered in an OASIS-owned workspace. */
  oasisOnly?: boolean;
  /** Key into the deferred badge map (a count renders as a red pill). */
  badgeKey?: string;
  /** Still rendered for a workspace that has not been provisioned yet. */
  unprovisioned?: boolean;
};

/** A row as the client rail receives it. Plain data: crosses the RSC boundary. */
export type OsNavRow = {
  id: string;
  href: string;
  label: string;
  icon: NavIconKey;
  badgeKey?: string;
};

export type OsNavGroup = {
  /** `${section}:${label}` for a named group, `${section}:_` for the ungrouped head. */
  id: string;
  /** Null for the ungrouped rows at the top of a section. */
  label: string | null;
  rows: OsNavRow[];
};

export type OsNavSection = {
  key: OsSectionKey;
  label: string;
  icon: NavIconKey;
  /** Where the mode tab goes: the section's first visible row. */
  home: string;
  groups: OsNavGroup[];
};
