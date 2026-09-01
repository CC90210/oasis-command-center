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
import {
  OASIS_SALES_ROLE_OPTIONS,
  PLATFORM_ROLE_OPTIONS,
  type RoleOption,
} from "@/lib/team-roles";

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
export type Persona =
  | "founder"
  | "manager"
  | "sales"
  | "marketing"
  | "builder"
  | "worker"
  | "readonly"
  | "legacy";

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
  /**
   * Leads assigned to a known OASIS sales rep in the viewer's tenant. This is a
   * THIRD scope between "all" and "own": a manager may coach the active sales
   * book, but unassigned, founder, admin and system records stay outside it.
   * The OASIS pipeline list and detail reads enforce this through a server-side
   * sales-roster lookup; generic manifest surfaces do not consume this flag.
   */
  canSeeTeamPipeline: boolean;
  /** Only leads assigned to this viewer, only at the rep-workable stages. */
  canSeeOwnPipelineOnly: boolean;
  /** This viewer's own commission rows (website_sales_commissions.rep_user_id = me). */
  canSeeOwnCommissionOnly: boolean;
  /**
   * Commission rows for the OASIS sales roster this viewer coaches — what a
   * manager needs to verify the override they are paid on. NOT the tenant-wide
   * ledger.
   *
   * ⚠ DECLARED, NOT YET ENFORCED (2026-08-21). Same status as
   * canSeeTeamPipeline above, and additionally blocked on the multi-party
   * commission ledger: website_sales_commissions is still one row per deal
   * keyed on a single rep_user_id, so there is no manager-override row for this
   * flag to reveal even once a reader exists.
   */
  canSeeTeamCommission: boolean;
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
  /** /operations, /automations, /health, /analytics, /agents and admin-only settings. */
  canSeeSystemSurfaces: boolean;
  /** Their own profile, password and personal provider connections. */
  canSeePersonalSettings: boolean;
  /** Read-only sales-team activity and performance inside safe Settings cards. */
  canSeeTeamPerformance: boolean;
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

/**
 * Which roles may be handed out in this workspace.
 *
 * The OASIS sales job titles are a PRODUCT concern. CONTEXT.md's rule is that
 * product features do not extrapolate across tenants — so a SunBiz admin's
 * invite menu offers Member and Admin, and an OASIS admin's also offers the four
 * sales titles. Without this, every tenant on the platform would be offered
 * "Closer", and anyone invited as one onto a foreign tenant would resolve to a
 * persona built for a workspace they are not standing in.
 *
 * This lives here rather than in lib/team-roles.ts because it is a policy that
 * depends on the workspace, and this module already owns "which OASIS slugs are
 * ours". team-roles.ts stays dependency-free and answers only "what roles exist".
 *
 * Unknown / null slug → platform roles only. Fail closed: an unresolvable
 * workspace does not get the product's roles.
 */
export function invitableRoleOptionsFor(
  tenantSlug: string | null | undefined,
): ReadonlyArray<RoleOption> {
  return isOasisSurfaceTenant(tenantSlug)
    ? [
        ...PLATFORM_ROLE_OPTIONS.filter((option) => option.value === "admin"),
        ...OASIS_SALES_ROLE_OPTIONS,
      ]
    : PLATFORM_ROLE_OPTIONS;
}

/**
 * Server-side counterpart to the menu above — the API's gate, not the UI's.
 * The dropdown not offering a role is cosmetic; this is what makes a hand-rolled
 * POST of `{"role":"closer"}` against a SunBiz tenant fail.
 */
export function roleAllowedForTenant(
  role: string,
  tenantSlug: string | null | undefined,
): boolean {
  return invitableRoleOptionsFor(tenantSlug).some((o) => o.value === role);
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
  if (role === "manager") return "manager";
  if (role === "marketing") return "marketing";
  // opener and closer share ONE persona on purpose. Their SURFACES are identical
  // — own book, own commission, no company money. What differs is which pipeline
  // STAGES they may act on, which is a pipeline-policy question and lives in
  // lib/oasis-sales-pipeline-policy.ts. Splitting the persona here would put the
  // same screen behind two rows that must then be kept identical by hand, which
  // is the drift this module exists to remove.
  if (role === "closer" || role === "opener" || role === "agent") return "sales";
  // builder NO LONGER shares the legacy `worker` persona. It did, and that
  // handed a delivery contractor every system surface and the whole tenant
  // pipeline — see the BUILDER row below.
  if (role === "builder") return "builder";
  if (role === "member") return "worker";
  if (role === "loan_officer" || role === "processor") return "legacy";
  if (role === "read_only") return "readonly";
  // Fail closed. Not "worker", not "sales" — the persona that can see the least.
  return "readonly";
}

const FOUNDER: SurfaceCapabilities = {
  canSeeCompanyFinancials: true,
  canSeeAllPipeline: true,
  canSeeTeamPipeline: true,
  canSeeOwnPipelineOnly: false,
  canSeeOwnCommissionOnly: false,
  canSeeTeamCommission: true,
  canSeeCommissionLedger: true,
  canSeeDeliveryQueues: true,
  canSeeClientIdentities: true,
  canSeeInboundTape: true,
  canSeeMarketing: true,
  canSeeSystemSurfaces: true,
  canSeePersonalSettings: true,
  canSeeTeamPerformance: true,
  canAct: true,
};

/**
 * The sales manager. Coaches a team, is paid an override on what OASIS retains
 * from that team's deals, and sells personally alongside them.
 *
 * The line this persona draws: they see THEIR TEAM's book and THEIR TEAM's
 * commission, because they cannot manage what they cannot see and cannot verify
 * their own override without it. They do NOT see company financials — Net MRR,
 * gap to goal, client concentration — because a manager is still a commission
 * contractor, not a partner in the business. That distinction is the entire
 * reason `canSeeTeamPipeline` exists rather than reusing `canSeeAllPipeline`:
 * "all" would have handed them the whole tenant, including CC's own leads.
 *
 * canSeeSystemSurfaces stays FALSE. /operations, /health and /automations are
 * OASIS's internal machinery, not a sales management tool. The manager's
 * equivalents — team performance, team payouts — are their own surfaces built
 * on the two flags above, per CC's "same tab names, their own data".
 */
const MANAGER: SurfaceCapabilities = {
  canSeeCompanyFinancials: false,
  canSeeAllPipeline: false,
  canSeeTeamPipeline: true,
  canSeeOwnPipelineOnly: true,
  canSeeOwnCommissionOnly: true,
  canSeeTeamCommission: true,
  canSeeCommissionLedger: false,
  canSeeDeliveryQueues: false,
  // Their team's deals are their team's clients. Scoped by canSeeTeamPipeline,
  // not a licence to browse the tenant's client list.
  canSeeClientIdentities: true,
  canSeeInboundTape: false,
  canSeeMarketing: false,
  canSeeSystemSurfaces: false,
  canSeePersonalSettings: true,
  canSeeTeamPerformance: true,
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
  canSeeTeamPipeline: false,
  canSeeOwnPipelineOnly: true,
  canSeeOwnCommissionOnly: true,
  canSeeTeamCommission: false,
  canSeeCommissionLedger: false,
  canSeeDeliveryQueues: false,
  canSeeClientIdentities: false,
  canSeeInboundTape: false,
  canSeeMarketing: false,
  canSeeSystemSurfaces: false,
  canSeePersonalSettings: true,
  canSeeTeamPerformance: false,
  canAct: true,
};

/** Internal fulfilment — the `builder` role, and the legacy `member`. Sees the
 *  work, not the money. */
const WORKER: SurfaceCapabilities = {
  canSeeCompanyFinancials: false,
  canSeeAllPipeline: true,
  canSeeTeamPipeline: true,
  canSeeOwnPipelineOnly: false,
  canSeeOwnCommissionOnly: false,
  canSeeTeamCommission: false,
  canSeeCommissionLedger: false,
  canSeeDeliveryQueues: true,
  canSeeClientIdentities: true,
  canSeeInboundTape: false,
  canSeeMarketing: false,
  canSeeSystemSurfaces: true,
  canSeePersonalSettings: true,
  canSeeTeamPerformance: false,
  canAct: true,
};

/**
 * Marketing staff — content, campaigns, the founders marketing studio.
 *
 * THE ONE THING THIS ROLE EXISTS TO MAKE POSSIBLE: reaching Marketing WITHOUT
 * being an admin. Before it, the only persona with canSeeMarketing was
 * `founder`, so hiring a marketing person meant handing them Net MRR, the
 * commission ledger, every client name and the whole pipeline — or hiring them
 * and giving them no access to the thing they were hired to do.
 *
 * canSeeMarketing is TRUE and every company-money flag is FALSE. CC's
 * 2026-08-26 directive also lets this seat work its own assigned sales leads;
 * that does not grant tenant-wide visibility or the commission ledger.
 *
 * canSeeClientIdentities is TRUE because a case study, a testimonial or a logo
 * wall is client work by name — that is the job. It is scoped by the same
 * tenant gate as everything else in capabilitiesFor.
 */
const MARKETING: SurfaceCapabilities = {
  canSeeCompanyFinancials: false,
  canSeeAllPipeline: false,
  canSeeTeamPipeline: false,
  canSeeOwnPipelineOnly: true,
  canSeeOwnCommissionOnly: false,
  canSeeTeamCommission: false,
  canSeeCommissionLedger: false,
  canSeeDeliveryQueues: false,
  canSeeClientIdentities: true,
  canSeeInboundTape: false,
  canSeeMarketing: true,
  canSeeSystemSurfaces: false,
  canSeePersonalSettings: true,
  canSeeTeamPerformance: false,
  canAct: true,
};

/**
 * The delivery builder — an OUTSIDE contractor who builds the sites sold.
 *
 * SPLIT OUT OF `worker` ON 2026-08-21, AFTER A REAL EXPOSURE. A builder
 * resolved to the legacy `worker` persona, which carries
 * canSeeSystemSurfaces: true and canSeeAllPipeline: true. The first builder
 * invited to the platform could therefore open /operations, /automations,
 * /health, /analytics and /settings, and read every lead in the tenant.
 *
 * `worker` was written for INTERNAL staff on the `member` role — 43 of whom
 * exist, most on SunBiz — so widening or narrowing it in place would have
 * changed those people's access to fix a different problem. Hence a separate
 * row rather than an edit.
 *
 * canSeeSystemSurfaces is FALSE and that one matters most: /automations
 * controls background workers and drip sends that run on CC's own machine, and
 * /operations is the empire's internal health. A contractor toggling either is
 * not a permissions nicety, it is an outage. They are not read-only pages with
 * a friendly audience — they are controls.
 *
 * What a builder DOES get: the delivery queues they work from, and client
 * identities, because you cannot build a client's website without knowing who
 * the client is.
 */
const BUILDER: SurfaceCapabilities = {
  canSeeCompanyFinancials: false,
  canSeeAllPipeline: false,
  canSeeTeamPipeline: false,
  // CC, 2026-08-25: this hire now sells as well as builds and markets. Still
  // OWN-book only — "all" stays false below, so what widened is his reach into
  // his own claimed deals, never a view of anyone else's.
  canSeeOwnPipelineOnly: true,
  canSeeOwnCommissionOnly: true,
  canSeeTeamCommission: false,
  canSeeCommissionLedger: false,
  canSeeDeliveryQueues: true,
  canSeeClientIdentities: true,
  canSeeInboundTape: false,
  // CC, 2026-08-21: this hire is "a builder and a marketing specialist". One
  // profile carries one role, so the builder row grants the marketing studio
  // rather than forcing a choice between the two halves of the job. Still
  // gated by tenant in capabilitiesFor.
  canSeeMarketing: true,
  canSeeSystemSurfaces: false,
  canSeePersonalSettings: true,
  canSeeTeamPerformance: false,
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
const LEGACY: SurfaceCapabilities = {
  ...FOUNDER,
  canSeeMarketing: false,
  // Grandfathered SunBiz access does not turn into OASIS sales-team reporting.
  canSeeTeamPerformance: false,
};

export const SURFACE_CAPABILITIES: Record<Persona, SurfaceCapabilities> = {
  founder: FOUNDER,
  manager: MANAGER,
  sales: SALES,
  marketing: MARKETING,
  builder: BUILDER,
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
    // Founders retain their tenant settings everywhere. A manager's team view
    // is an OASIS product capability and must fail closed on a foreign/unknown
    // workspace even if a row there happens to carry team_role="manager".
    canSeeTeamPerformance:
      base.canSeeTeamPerformance && (persona === "founder" || oasisWorkspace),
  };
}

/**
 * Canonical invite menu after both workspace eligibility and actor escalation
 * rules are applied. A temporary admin_access grant may invite teammates but
 * cannot mint a permanent Administrator, so that option is removed rather
 * than displayed as a button the API will reject.
 */
export function invitableRoleOptionsForActor(
  tenantSlug: string | null | undefined,
  canGrantAdmin: boolean,
): ReadonlyArray<RoleOption> {
  return invitableRoleOptionsFor(tenantSlug).filter(
    (option) => option.value !== "admin" || canGrantAdmin,
  );
}

/**
 * Narrow manager read gate used by the OASIS pipeline query and detail page.
 * This is NOT an admin check and conveys no mutation, assignment, unassigned,
 * founder, or system-record access.
 */
export function canReadOasisSalesTeamPipeline(input: {
  teamRole: string | null | undefined;
  tenantSlug: string | null | undefined;
}): boolean {
  return (
    (input.teamRole || "").trim().toLowerCase() === "manager" &&
    isOasisSurfaceTenant(input.tenantSlug)
  );
}

/**
 * Is `assignedTo` a seat inside this manager's server-resolved roster?
 *
 * ONE definition, because two are how surfaces drift apart. This was
 * implemented twice as of 2026-09-01 — once as managerCanReadAssignment() in
 * lib/web-leads/data.ts for the prospecting surface, and once inline in
 * app/pipeline/[id]/page.tsx for the lead workspace. Two independent answers to
 * "may this manager act on this assignment" is exactly the failure that put a
 * manager's Leads list and Leads detail out of sync in the first place; keeping
 * a second copy to fix the first one would have been the same bug one layer up.
 *
 * Fails closed on every degenerate input: a non-manager role, an unassigned
 * lead, or an unresolved roster all return false. Callers that mean "unassigned
 * is fine" must say so themselves — that is a different question, and folding it
 * in here would silently grant the pool to any caller that only wanted the
 * roster.
 *
 * Comparison is trimmed and lowercased on both sides: assigned_to is written
 * from an already-lowercased auth user id, but this must not start failing
 * quietly if that ever stops being true on some row.
 */
export function managerRosterCoversAssignment(input: {
  teamRole: string | null | undefined;
  assignedTo: string | null | undefined;
  readableAssigneeIds: readonly string[] | null | undefined;
}): boolean {
  if ((input.teamRole || "").trim().toLowerCase() !== "manager") return false;
  const assignee = (input.assignedTo || "").trim().toLowerCase();
  if (!assignee) return false;
  return (input.readableAssigneeIds || []).some(
    (candidate) => (candidate || "").trim().toLowerCase() === assignee,
  );
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
  "/settings",
  // The Leads browser (CC, 2026-08-21): "those sales reps should be able to
  // access the leads page so they can import leads themselves."
  //
  // This is the prospecting POOL, not another rep's book — a public directory
  // of Canadian businesses with website status, filtered by province, city and
  // industry. Nothing in it is assigned to anyone, so opening it to reps
  // exposes no colleague's pipeline. It is what makes self-sourcing possible,
  // which is the track that pays them 25/40/70 rather than 20/30.
  "/web-leads",
];

/**
 * The sales manager's nav: the rep's rows plus the leads board they coach from.
 *
 * Settings is present for the personal profile/integration cards and the
 * manager's read-only team activity/performance cards. Analytics, operations,
 * automations and health remain absent: those are system surfaces, and the
 * manager capability does not turn into system administration.
 *
 * `/leads` is deliberately absent. That generic manifest surface can express
 * only all-vs-own scope, while the manager boundary is "assigned to a known
 * OASIS sales rep". `/pipeline` is the canonical, roster-scoped team board.
 */
export const MANAGER_NAV_ALLOWLIST: readonly string[] = [
  "/",
  "/schedule",
  "/pipeline",
  "/playbook",
  "/settings",
  // Managers assign from the same pool their reps source from.
  "/web-leads",
];

/**
 * Which allowlist narrows which persona. A persona ABSENT from this map is not
 * narrowed at all — that is how founder / worker / legacy keep the full nav.
 *
 * A map rather than an if-chain so adding a narrowed persona is a data change,
 * and so `personaMayVisit` cannot accidentally fall through to "allow" for one
 * of them the way an unmatched `if (persona !== "sales")` did.
 */
/**
 * Marketing's nav. Today, their own week, assigned pipeline, playbook, and the
 * marketing studio itself.
 *
 * /pipeline is own-only under the shared OASIS policy. /leads and the system
 * surfaces remain excluded.
 */
export const MARKETING_NAV_ALLOWLIST: readonly string[] = [
  "/",
  "/schedule",
  "/pipeline",
  "/playbook",
  "/settings",
  "/founders/marketing",
];

/**
 * The builder's nav: their delivery work, the studio, and nothing that controls
 * the machine. /automations and /operations are deliberately absent — those run
 * background workers and sends on CC's own hardware.
 */
export const BUILDER_NAV_ALLOWLIST: readonly string[] = [
  "/",
  "/schedule",
  "/pipeline",
  "/playbook",
  "/settings",
  "/founders/marketing",
  // CC, 2026-08-25: the builder/marketing hire also sells, so he sources from
  // the same prospecting pool the reps do and claims into his own book.
  "/web-leads",
];

const PERSONA_NAV_ALLOWLIST: Partial<Record<Persona, readonly string[]>> = {
  builder: BUILDER_NAV_ALLOWLIST,
  sales: SALES_NAV_ALLOWLIST,
  manager: MANAGER_NAV_ALLOWLIST,
  marketing: MARKETING_NAV_ALLOWLIST,
};

/** Path-prefix match on a URL boundary: `/playbook` matches `/playbook/script`, not `/playbooks`. */
function matchesAllowedPrefix(href: string, prefix: string): boolean {
  const h = (href || "").trim().toLowerCase();
  if (prefix === "/") return h === "/";
  return h === prefix || h.startsWith(`${prefix}/`);
}

/** May this persona reach `href` at all? Narrowed personas only; others pass. */
export function personaMayVisit(persona: Persona, href: string): boolean {
  const allowlist = PERSONA_NAV_ALLOWLIST[persona];
  if (!allowlist) return true;
  return allowlist.some((p) => matchesAllowedPrefix(href, p));
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
 * `persona` is NULLABLE, and null means "do not narrow".
 *
 * That decision lives here rather than in the caller's JSX on purpose. The demo
 * shells and every pre-auth render have no session to resolve, and the layout
 * used to express "no persona → no filtering" as a ternary that rebuilt the
 * item list twice. Passing the null through means the one module that owns nav
 * policy also owns what happens when the persona is unknown, and the call site
 * is a single expression. It is safe to be permissive here ONLY because the nav
 * is cosmetic — every page a persona must not reach carries its own
 * server-side gate.
 *
 * Generic over the item shape so it works on NavItem without this module
 * importing the nav layer.
 */
export function filterNavForPersona<T extends { href: string }>(
  items: T[],
  persona: Persona | null | undefined,
): T[] {
  if (!persona) return items;
  return items.filter((item) => personaMayVisit(persona, item.href));
}
