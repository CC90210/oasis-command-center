/**
 * ROLE SURFACES — an outside sales contractor must not be able to read the
 * company's money, its clients, or another rep's book.
 *
 * Run: node --conditions=react-server --import tsx tests/role-surfaces.test.ts
 *
 * TWO KINDS OF ASSERTION HERE, and they are doing different jobs.
 *
 * 1. THE POLICY, EXECUTED. resolvePersona / capabilitiesFor / filterNavForPersona
 *    are pure, so the whole matrix — including the fail-closed cases a live
 *    session would never produce — runs for real.
 *
 * 2. THE RENDER PATH, READ. "The sales branch never fetches the MRR" is a
 *    property of a Server Component that needs a database, a session and a
 *    Next request scope to execute. It cannot be proven by calling a function.
 *    It CAN be proven by reading the file: if components/today/RepToday.tsx does
 *    not name mrrSnapshot, mrrSnapshot cannot run on that path. Same technique
 *    as tests/portal-boundaries.test.ts and tests/clair-manual-only.test.ts.
 *
 *    A source scan that quietly matches nothing PASSES and proves nothing, so
 *    the positive controls at the bottom assert the same matcher DOES fire on
 *    the founder component. If those ever go quiet, the negative results above
 *    them are worthless and this file fails.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SALES_NAV_ALLOWLIST,
  canReadOasisSalesTeamPipeline,
  invitableRoleOptionsFor,
  invitableRoleOptionsForActor,
  roleAllowedForTenant,
  SURFACE_CAPABILITIES,
  capabilitiesFor,
  filterNavForPersona,
  isOasisSurfaceTenant,
  personaMayVisit,
  resolvePersona,
  type Persona,
} from "../lib/role-surfaces";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/* ────────────────────────── 1. persona resolution ────────────────────────── */

assert.equal(resolvePersona({ teamRole: "owner" }), "founder");
assert.equal(resolvePersona({ teamRole: "admin" }), "founder");
assert.equal(resolvePersona({ teamRole: "agent" }), "sales");
assert.equal(resolvePersona({ teamRole: "member" }), "worker");
assert.equal(resolvePersona({ teamRole: "read_only" }), "readonly");
assert.equal(resolvePersona({ teamRole: "loan_officer" }), "legacy");
assert.equal(resolvePersona({ teamRole: "processor" }), "legacy");

// Casing / whitespace must not be a bypass, in either direction: "AGENT" is
// still a rep (not an unknown role that accidentally lands somewhere else).
assert.equal(resolvePersona({ teamRole: "  AGENT " }), "sales");
assert.equal(resolvePersona({ teamRole: "Owner" }), "founder");

// The escalation flags are additive on top of the base role, exactly as
// resolveSessionContext reports them.
assert.equal(resolvePersona({ teamRole: "agent", adminAccess: true }), "founder");
assert.equal(resolvePersona({ teamRole: "member", isTrueAdmin: true }), "founder");

/* ─── FAIL CLOSED. The single most important block in this file. ─────────────
 * A null / empty / misspelled / not-yet-invented role must land on the LEAST
 * privileged persona. If any of these ever resolved to "worker" or "founder", a
 * corrupt or half-provisioned profile would be handed company data. */
for (const bad of [null, undefined, "", "   ", "AGENT_", "sales", "rep", "superuser", "Admin " + "​"]) {
  assert.equal(
    resolvePersona({ teamRole: bad as string | null | undefined }),
    "readonly",
    `unknown role ${JSON.stringify(bad)} must fail closed to readonly`,
  );
}
// ...and readonly must actually be the least privileged thing to fail to.
assert.equal(SURFACE_CAPABILITIES.readonly.canSeeCompanyFinancials, false);
assert.equal(SURFACE_CAPABILITIES.readonly.canSeeCommissionLedger, false);
assert.equal(SURFACE_CAPABILITIES.readonly.canAct, false);

/* ───── the OASIS sales job titles (2026-08-21) ──────────────────────────────
 * manager / closer / opener / builder replace the ambiguous member-vs-agent
 * pair. opener and closer share ONE persona deliberately: identical surfaces,
 * different pipeline STAGES, and stages are not this module's business. */
assert.equal(resolvePersona({ teamRole: "manager" }), "manager");
assert.equal(resolvePersona({ teamRole: "marketing" }), "marketing");
assert.equal(resolvePersona({ teamRole: " MARKETING " }), "marketing", "trim + case-fold applies here too");
assert.equal(resolvePersona({ teamRole: "closer" }), "sales");
assert.equal(resolvePersona({ teamRole: "opener" }), "sales");
assert.equal(resolvePersona({ teamRole: "builder" }), "builder", "split out of worker 2026-08-21 — see the BUILDER block below");
assert.equal(resolvePersona({ teamRole: " CLOSER " }), "sales", "trim + case-fold applies to new roles too");
assert.equal(resolvePersona({ teamRole: "Manager" }), "manager");
// The escalation toggle outranks a sales title, same as it does every other role.
assert.equal(resolvePersona({ teamRole: "closer", adminAccess: true }), "founder");
assert.equal(
  resolvePersona({ teamRole: "manager", adminAccess: true }),
  "founder",
  "the explicit owner-controlled admin toggle keeps its existing full-admin semantics",
);
assert.equal(resolvePersona({ teamRole: "manager", isTrueAdmin: true }), "founder");

/* ───── TOTALITY. Every persona has a row, and only two may see money. ────────
 * A persona added to the union without a SURFACE_CAPABILITIES entry would be
 * `undefined` at every call site — which reads as falsy, i.e. accidentally
 * locked down, until someone "fixes" it by guessing. Assert the matrix is
 * total instead of trusting Record<> to have been filled in thoughtfully. */
for (const persona of ["founder", "manager", "sales", "marketing", "builder", "worker", "readonly", "legacy"] as Persona[]) {
  assert.ok(SURFACE_CAPABILITIES[persona], `${persona} must have a capability row`);
  assert.equal(
    Object.keys(SURFACE_CAPABILITIES[persona]).length,
    Object.keys(SURFACE_CAPABILITIES.founder).length,
    `${persona} must declare EVERY capability — a missing key is silently false`,
  );
  assert.equal(
    SURFACE_CAPABILITIES[persona].canSeePersonalSettings,
    true,
    `${persona} must be able to manage their own profile and personal connections`,
  );
}
for (const persona of ["sales", "marketing", "builder", "worker", "readonly", "legacy"] as Persona[]) {
  assert.equal(
    SURFACE_CAPABILITIES[persona].canSeeTeamPerformance,
    false,
    `${persona} must not receive manager/founder team-performance data`,
  );
}
for (const persona of ["manager", "sales", "marketing", "builder", "worker", "readonly"] as Persona[]) {
  assert.equal(
    SURFACE_CAPABILITIES[persona].canSeeCompanyFinancials,
    false,
    `${persona} must never see company financials — only founder and the grandfathered legacy row may`,
  );
  assert.equal(
    SURFACE_CAPABILITIES[persona].canSeeCommissionLedger,
    false,
    `${persona} must never see the tenant-wide payout ledger`,
  );
}


/* ───────────────────── 2. the capability matrix, per persona ─────────────── */

const OASIS = "oasis-webdev"; // where the reps live
const SUNBIZ = "sun";

// The rep. Every company-money and every tenant-wide flag is off, in BOTH
// workspaces — a rep is not privileged anywhere.
for (const slug of [OASIS, SUNBIZ, null]) {
  const rep = capabilitiesFor("sales", slug);
  assert.equal(rep.canSeeCompanyFinancials, false, `rep sees no MRR on ${slug}`);
  assert.equal(rep.canSeeAllPipeline, false, `rep sees no tenant pipeline on ${slug}`);
  assert.equal(rep.canSeeCommissionLedger, false, `rep sees no other rep's pay on ${slug}`);
  assert.equal(rep.canSeeClientIdentities, false, `rep sees no client names on ${slug}`);
  assert.equal(rep.canSeeInboundTape, false, `rep sees no company mailbox on ${slug}`);
  assert.equal(rep.canSeeMarketing, false, `rep sees no founders portal on ${slug}`);
  assert.equal(rep.canSeeSystemSurfaces, false, `rep reaches no system page on ${slug}`);
  assert.equal(rep.canSeePersonalSettings, true, "every profile can manage its own connections");
  assert.equal(rep.canSeeTeamPerformance, false, "a rep cannot read team performance");
  assert.equal(rep.canSeeDeliveryQueues, false, `rep sees no delivery board on ${slug}`);
  // What a rep DOES get.
  assert.equal(rep.canSeeOwnPipelineOnly, true);
  assert.equal(rep.canSeeOwnCommissionOnly, true);
  assert.equal(rep.canAct, true);
}

// Money is gated on TENANT **and** capability, never on role alone — the
// `isOperator || …` lesson. A founder standing in a customer's workspace is not
// a founder of that customer's business.
assert.equal(capabilitiesFor("founder", OASIS).canSeeCompanyFinancials, true);
assert.equal(capabilitiesFor("founder", "oasis-ai-cc").canSeeCompanyFinancials, true);
assert.equal(capabilitiesFor("founder", SUNBIZ).canSeeCompanyFinancials, false);
assert.equal(capabilitiesFor("founder", null).canSeeCompanyFinancials, false, "unknown workspace loses the money, not the other way round");
assert.equal(capabilitiesFor("founder", "").canSeeCompanyFinancials, false);
assert.equal(capabilitiesFor("founder", SUNBIZ).canSeeMarketing, false);
// Grandfathered SunBiz roles keep their surface but not OASIS's revenue.
/* ───── the sales MANAGER. Team scope is a third thing, not "all". ───────────
 * The trap this guards: `canSeeAllPipeline: true` would have been the easy way
 * to let a manager coach a team, and it would have handed them every lead in
 * the tenant — CC's own book included. Team is its own flag for that reason. */
const mgr = capabilitiesFor("manager", OASIS);
assert.equal(mgr.canSeeAllPipeline, false, "a manager must NOT get the whole tenant's pipeline");
assert.equal(mgr.canSeeTeamPipeline, true, "a manager sees the book of the reps who roll up to them");
assert.equal(mgr.canSeeTeamCommission, true, "a manager can verify the override they are paid");
assert.equal(mgr.canSeeCommissionLedger, false, "team commission is not the company ledger");
assert.equal(mgr.canSeeCompanyFinancials, false, "a manager is a contractor, not a partner — no Net MRR");
assert.equal(mgr.canSeeInboundTape, false, "the company mailbox is not a management tool");
assert.equal(mgr.canSeeMarketing, false, "the founders portal stays founders-only");
assert.equal(mgr.canSeeSystemSurfaces, false, "/operations and /health are machinery, not management");
assert.equal(mgr.canSeePersonalSettings, true);
assert.equal(mgr.canSeeTeamPerformance, true);
assert.equal(mgr.canAct, true);
const managerWithAdminToggle = capabilitiesFor(
  resolvePersona({ teamRole: "manager", adminAccess: true }),
  OASIS,
);
assert.equal(
  managerWithAdminToggle.canSeeSystemSurfaces,
  true,
  "manager/on deliberately retains the owner-controlled full-admin toggle",
);
assert.equal(capabilitiesFor("manager", SUNBIZ).canSeeTeamPerformance, false);
assert.equal(
  canReadOasisSalesTeamPipeline({ teamRole: "manager", tenantSlug: OASIS }),
  true,
);
for (const denied of [
  { teamRole: "manager", tenantSlug: SUNBIZ },
  { teamRole: "closer", tenantSlug: OASIS },
  { teamRole: "admin", tenantSlug: OASIS },
  { teamRole: "manager", tenantSlug: null },
]) {
  assert.equal(canReadOasisSalesTeamPipeline(denied), false);
}
// A rep must not gain team scope by accident — this is the flag that separates them.
assert.equal(capabilitiesFor("sales", OASIS).canSeeTeamPipeline, false);
assert.equal(capabilitiesFor("sales", OASIS).canSeeTeamCommission, false);
// Standing in someone else's workspace does not make a manager's money appear.
assert.equal(capabilitiesFor("manager", SUNBIZ).canSeeCompanyFinancials, false);

assert.equal(capabilitiesFor("legacy", SUNBIZ).canSeeCompanyFinancials, false);
assert.equal(capabilitiesFor("legacy", SUNBIZ).canSeeSystemSurfaces, true, "loan_officer / processor keep the pages they have today");

// The internal worker: the work, not the money.
const worker = capabilitiesFor("worker", OASIS);
assert.equal(worker.canSeeCompanyFinancials, false);
assert.equal(worker.canSeeOwnCommissionOnly, false);
assert.equal(worker.canSeeCommissionLedger, false);
assert.equal(worker.canSeeDeliveryQueues, true);
assert.equal(worker.canAct, true);
// read_only is the worker surface minus the verbs, and nothing else differs.
const ro = capabilitiesFor("readonly", OASIS);
assert.equal(ro.canAct, false);
for (const key of Object.keys(worker) as Array<keyof typeof worker>) {
  if (key === "canAct") continue;
  assert.equal(ro[key], worker[key], `read_only differs from member on ${key} — it should differ only in canAct`);
}

assert.equal(isOasisSurfaceTenant("OASIS-WEBDEV"), true, "slug matching is case-insensitive");
assert.equal(isOasisSurfaceTenant("oasis-webdev-staging"), false, "no accidental prefix match");
assert.equal(isOasisSurfaceTenant(null), false);

// Every persona must be present. A persona added without a capability row would
// otherwise read as `undefined` and every `if (caps.x)` would silently allow.
for (const persona of ["founder", "sales", "worker", "readonly", "legacy"] as Persona[]) {
  assert.ok(SURFACE_CAPABILITIES[persona], `no capability row for ${persona}`);
  assert.equal(typeof capabilitiesFor(persona, OASIS).canSeeCompanyFinancials, "boolean");
}

/* ───────────────────────────── 3. nav narrowing ──────────────────────────── */

const FULL_NAV = [
  { href: "/", label: "Today" },
  { href: "/schedule", label: "Schedule" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/forms", label: "Forms" },
  { href: "/agent", label: "Agents" },
  // Real nav row (lib/nav-config.ts). Present in the fixture so the rep
  // assertion below proves a rep does NOT get it, rather than passing because
  // the fixture happened to omit it.
  { href: "/leads", label: "Leads" },
  { href: "/playbook", label: "Playbook" },
  { href: "/operations", label: "Operations" },
  { href: "/automations", label: "Automations" },
  { href: "/health", label: "Health" },
  { href: "/analytics", label: "Analytics" },
  { href: "/settings", label: "Settings" },
  { href: "/founders/marketing", label: "Marketing" },
];

const repNav = filterNavForPersona(FULL_NAV, "sales");
assert.deepEqual(
  repNav.map((n) => n.href),
  ["/", "/schedule", "/pipeline", "/playbook", "/settings"],
  "a rep gets work surfaces plus safe personal Settings",
);
// REMOVED, not disabled. Greying a tab is not removing it, and a disabled row
// still advertises the surface exists.
assert.equal(repNav.length, 5);
assert.equal(
  repNav.some((n) => "enabled" in n),
  false,
  "narrowing must drop rows, never mark them disabled",
);

// Everyone else keeps their nav untouched — this change is not a fleet-wide
// nav rewrite.
for (const persona of ["founder", "worker", "readonly", "legacy"] as Persona[]) {
  assert.deepEqual(
    filterNavForPersona(FULL_NAV, persona).map((n) => n.href),
    FULL_NAV.map((n) => n.href),
    `${persona} nav must be unchanged`,
  );
}

/* ───── the manager's sidebar ────────────────────────────────────────────────
 * The rep's rows plus read-only team performance inside safe Settings.
 * Generic /leads is absent: it cannot express the manager's assigned-rep-only
 * boundary, so /pipeline is the canonical coaching surface. */
const mgrNav = filterNavForPersona(FULL_NAV, "manager");
assert.deepEqual(
  mgrNav.map((n) => n.href),
  ["/", "/schedule", "/pipeline", "/playbook", "/settings"],
  "a manager gets the roster-scoped pipeline and safe Settings",
);
assert.equal(
  personaMayVisit("manager", "/analytics"),
  false,
  "a manager must not be offered a page that would 404 on them",
);
assert.equal(personaMayVisit("manager", "/settings"), true);
assert.equal(personaMayVisit("manager", "/operations"), false);
assert.equal(personaMayVisit("manager", "/founders/marketing"), false);
assert.equal(personaMayVisit("manager", "/leads"), false, "generic leads cannot express manager scope");
assert.equal(personaMayVisit("manager", "/leads/abc-123"), false);
assert.equal(
  personaMayVisit("sales", "/leads"),
  false,
  "a rep does NOT get the leads board — that is the manager's row, not theirs",
);

/* ───── which roles a WORKSPACE may hand out ─────────────────────────────────
 * The sales titles are a product concern; product features do not extrapolate
 * across tenants. Cosmetically the dropdown omits them elsewhere — these
 * assertions cover the server gate, which is what stops a hand-rolled POST. */
for (const oasisSlug of [OASIS, "oasis-ai-cc", "oasis"]) {
  const values = invitableRoleOptionsFor(oasisSlug).map((o) => o.value);
  assert.ok(values.includes("closer"), `${oasisSlug} may hand out sales roles`);
  assert.ok(values.includes("manager"));
  assert.equal(roleAllowedForTenant("builder", oasisSlug), true);
}
for (const foreign of [SUNBIZ, "submissions", "someone-elses-tenant"]) {
  const values = invitableRoleOptionsFor(foreign).map((o) => o.value);
  assert.equal(values.includes("closer"), false, `${foreign} must not be offered OASIS sales roles`);
  assert.equal(roleAllowedForTenant("closer", foreign), false);
  assert.equal(roleAllowedForTenant("manager", foreign), false);
  assert.ok(values.includes("admin"), `${foreign} keeps the platform roles`);
}
// Fail closed: an unresolved workspace does not get the product's roles.
for (const unknown of [null, undefined, ""]) {
  assert.equal(
    roleAllowedForTenant("closer", unknown),
    false,
    "an unknown workspace must not be able to mint a sales role",
  );
}
assert.equal(
  invitableRoleOptionsForActor(OASIS, false).some((option) => option.value === "admin"),
  false,
  "a temporary admin grant must not be offered a permanent Administrator invite",
);
assert.equal(
  invitableRoleOptionsForActor(OASIS, true).some((option) => option.value === "admin"),
  true,
  "a permanent admin keeps the Administrator option",
);
assert.equal(
  invitableRoleOptionsForActor(OASIS, false).some((option) => option.value === "agent"),
  false,
  "legacy Agent is never offered by either invite surface",
);
// owner is never invitable anywhere, by any path.
for (const slug of [OASIS, SUNBIZ, null]) {
  assert.equal(roleAllowedForTenant("owner", slug), false, "owner is never invitable");
}

// No persona identified (demo shells, pre-auth renders) → do not narrow. This
// is safe ONLY because the nav is cosmetic and every restricted page gates
// itself server-side; asserted here so the permissive default stays a conscious
// choice rather than something a refactor introduces by accident.
for (const nothing of [null, undefined]) {
  assert.deepEqual(
    filterNavForPersona(FULL_NAV, nothing).map((n) => n.href),
    FULL_NAV.map((n) => n.href),
    "an unresolved persona must not narrow the sidebar",
  );
}

// Prefix matching happens on a URL boundary.
assert.equal(personaMayVisit("sales", "/playbook/script"), true, "the rep call guide is reachable");
assert.equal(personaMayVisit("sales", "/pipeline/abc-123"), true, "a rep can open their own lead");
assert.equal(personaMayVisit("sales", "/playbooks-internal"), false, "a shared prefix is not a match");
assert.equal(personaMayVisit("sales", "/analytics"), false);
assert.equal(personaMayVisit("sales", "/founders/marketing"), false);
assert.equal(personaMayVisit("sales", "/"), true);
assert.equal(personaMayVisit("sales", "/settings"), true);
assert.ok(SALES_NAV_ALLOWLIST.includes("/"), "Today is on the allowlist");

/* ───────── 4. the sales render path never ASKS for company financials ────── */

/**
 * The readers that produce company-level money and cross-tenant data. If a name
 * here appears in a file on the rep's render path, that query can run for a rep
 * — whether or not the result is displayed. A fetched-then-hidden number still
 * ships inside the RSC payload.
 */
const FINANCIAL_READERS = [
  "mrrSnapshot",
  "mrrHistory",
  "topClientConcentration",
  "pipelineBreakdown",
  "priorityInbound",
  "outreachReplyRate",
  "activePipeline",
  "momentumMetrics",
  "MRRProgressChart",
  "GoalCountdownCard",
];

/**
 * Match CODE, not prose.
 *
 * The first version of this scan failed on RepToday.tsx because its header
 * comment NAMES the readers it deliberately does not import — "mrrSnapshot,
 * mrrHistory, topClientConcentration ... are not imported by this file at all".
 * That comment is the most useful sentence in the file and deleting it to
 * satisfy a regex would be the tail wagging the dog. Same call
 * tests/portal-boundaries.test.ts makes about lib/manifest/data.ts.
 *
 * Deliberately crude: it also blanks comment-looking text inside string
 * literals. The `[^:]` guard keeps `https://` intact, and nothing that survives
 * a strip could have been a live call anyway.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const repToday = read("components/today/RepToday.tsx");
const deliveryToday = read("components/today/DeliveryToday.tsx");
const dispatcher = read("app/page.tsx");
const founderToday = read("components/today/FounderToday.tsx");

const repCode = stripComments(repToday);
const deliveryCode = stripComments(deliveryToday);
const dispatcherCode = stripComments(dispatcher);
const founderCode = stripComments(founderToday);

/* ───── the MANAGER surface ──────────────────────────────────────────────────
 * A persona without its own branch in app/page.tsx falls through to
 * FounderToday. `manager` shipped without one, and although the money was safe
 * (showFinancials is false for that persona), FounderToday consults no other
 * capability — so it would have rendered the whole tenant's pipeline and the
 * company inbound tape to someone whose record denies both.
 *
 * These assertions exist so that cannot recur silently for the NEXT persona. */
/* ───── the MARKETING surface ───────────────────────────────────────────────
 * Marketing exists to make ONE thing possible: reaching /founders/marketing
 * WITHOUT being an admin. Before it, canSeeMarketing was true for `founder`
 * alone, so hiring a marketing person meant handing over Net MRR, the
 * commission ledger and every client name — or hiring them and locking them out
 * of the job. These assertions keep both halves true. */
const marketingToday = read("components/today/MarketingToday.tsx");
const marketingCode = stripComments(marketingToday);

assert.equal(
  capabilitiesFor("marketing", OASIS).canSeeMarketing,
  true,
  "the entire point of the role: marketing reaches the marketing studio",
);
assert.equal(
  capabilitiesFor("marketing", OASIS).canSeeCompanyFinancials,
  false,
  "and does so WITHOUT company revenue — that pairing is the whole reason the role exists",
);
assert.equal(capabilitiesFor("marketing", OASIS).canSeeAllPipeline, false, "marketing does not work leads");
assert.equal(capabilitiesFor("marketing", OASIS).canSeeCommissionLedger, false);
assert.equal(capabilitiesFor("marketing", OASIS).canSeeInboundTape, false);
assert.equal(
  capabilitiesFor("marketing", SUNBIZ).canSeeMarketing,
  false,
  "OASIS content is OASIS's — the tenant gate applies to marketing like everything else",
);
assert.ok(
  /surface\.persona === "marketing"/.test(dispatcherCode),
  "app/page.tsx MUST branch on marketing — without it they fall through to FounderToday",
);
assert.ok(
  dispatcherCode.indexOf('surface.persona === "marketing"') < dispatcherCode.indexOf("<FounderToday"),
  "the marketing branch must precede the FounderToday fallthrough or it never runs",
);
for (const reader of FINANCIAL_READERS) {
  assert.equal(
    marketingCode.includes(reader),
    false,
    `MarketingToday must not reach ${reader}`,
  );
}
assert.equal(
  /getServiceSupabase|listRecords/.test(marketingCode),
  false,
  "MarketingToday reads NOTHING from the database — it routes to tools that already exist, " +
    "so there is no second copy of the marketing surface to keep true",
);
assert.deepEqual(
  filterNavForPersona(FULL_NAV, "marketing").map((n) => n.href),
  ["/", "/schedule", "/pipeline", "/playbook", "/settings", "/founders/marketing"],
  "marketing nav includes the rep's own pipeline without exposing the tenant-wide book",
);
assert.equal(
  personaMayVisit("marketing", "/pipeline"),
  true,
  "marketing can work leads assigned to them; the API still enforces exact self scope",
);
assert.equal(personaMayVisit("marketing", "/leads"), false);
assert.equal(personaMayVisit("marketing", "/analytics"), false, "system surfaces stay closed");

/* ───── the Leads browser is open to reps, and the rep filter is admin-only ──
 * CC, 2026-08-21: "those sales reps should be able to access the leads page so
 * they can import leads themselves."
 *
 * /web-leads is the prospecting POOL — a public directory of Canadian
 * businesses with website status — not another rep's book. Nothing in it is
 * assigned to anyone, so opening it exposes no colleague's pipeline. It is what
 * makes SELF-SOURCING possible, which is the track that pays 25/40/70 instead
 * of 20/30. */
assert.equal(personaMayVisit("sales", "/web-leads"), true, "a rep can source their own leads");
assert.equal(personaMayVisit("manager", "/web-leads"), true, "so can a manager, to assign from");
assert.equal(
  personaMayVisit("marketing", "/web-leads"),
  false,
  "marketing does not prospect — the pool stays out of their nav",
);

const pipelinePage = read("app/pipeline/page.tsx");
const pipelineCode = stripComments(pipelinePage);

/* THE ORDERING IS THE SECURITY PROPERTY. The rep chips filter `scopedRows`,
 * which filterWebsiteSalesRows has ALREADY narrowed to what this viewer may
 * see. So a rep who hand-types ?rep=<someone-else> filters a set that never
 * contained that person's leads — the control can only subtract. If the filter
 * were ever applied to the raw rows instead, it would become a way to look
 * sideways at a colleague's book. */
assert.ok(
  /managerTeamRead =\s*session\.ok &&\s*canReadOasisSalesTeamPipeline/.test(pipelineCode) &&
    /teamRepUserIds: \[\.\.\.managerRepRoster\.keys\(\)\]/.test(pipelineCode) &&
    /assignedToAny: assigneeScope\.allowed \? assigneeScope\.assignedToAny : undefined/.test(pipelineCode),
  "manager pipeline reads must pass through the OASIS tenant gate, the sales-role roster, " +
    "and the database query scope; a forged ?rep must never select an arbitrary tenant id",
);
assert.ok(
  /repRoster\.size > 0 &&/.test(pipelineCode),
  'the rep chips must actually RENDER. A first pass wired the filter logic and the chip ' +
    'builder but never placed the row, so the control existed only as unused code — eslint ' +
    'caught it, not the tests.',
);
assert.ok(
  /pipelineAdmin\s*\?\s*await buildMemberNameMap\(tenantId\)\s*:\s*managerRepRoster/.test(pipelineCode),
  "admins get the full member filter while managers get only the sales-rep roster",
);

/* ───── the leadgen fields must be on the OASIS lead entity ─────────────────
 * The OSM importer writes website / website_condition / industry on every lead
 * it creates. ManifestRecordForm renders the ENTITY, not the row, so a field
 * missing here is invisible on the profile no matter what the database holds —
 * which is why a rep could not see https://www.mangorain.ca/ on a lead that
 * stored exactly that. */
const seeds = read("lib/manifest/seeds.ts");
const oasisLeadEntity = seeds.slice(
  seeds.indexOf('name: "lead"'),
  seeds.indexOf('name: "lead"') + 2400,
);
for (const field of ["website", "website_condition", "industry"]) {
  assert.ok(
    new RegExp(`name: "${field}"`).test(oasisLeadEntity),
    `the OASIS lead entity must expose ${field} — the importer writes it and the profile ` +
      `cannot render what the entity does not declare`,
  );
}

/* ───── the BUILDER, split out of worker after a REAL exposure ──────────────
 * 2026-08-21: a builder was invited, logged in, and could see the whole tenant
 * pipeline and every system surface — because `builder` resolved to the legacy
 * `worker` persona, which carries canSeeSystemSurfaces: true. `worker` was
 * written for INTERNAL staff on `member` (43 live profiles, mostly SunBiz), so
 * it was split rather than narrowed in place. */
assert.equal(resolvePersona({ teamRole: "builder" }), "builder", "builder has its OWN persona now");
assert.equal(
  resolvePersona({ teamRole: "member" }),
  "worker",
  "and member is untouched — 43 live profiles depend on that row",
);
assert.equal(
  capabilitiesFor("builder", OASIS).canSeeSystemSurfaces,
  false,
  "/automations runs background workers and drip sends on CC's own machine. A delivery " +
    "contractor toggling those is an outage, not a permissions nicety.",
);
assert.equal(
  capabilitiesFor("builder", OASIS).canSeeAllPipeline,
  false,
  "a builder builds what was sold — they do not need the whole prospect book",
);
assert.equal(capabilitiesFor("builder", OASIS).canSeeCompanyFinancials, false);
assert.equal(capabilitiesFor("builder", OASIS).canSeeDeliveryQueues, true, "their actual work");
assert.equal(
  capabilitiesFor("builder", OASIS).canSeeMarketing,
  true,
  "CC 2026-08-21: this hire is a builder AND a marketing specialist",
);
// CC, 2026-08-25: he also sells. Own book only — "all" stays false.
assert.equal(
  capabilitiesFor("builder", OASIS).canSeeOwnPipelineOnly,
  true,
  "the selling builder sees his OWN claimed deals",
);
assert.equal(
  capabilitiesFor("builder", OASIS).canSeeAllPipeline,
  false,
  "selling did not widen him to the tenant's book",
);
assert.equal(personaMayVisit("builder", "/pipeline"), true, "his own pipeline is his tool");
assert.equal(
  personaMayVisit("builder", "/web-leads"),
  true,
  "CC 2026-08-25: he sources from the same prospecting pool the reps claim from",
);
assert.equal(
  capabilitiesFor("builder", OASIS).canSeeMarketing,
  true,
  "CC 2026-08-21: this hire is a builder AND a marketing specialist",
);
assert.equal(personaMayVisit("builder", "/automations"), false, "never the automation controls");
assert.equal(personaMayVisit("builder", "/operations"), false, "never the internal ops surface");
assert.equal(personaMayVisit("builder", "/settings"), true);
assert.equal(personaMayVisit("builder", "/founders/marketing"), true);
assert.ok(
  /viewerUserId=\{surface\.userId\}/.test(dispatcherCode),
  "the Today dispatcher must pass the authenticated user id into the delivery queue",
);
assert.ok(
  /resolveOasisDeliveryQueueScope\(teamRole, viewerUserId\)/.test(deliveryCode),
  "DeliveryToday must resolve a builder-only ownership scope before it reads any stage",
);
assert.ok(
  /where:\s*\{\s*stage,\s*assigned_to:\s*scope\.userId\s*\}/.test(deliveryCode) &&
    /where:\s*\{\s*stage,\s*fulfillment_owner_id:\s*scope\.userId\s*\}/.test(deliveryCode),
  "a builder queue must be narrowed in Turso by assigned_to OR fulfillment_owner_id; " +
    "filtering a tenant-wide result in memory still leaks every client into the server payload",
);

/* The board must not render the raw prospect pool as pipeline work. */
assert.ok(
  /\.filter\(\(stage\) => stage\.key !== "researched"\)/.test(pipelineCode) &&
    /stageKeys: assigneeScope\.allowed \? stages\.map/.test(pipelineCode),
  "the pipeline must exclude the researched stage — those are un-worked directory rows, " +
    "not deals, and /web-leads reads the very same rows so they must be HIDDEN, never deleted",
);

/* ───── the FOUNDERS GATE must follow the capability, not a persona name ─────
 * 2026-08-21: schneur@oasisai.work was given the marketing studio via
 * canSeeMarketing and STILL got "page not found", because
 * lib/founders/gate.ts additionally required `persona === "founder"`. Two
 * gates, and widening only one of them changes nothing.
 *
 * The gate now reads SURFACE_CAPABILITIES[persona].canSeeMarketing, so this
 * table IS the founders-portal access list. That makes the next assertion the
 * important one: the gate exists to keep outside commission-only contractors
 * out, and it still does. */
const gateSource = read("lib/founders/gate.ts");
assert.equal(
  /persona !== "founder"/.test(stripComments(gateSource)),
  false,
  "the founders gate must not hardcode a persona name — a marketing hire whose entire job " +
    "is that portal was 404'd by exactly that line",
);
assert.ok(
  /SURFACE_CAPABILITIES\[persona\]\.canSeeMarketing/.test(gateSource),
  "the gate must key on the capability, so one table decides portal access",
);
for (const allowed of ["founder", "marketing", "builder"] as Persona[]) {
  assert.equal(
    SURFACE_CAPABILITIES[allowed].canSeeMarketing,
    true,
    `${allowed} must reach the founders marketing portal`,
  );
}
for (const refused of ["sales", "manager", "readonly", "worker"] as Persona[]) {
  assert.equal(
    SURFACE_CAPABILITIES[refused].canSeeMarketing,
    false,
    `${refused} must NOT reach the founders portal — this gate was written to keep outside ` +
      `commission-only contractors out of it, and that has to survive the widening`,
  );
}

const managerToday = read("components/today/ManagerToday.tsx");
const managerCode = stripComments(managerToday);
const salesPerformance = stripComments(read("lib/audit/sales-performance.ts"));
const teamPolicy = stripComments(read("lib/team.ts"));

assert.ok(
  /surface\.persona === "manager"/.test(dispatcherCode),
  "app/page.tsx MUST branch on the manager persona — without it a manager falls through to FounderToday",
);
assert.ok(
  dispatcherCode.indexOf('surface.persona === "manager"') < dispatcherCode.indexOf("<FounderToday"),
  "the manager branch must come BEFORE the FounderToday fallthrough, or it never runs",
);
for (const reader of FINANCIAL_READERS) {
  assert.equal(
    managerCode.includes(reader),
    false,
    `ManagerToday must not reach ${reader} — a manager is a commission contractor, not a partner in the business`,
  );
}
assert.ok(
  managerCode.includes("getOasisSalesRepRoster(tenantId)") &&
    salesPerformance.includes("getOasisSalesRepRoster(tenantId)"),
  "ManagerToday must use the canonical OASIS sales roster",
);
assert.ok(
  teamPolicy.includes('.eq("tenant_id", tenantId)') &&
    teamPolicy.includes("canonicalizeTenantMembers((data || []) as MemberRow[]).filter") &&
    teamPolicy.includes("isOasisPipelineRepRole(member.team_role)"),
  "the canonical roster must canonicalize the full tenant before applying the sales-role allowlist",
);
assert.equal(
  teamPolicy.includes('.in("team_role", [...OASIS_PIPELINE_REP_ROLES])'),
  false,
  "a query-level role filter can retain a stale sales duplicate after hiding its owner/admin row",
);
assert.ok(
  managerCode.includes('.in("rep_user_id"'),
  "team commission must be scoped to the roster, not fetched tenant-wide and filtered in memory",
);
assert.ok(
  /repIds\.length === 0/.test(managerCode),
  "an empty roster must short-circuit the query: an empty `in` list is how 'no reps' becomes 'every row'",
);
assert.ok(
  /ok:\s*false/.test(managerCode) && /not \$0|couldn't load/i.test(managerToday),
  "a failed read must render as 'couldn't load', never as $0 — a manager acting on a fake zero " +
    "will confront a rep about money that was never missing",
);

for (const reader of FINANCIAL_READERS) {
  assert.equal(
    repCode.includes(reader),
    false,
    `components/today/RepToday.tsx names ${reader} in CODE — a rep's Today must not be able to run it`,
  );
  assert.equal(
    deliveryCode.includes(reader),
    false,
    `components/today/DeliveryToday.tsx names ${reader} in CODE — the delivery surface carries no company money`,
  );
  assert.equal(
    dispatcherCode.includes(reader),
    false,
    `app/page.tsx names ${reader} in CODE — the dispatcher runs before the persona branch, so anything it fetches is fetched for EVERY persona`,
  );
}

// The rep page must not name the commission table without the own-rows predicate.
assert.ok(
  repCode.includes('.eq("rep_user_id"'),
  "RepToday must scope commissions to the viewing rep",
);
assert.equal(
  repCode.includes("canSeeCommissionLedger"),
  false,
  "RepToday must not consult the all-reps ledger capability at all",
);
// Lead scoping: narrowed in the QUERY, then narrowed again by the shared policy
// with the admin flags forced off.
assert.ok(repCode.includes("where: { assigned_to:"), "the rep's queue is scoped in the query, not in memory");
assert.ok(repCode.includes("filterWebsiteSalesRows"), "the rep's queue reuses the shared program/stage policy");
assert.ok(
  /isOwner:\s*false/.test(repCode) && /adminAccess:\s*false/.test(repCode),
  "the rep's queue must force the non-admin path rather than passing session flags through",
);

// The dispatcher must branch to the rep component BEFORE it can reach the
// founder one. Order is the enforcement.
const salesBranch = dispatcherCode.indexOf('persona === "sales"');
assert.ok(salesBranch > -1, "app/page.tsx has no sales branch");
assert.ok(dispatcherCode.includes("<FounderToday"), "app/page.tsx never renders FounderToday");
assert.ok(
  salesBranch < dispatcherCode.lastIndexOf("<FounderToday"),
  "the sales branch must return before the founder dashboard is reachable",
);

/**
 * AN UNAUTHORISED SESSION GETS NO TENANT DATA AT ALL.
 *
 * Regression lock on a bug this file did not originally catch. The `!surface.ok`
 * branch used to render FounderToday with showFinancials={false} — which
 * suppresses the MRR but NOT priorityInbound (the company mailbox), topOpenLead
 * (a named lead and their phone) or pipelineBreakdown. Failing closed on one
 * class of data while serving another is not failing closed.
 *
 * The financial-reader scan above could never have caught it: those readers live
 * in FounderToday, and the scan only checks that the DISPATCHER does not name
 * them. What matters here is which component the unauthorised branch reaches.
 */
{
  const guard = dispatcherCode.indexOf("if (!surface.ok)");
  assert.ok(guard > -1, "app/page.tsx must handle an unresolvable session explicitly");
  const nextReturn = dispatcherCode.indexOf("if (surface.persona", guard);
  assert.ok(nextReturn > guard, "could not delimit the unauthorised branch — this assertion is not proving anything");
  const branch = dispatcherCode.slice(guard, nextReturn);
  // Positive control: prove the slice actually captured the branch BODY. Without
  // this, a refactor that moved the guard could leave `branch` near-empty and
  // every "does not contain" assertion below would pass while proving nothing.
  assert.ok(
    branch.includes("Session not verified"),
    "the unauthorised branch slice did not capture the rendered screen — the assertions below would be vacuous",
  );
  for (const leak of ["FounderToday", "DeliveryToday", "RepToday", "surface.tenantId", "profile={profile}"]) {
    assert.equal(
      branch.includes(leak),
      false,
      `the unauthorised-session branch reaches ${leak} — a session we cannot authorise must trigger no tenant read whatsoever`,
    );
  }
}

/* ── POSITIVE CONTROLS. Without these the block above could pass by scanning
 *    empty strings, and a green result would mean nothing. ─────────────────── */
assert.ok(founderToday.length > 2000, "FounderToday.tsx did not load — the scan above proves nothing");
assert.ok(repToday.length > 2000, "RepToday.tsx did not load — the scan above proves nothing");
assert.ok(deliveryToday.length > 1000, "DeliveryToday.tsx did not load — the scan above proves nothing");
for (const reader of ["mrrSnapshot", "mrrHistory", "topClientConcentration", "MRRProgressChart", "GoalCountdownCard"]) {
  assert.ok(
    founderCode.includes(reader),
    `the founder dashboard no longer names ${reader}. Either the money moved, or this matcher is broken — ` +
      `and if it is broken then every "the rep cannot see it" assertion above is vacuous.`,
  );
}

/* ─────────────── 5. every page a rep must not reach is gated ─────────────── */

const GATED_PAGES = [
  "app/analytics/page.tsx",
  "app/operations/page.tsx",
  "app/automations/page.tsx",
  "app/health/page.tsx",
  "app/agents/page.tsx",
];
for (const page of GATED_PAGES) {
  const src = read(page);
  assert.ok(
    src.includes("requireSystemSurface"),
    `${page} has no server-side persona gate. Removing it from the sidebar is cosmetic — the URL still resolves.`,
  );
  assert.ok(
    /await requireSystemSurface\(\);/.test(src),
    `${page} must AWAIT the gate; a floating promise gates nothing`,
  );
}

const settingsPage = read("app/settings/page.tsx");
assert.ok(
  settingsPage.includes("resolveViewerSurface") &&
    settingsPage.includes("surface.capabilities.canSeePersonalSettings") &&
    /if \(!surface\.ok \|\| !surface\.capabilities\.canSeePersonalSettings\) notFound\(\)/.test(settingsPage),
  "Settings must carry its own personal-settings server gate now that every profile can reach it",
);
assert.ok(
  settingsPage.includes("canSeeTeamPerformance: surface.capabilities.canSeeTeamPerformance") &&
    settingsPage.includes("canSeeSystemSurfaces: surface.capabilities.canSeeSystemSurfaces"),
  "Settings must pass narrow capabilities downstream instead of treating reachability as admin access",
);

// The founders portal: tenant identity is necessary and no longer sufficient,
// because reps share OASIS's own workspace.
const foundersGate = read("lib/founders/gate.ts");
assert.ok(foundersGate.includes("resolvePersona"), "the founders gate must also check persona — reps are on the founders' own tenant");
assert.ok(
  /persona !== "founder"/.test(foundersGate),
  "the founders gate must refuse every non-founder persona explicitly",
);
assert.ok(
  foundersGate.indexOf("isFounderTenant") < foundersGate.indexOf("resolvePersona"),
  "tenant check first, then persona — both, in that order",
);
// The page still 404s (not 403s) off a null gate result.
const marketingPage = read("app/founders/marketing/page.tsx");
assert.ok(
  marketingPage.includes("if (!founder) notFound()"),
  "the founders marketing page must 404 on a refused gate, never 403",
);

// The gate module itself must stay usable server-side only; the policy must not.
assert.equal(
  read("lib/role-surfaces.ts").includes('from "next/'),
  false,
  "lib/role-surfaces.ts must stay pure — no next/* import — so this test can run it at all",
);

console.log(
  // Computed, not hand-counted: this line read "5 personas" for a while after
  // the sixth was added, which is the smallest possible version of a summary
  // that lies about what it checked.
  `role-surfaces: OK — ${Object.keys(SURFACE_CAPABILITIES).length} personas, ` +
    `${Object.keys(SURFACE_CAPABILITIES.sales).length} capabilities, ` +
    `${FINANCIAL_READERS.length} financial readers proven absent from the rep path, ` +
    `${GATED_PAGES.length} pages gated + the founders portal`,
);
