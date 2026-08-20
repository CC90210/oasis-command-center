/**
 * role-surfaces — WHO SEES WHICH SURFACE. One module, asked by every surface.
 *
 * THE PROBLEM THIS EXISTS TO FIX (2026-08-19, operator-reported)
 * `/today` rendered company financials to whoever was logged in: Net MRR, gap
 * to goal, "top client share 96% — BreezeAdvance", the MRR trajectory chart,
 * the whole tenant's pipeline count, and the company inbound tape. OASIS is
 * onboarding OUTSIDE commission-only sales contractors (team_role='agent') this
 * week. A contractor must never see company revenue, client names, client
 * concentration, or another rep's book.
 *
 * WHY A PERSONA LAYER AND NOT `teamRole === "admin"` AT EACH CALL SITE
 * Seven roles times ~15 surfaces is 105 independent judgement calls, and the
 * ones that drift are invisible until a contractor screenshots a client name.
 * A surface asks ONE question here and gets a boolean. When the answer needs to
 * change it changes once.
 *
 * TWO RULES THIS MODULE ENCODES, both learned the expensive way:
 *
 *   1. GATE ON TENANT SLUG **AND** CAPABILITY, NEVER ON ROLE ALONE.
 *      An `isOperator || …` check once put SunBiz's underwriting queue on
 *      OASIS's own /automations, and the API served it happily. Role is
 *      per-tenant; "admin" on SunBiz is not "admin" on OASIS. So the money
 *      capabilities below additionally require the viewer to be standing in an
 *      OASIS-owned workspace — see `capabilitiesFor`.
 *
 *   2. FAIL CLOSED ON AN UNKNOWN ROLE.
 *      A null / empty / misspelled / newly-added team_role resolves to
 *      `readonly`, the least-privileged persona — never to a persona that can
 *      see money. Same discipline as resolveSessionContext defaulting teamRole
 *      to "read_only" and CRM_WRITE_ROLES being an allowlist. A role added to
 *      the enum next month gets no surface until someone writes it down here
 *      ON PURPOSE.
 *
 * PURE BY DESIGN. No session, no database, no env, no next/* import — so it is
 * unit-testable (tests/role-surfaces.test.ts) and so importing it from a client
 * component can never drag the server chain into the browser bundle. The
 * session-shaped wrapper lives in lib/role-surfaces-session.ts and delegates
 * every decision back here.
 *
 * HIDING IS NOT ENFORCING. `filterNavForPersona` removes sidebar rows, which is
 * cosmetic — a URL still resolves. Every page a persona must not reach ALSO
 * carries its own server-side gate (see `requireSystemSurface`). Both layers or
 * neither; a hidden tab over a live page is a rehearsal for a leak.
 */

import { OASIS_WEBSITE_TENANT_SLUG } from "@/lib/website-sales-workflow";

/**
 * The five kinds of person who open this dashboard.
 *
 * Deliberately NOT one-per-team_role: `owner` and `admin` want the identical
 * screen, and a persona list that mirrors the role enum would put the mapping
 * decision back at every call site, which is the thing this module removes.
 *
 *   founder  — CC / Adon. The whole business: money, all pipeline, clients,
 *              content, the agent fleet.
 *   sales    — outside commission-only contractor (team_role='agent'). Their
 *              own queue, their own commission, and nothing else.
 *   worker   — internal fulfilment / builder (team_role='member'). Delivery
 *              queues; no money, no prospecting pipeline.
 *   readonly — the worker surface with the actions taken away.
 *   legacy   — SunBiz's own roles (loan_officer / processor). See below.
 */
export type Persona = "founder" | "sales" | "worker" | "readonly" | "legacy";

/**
 * What a persona is allowed to SEE. Each flag names a class of data, not a
 * component — a card can move or be rewritten without the policy changing.
 *
 * Read these as "may this data be FETCHED", not "may this card be rendered".
 * The distinction is the whole point: a number that is fetched and then hidden
 * with a CSS class still ships inside the RSC payload and is readable in
 * devtools. If a flag is false, the query must not run.
 */
export type SurfaceCapabilities = {
  /** Net MRR, gap to goal, MRR history, top-client concentration. Company money. */
  canSeeCompanyFinancials: boolean;
  /** Every lead in the tenant, at every stage. */
  canSeeAllPipeline: boolean;
  /** Only leads assigned to this viewer, only at the rep-workable stages. */
  canSeeOwnPipelineOnly: boolean;
  /** This viewer's own commission rows (website_sales_commissions.rep_user_id = me). */
  canSeeOwnCommissionOnly: boolean;
  /** Every rep's commission — the payout ledger a founder approves from. */
  canSeeCommissionLedger: boolean;
  /** Post-sale delivery: onboarding / in_build / client_review / launched. */
  canSeeDeliveryQueues: boolean;
  /** Client and company names beyond the viewer's own assigned leads. */
  canSeeClientIdentities: boolean;
  /** The shared inbound-email tape (the company mailbox). */
  canSeeInboundTape: boolean;
  /** The founders marketing portal. Also gated by FOUNDERS_TENANT_IDS. */
  canSeeMarketing: boolean;
  /** /operations, /automations, /health, /analytics, /settings, /agents. */
  canSeeSystemSurfaces: boolean;
  /** May take actions at all. read_only is the one persona that may not. */
  canAct: boolean;
};

/**
 * Workspaces that are OASIS's OWN. The website-sales business runs on
 * `oasis-webdev` (reps live there); the agency CRM is `oasis-ai-cc`; `oasis` is
 * the historical slug. A viewer standing anywhere else is standing in a
 * customer's workspace, and OASIS's company money is not theirs to see even if
 * they are an owner of that workspace.
 *
 * Imported, not retyped: OASIS_WEBSITE_TENANT_SLUG is declared once in
 * lib/website-sales-workflow.ts and every surface reads it from there.
 */
export const OASIS_SURFACE_TENANT_SLUGS: ReadonlySet<string> = new Set([
  "oasis",
  "oasis-ai-cc",
  OASIS_WEBSITE_TENANT_SLUG,
]);

/** True when `slug` names an OASIS-owned workspace. Unknown / null / "" → false. */
export function isOasisSurfaceTenant(slug: string | null | undefined): boolean {
  return OASIS_SURFACE_TENANT_SLUGS.has((slug || "").trim().toLowerCase());
}

/** Everything persona resolution needs. Mirrors the fields resolveSessionContext returns. */
export type PersonaInput = {
  /** user_profiles.team_role, as resolved by the session layer. */
  teamRole: string | null | undefined;
  /** PERMANENT admin by base role (is_owner, or team_role owner/admin). */
  isTrueAdmin?: boolean | null;
  /** The additive admin_access toggle grant. */
  adminAccess?: boolean | null;
};

/**
 * Map a session to its persona. ALLOWLIST, in priority order — an unrecognised
 * role reaches the final line and becomes `readonly`.
 *
 * The admin_access grant counts as founder here on purpose: it is the toggle an
 * admin flips to give someone the full screen temporarily. It does NOT confer
 * escalation powers — that stays gated on isTrueAdmin in lib/team.ts, which
 * this function does not touch.
 */
export function resolvePersona(input: PersonaInput): Persona {
  const role = (input.teamRole || "").trim().toLowerCase();
  if (input.isTrueAdmin === true || input.adminAccess === true) return "founder";
  if (role === "owner" || role === "admin") return "founder";
  if (role === "agent") return "sales";
  if (role === "member") return "worker";
  if (role === "loan_officer" || role === "processor") return "legacy";
  if (role === "read_only") return "readonly";
  // Fail closed. Not "member", not "agent" — the persona that can see the least.
  return "readonly";
}

const FOUNDER: SurfaceCapabilities = {
  canSeeCompanyFinancials: true,
  canSeeAllPipeline: true,
  canSeeOwnPipelineOnly: false,
  canSeeOwnCommissionOnly: false,
  canSeeCommissionLedger: true,
  canSeeDeliveryQueues: true,
  canSeeClientIdentities: true,
  canSeeInboundTape: true,
  canSeeMarketing: true,
  canSeeSystemSurfaces: true,
  canAct: true,
};

/**
 * The commission-only outside contractor. Every money-shaped flag is false
 * except their OWN accrual, and every tenant-wide flag is false including the
 * client names that would otherwise leak through the pipeline count.
 */
const SALES: SurfaceCapabilities = {
  canSeeCompanyFinancials: false,
  canSeeAllPipeline: false,
  canSeeOwnPipelineOnly: true,
  canSeeOwnCommissionOnly: true,
  canSeeCommissionLedger: false,
  canSeeDeliveryQueues: false,
  canSeeClientIdentities: false,
  canSeeInboundTape: false,
  canSeeMarketing: false,
  canSeeSystemSurfaces: false,
  canAct: true,
};

/** Internal fulfilment. Sees the work, not the money. */
const WORKER: SurfaceCapabilities = {
  canSeeCompanyFinancials: false,
  canSeeAllPipeline: true,
  canSeeOwnPipelineOnly: false,
  canSeeOwnCommissionOnly: false,
  canSeeCommissionLedger: false,
  canSeeDeliveryQueues: true,
  canSeeClientIdentities: true,
  canSeeInboundTape: false,
  canSeeMarketing: false,
  canSeeSystemSurfaces: true,
  canAct: true,
};

const READONLY: SurfaceCapabilities = { ...WORKER, canAct: false };

/**
 * loan_officer / processor — SunBiz's own roles, predating this model.
 *
 * They keep the surface they have today. Not because it is the design we would
 * choose now, but because changing it is a regression to a working product for
 * people who never asked: `/` redirects a SunBiz session to /t/sun long before
 * any persona branch runs (app/page.tsx), so this row describes a path that is
 * unreachable in practice and exists so the matrix is total rather than having
 * a hole where two roles fall through.
 *
 * The money flags below are still narrowed by tenant in `capabilitiesFor`, so a
 * SunBiz role that somehow landed on an OASIS workspace would not see OASIS's
 * revenue. Grandfathering behaviour is not the same as grandfathering a leak.
 */
const LEGACY: SurfaceCapabilities = { ...FOUNDER, canSeeMarketing: false };

export const SURFACE_CAPABILITIES: Record<Persona, SurfaceCapabilities> = {
  founder: FOUNDER,
  sales: SALES,
  worker: WORKER,
  readonly: READONLY,
  legacy: LEGACY,
};

/**
 * The capability record for a persona STANDING IN A PARTICULAR WORKSPACE.
 *
 * The tenant argument is not decoration. `canSeeCompanyFinancials` and
 * `canSeeMarketing` describe OASIS's own money and OASIS's own content, so they
 * additionally require an OASIS-owned slug — the second half of "gate on tenant
 * slug AND capability, never on role alone".
 *
 * An unresolvable slug (null, a failed lookup) is treated as NOT ours, so the
 * degraded path loses money rather than leaking it. Callers that care about the
 * difference between "not your workspace" and "could not tell" should say so on
 * screen instead of rendering a confident zero — see components/today.
 */
export function capabilitiesFor(
  persona: Persona,
  tenantSlug?: string | null,
): SurfaceCapabilities {
  const base = SURFACE_CAPABILITIES[persona];
  const oasisWorkspace = isOasisSurfaceTenant(tenantSlug);
  return {
    ...base,
    canSeeCompanyFinancials: base.canSeeCompanyFinancials && oasisWorkspace,
    canSeeMarketing: base.canSeeMarketing && oasisWorkspace,
  };
}

/**
 * Nav destinations a `sales` persona may reach. Prefix-matched, so `/playbook`
 * covers `/playbook/script` — the rep call guide, which is the single most
 * useful page on this list for someone about to dial.
 *
 * `/` is Today. `/schedule` is their own week (browser-local, per-user). The
 * pipeline is theirs alone once filterWebsiteSalesRows has run.
 *
 * ALLOWLIST, not a denylist: a route added to the manifest next month is
 * invisible to a contractor until someone adds it here deliberately. A denylist
 * would have shipped every new page to them by default.
 */
export const SALES_NAV_ALLOWLIST: readonly string[] = [
  "/",
  "/schedule",
  "/pipeline",
  "/playbook",
];

/** Path-prefix match on a URL boundary: `/playbook` matches `/playbook/script`, not `/playbooks`. */
function matchesAllowedPrefix(href: string, prefix: string): boolean {
  const h = (href || "").trim().toLowerCase();
  if (prefix === "/") return h === "/";
  return h === prefix || h.startsWith(`${prefix}/`);
}

/** May this persona reach `href` at all? Only `sales` is narrowed today. */
export function personaMayVisit(persona: Persona, href: string): boolean {
  if (persona !== "sales") return true;
  return SALES_NAV_ALLOWLIST.some((p) => matchesAllowedPrefix(href, p));
}

/**
 * Drop the nav rows a persona may not use.
 *
 * REMOVED, never disabled. A greyed, unclickable row is still a row that says
 * "there is an Analytics page and you are not important enough for it" — and
 * `enabled: false` items have shipped as visible tabs here before. The
 * contractor's sidebar should read as a complete, honest tool, not a redacted
 * copy of someone else's.
 *
 * Generic over the item shape so it works on NavItem without this module
 * importing the nav layer.
 */
export function filterNavForPersona<T extends { href: string }>(
  items: T[],
  persona: Persona,
): T[] {
  if (persona !== "sales") return items;
  return items.filter((item) => personaMayVisit(persona, item.href));
}
