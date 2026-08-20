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
  ["/", "/schedule", "/pipeline", "/playbook"],
  "a rep's sidebar is Today, Schedule, Pipeline, Playbook — and nothing else",
);
// REMOVED, not disabled. Greying a tab is not removing it, and a disabled row
// still advertises the surface exists.
assert.equal(repNav.length, 4);
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
assert.equal(personaMayVisit("sales", "/settings"), false);
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
  "app/settings/page.tsx",
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
  `role-surfaces: OK — 5 personas, ${Object.keys(SURFACE_CAPABILITIES.sales).length} capabilities, ` +
    `${FINANCIAL_READERS.length} financial readers proven absent from the rep path, ` +
    `${GATED_PAGES.length} pages gated + the founders portal`,
);
