/**
 * OASIS OS department tabs (/team/<dept>) and the AI Team (/agents).
 *
 * WHY THIS EXISTS. A department tab reads a department's real numbers and
 * opens a channel to an AI teammate. The failures that matter are all
 * invisible until someone screenshots them:
 *   - Finance (OASIS's company money — fin_* is not tenant-scoped) opening for
 *     a rep, a manager, a SunBiz legacy role, or an owner of a CLIENT workspace;
 *   - an unknown department answering with anything but the same 404;
 *   - a client workspace's channel talking to Bravo / Maven / Atlas, or its
 *     tab carrying OASIS copy, because a binding fell back to OASIS's agents;
 *   - the page reading data before it decides whether the viewer may see it.
 * So the gate is run adversarially (every flag a caller could get wrong, set
 * wrong), the client-workspace output is scanned for OASIS strings, and the
 * page sources are checked for gate-before-read.
 *
 * Run: node --conditions=react-server --import tsx tests/os-departments.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { departmentGate } from "../components/os/department/gate";
import {
  NEUTRAL_BOUND_SLUGS,
  OASIS_ASK_REFERENCES,
  OASIS_BOUND_SLUGS,
  departmentChannelFor,
  departmentProfile,
  suggestedAsksFor,
} from "../components/os/department/config";
import { tileCount } from "../components/os/department/count-rules";
import { statusFor } from "../components/os/department/StatusPill";
import {
  describeSchedule,
  failedWithin,
  lastRunLabel,
  normalizeRoutineRow,
  routinesForDepartment,
  type RoutineRow,
} from "../components/os/department/routine-rules";
import { TEAMMATE_TEMPLATES } from "../components/os/aiteam/templates";
import { OS_DEPARTMENTS } from "../lib/os/departments";
import { ALL_MODULES, resolveOsModules } from "../lib/os/modules";
import type { BuildOsNavInput } from "../lib/os/nav";
import { CATEGORY_LABELS, getSeedAgent } from "../lib/agents/library";
import { QUICK_ACTIONS } from "../lib/quick-actions";
import { SURFACE_CAPABILITIES, capabilitiesFor, type Persona } from "../lib/role-surfaces";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const PERSONAS: Persona[] = ["founder", "manager", "sales", "marketing", "builder", "worker", "readonly", "legacy"];
const OASIS = "oasis-ai-cc";
const CLIENT = "northwind-renovations";

/** The input app/layout.tsx and components/os/department/viewer.ts build. */
function viewer(persona: Persona | null, slug: string, over: Partial<BuildOsNavInput> = {}): BuildOsNavInput {
  const oasis = slug === OASIS || slug === "oasis-webdev";
  return {
    persona,
    capabilities: persona ? capabilitiesFor(persona, slug) : null,
    isOperator: false,
    tenantSlug: slug,
    isOasisTenant: oasis,
    modules: resolveOsModules({ tenantSlug: slug, provisioned: true }),
    provisioned: true,
    founders: null,
    ...over,
  };
}

const opens = (slug: string, input: BuildOsNavInput) => departmentGate(slug, input) !== null;

// ── 1. Unknown departments 404 the same way a forbidden one does ──────────
{
  for (const slug of ["legal", "content", "research", "nope", "", "team", "chief_of_staff", "../finance", "finance/", " sales x"]) {
    assert.equal(departmentGate(slug, viewer("founder", OASIS)), null, `"${slug}" must not resolve`);
  }
  assert.equal(departmentGate(null, viewer("founder", OASIS)), null);
  assert.equal(departmentGate(undefined, viewer("founder", OASIS)), null);
  // Case-insensitive, like the rail's own lookup — "Sales" is the same tab.
  assert.ok(opens("Sales", viewer("founder", OASIS)));
}

// ── 2. Finance: module finance + an owner + OASIS's company money ─────────
{
  assert.ok(opens("finance", viewer("founder", OASIS)), "an OASIS owner opens Finance");
  for (const persona of PERSONAS.filter((p) => p !== "founder")) {
    assert.ok(!opens("finance", viewer(persona, OASIS)), `${persona} in OASIS must 404 on Finance`);
    // Even when the caller hands them every module and a lying OASIS flag.
    assert.ok(
      !opens("finance", viewer(persona, OASIS, { modules: ALL_MODULES, isOperator: true, founders: { content: true, finances: true } })),
      `${persona} must 404 on Finance whatever else is switched on`,
    );
  }
  // The grandfathered SunBiz role carries the founder money flag; Money is an
  // owner's mode, not a loan officer's.
  assert.ok(SURFACE_CAPABILITIES.legacy.canSeeCompanyFinancials, "fixture: legacy really holds the money flag");
  assert.ok(!opens("finance", viewer("legacy", OASIS)));
  // No finance module → no Finance, even for an OASIS owner.
  assert.ok(!opens("finance", viewer("founder", OASIS, { modules: [] })));
  // A CLIENT owner never reads OASIS's ledger: wrong slug, even with every
  // module on, the OASIS flag lied to true, and capabilities forged open.
  for (const forged of [
    viewer("founder", CLIENT),
    viewer("founder", CLIENT, { modules: ALL_MODULES }),
    viewer("founder", CLIENT, { modules: ALL_MODULES, isOasisTenant: true }),
    viewer("founder", CLIENT, {
      modules: ALL_MODULES,
      isOasisTenant: true,
      capabilities: { ...SURFACE_CAPABILITIES.founder, canSeeCompanyFinancials: true },
    }),
  ]) {
    assert.ok(!opens("finance", forged), "a client workspace owner must 404 on Finance");
  }
  // Unresolved viewer, unprovisioned workspace: nothing but Today anywhere.
  for (const dept of OS_DEPARTMENTS) {
    assert.ok(!opens(dept.slug, viewer(null, OASIS)), `${dept.slug}: an unresolved persona opens nothing`);
    assert.ok(!opens(dept.slug, viewer("founder", OASIS, { provisioned: false })), `${dept.slug}: unprovisioned opens nothing`);
  }
}

// ── 3. The other gates follow the rail ────────────────────────────────────
{
  // Operations: owners/admins.
  assert.ok(opens("operations", viewer("founder", OASIS)));
  assert.ok(opens("operations", viewer("founder", CLIENT)));
  for (const persona of PERSONAS.filter((p) => p !== "founder")) {
    assert.ok(!opens("operations", viewer(persona, OASIS)), `${persona} must 404 on Operations`);
  }
  // Client Success: delivery data is founder-only inside OASIS
  // (lib/delivery/access.ts); a client workspace's members see their own.
  assert.ok(opens("client-success", viewer("founder", OASIS)));
  for (const persona of ["manager", "sales", "marketing", "builder", "worker"] as Persona[]) {
    assert.ok(!opens("client-success", viewer(persona, OASIS)), `${persona} in OASIS must 404 on Client Success`);
  }
  assert.ok(opens("client-success", viewer("worker", CLIENT)));
  // Reps keep their two departments; marketing keeps its own.
  assert.ok(opens("sales", viewer("sales", OASIS)) && opens("chief-of-staff", viewer("sales", OASIS)));
  assert.ok(!opens("marketing", viewer("sales", OASIS)));
  assert.ok(opens("marketing", viewer("marketing", OASIS)));
}

// ── 4. The page builds the rail's input with operator/founders closed ─────
// components/os/department/viewer.ts passes isOperator:false and founders:null.
// That is only correct while no department uses an audience those inputs feed.
{
  const safe = new Set(["everyone", "delivery", "company_financials", "manage"]);
  for (const d of OS_DEPARTMENTS) {
    assert.ok(safe.has(d.audience), `${d.slug} uses audience "${d.audience}", which the department viewer passes closed`);
  }
  const viewerSrc = read("components/os/department/viewer.ts");
  assert.match(viewerSrc, /isOperator: false/);
  assert.match(viewerSrc, /founders: null/);
  // One builder (navInputFor) serves the session viewer and the member lookup an agent tool uses.
  assert.match(viewerSrc, /resolveOsModules\(\{ tenantSlug, provisioned \}\)/, "modules come from the same resolver as the rail");
  assert.match(viewerSrc, /navInput: navInputFor\(surface\.persona, surface\.capabilities, surface\.tenantSlug, provisioned\)/);
}

// ── 5. A client workspace never meets OASIS's agents or copy ──────────────
{
  const OASIS_STRINGS = /\b(bravo|maven|atlas|aura|hermes|solara|helios|lex|oasis|cc)\b/i;
  for (const d of OS_DEPARTMENTS) {
    const channel = departmentChannelFor(d.key, { oasis: false });
    const out = JSON.stringify({ channel, asks: suggestedAsksFor(d.key, { oasis: false }), profile: departmentProfile(d.key) });
    assert.ok(!OASIS_STRINGS.test(out), `${d.slug}: client-workspace tab carries an OASIS string: ${out.match(OASIS_STRINGS)?.[0]}`);
    if (channel.kind === "agent") {
      // The prompt that actually reaches the model is the library seed's.
      const seed = getSeedAgent(channel.agentSlug);
      assert.ok(seed, `${d.slug}: neutral agent "${channel.agentSlug}" is not a library seed, so the chat would 404`);
      const prompt = JSON.stringify({ name: seed!.name, base: seed!.base_prompt, short: seed!.short_description, desc: seed!.description });
      assert.ok(!OASIS_STRINGS.test(prompt), `${d.slug}: neutral agent "${channel.agentSlug}" prompt names OASIS or a persona`);
      assert.ok(seed!.is_public, `${d.slug}: a neutral agent must be public or the chat refuses it`);
    }
  }
  for (const slug of NEUTRAL_BOUND_SLUGS) {
    assert.ok(!["bravo", "maven", "atlas", "aura", "hermes", "solara", "helios", "lex"].includes(slug), `${slug} is an OASIS persona`);
  }
  // Departments with no neutral agent say so; they do not borrow OASIS's.
  assert.equal(departmentChannelFor("chief_of_staff", { oasis: false }).kind, "unavailable");
  assert.equal(departmentChannelFor("marketing", { oasis: false }).kind, "unavailable");
  assert.equal(departmentChannelFor("sales", { oasis: false }).kind, "agent");
  assert.equal(departmentChannelFor("client_success", { oasis: false }).kind, "agent");
}

// ── 6. OASIS binds its own agents, and every one resolves ─────────────────
{
  const bound = (k: Parameters<typeof departmentChannelFor>[0]) => {
    const c = departmentChannelFor(k, { oasis: true });
    return c.kind === "agent" ? c.agentSlug : null;
  };
  assert.equal(bound("chief_of_staff"), "bravo");
  assert.equal(bound("marketing"), "maven");
  assert.equal(bound("finance"), "atlas");
  for (const slug of OASIS_BOUND_SLUGS) {
    assert.ok(getSeedAgent(slug)?.is_public, `OASIS agent "${slug}" must be a public library seed or its channel 404s`);
  }
  // Suggested asks reuse OASIS's own quick actions by title; a renamed one
  // must fail here, not silently vanish from the panel.
  for (const [dept, agent, title] of OASIS_ASK_REFERENCES) {
    assert.ok(
      QUICK_ACTIONS.some((q) => q.agent === agent && q.title === title),
      `${dept}: quick action "${title}" (${agent}) no longer exists in lib/quick-actions.ts`,
    );
  }
  for (const d of OS_DEPARTMENTS) {
    assert.ok(suggestedAsksFor(d.key, { oasis: true }).length > 0, `${d.slug}: OASIS has no suggested asks`);
    assert.ok(suggestedAsksFor(d.key, { oasis: false }).length > 0, `${d.slug}: client has no suggested asks`);
  }
}

// ── 7. The page gates before it reads ─────────────────────────────────────
{
  const page = read("app/team/[dept]/page.tsx");
  const gateAt = page.indexOf("departmentGate(slug, viewer.navInput)");
  assert.ok(gateAt > 0, "the department page must gate with departmentGate");
  assert.match(page, /if \(!dept\) notFound\(\);/, "a refused department must 404");
  for (const reader of ["loadTenantRoutines(", "resolveChannelState(", "loadDepartmentNumbers("]) {
    const at = page.indexOf(reader);
    assert.ok(at > gateAt, `${reader} must run after the gate, never before it`);
  }
  // ?q= prefills; it never sends. AgentChat submits only on the person's own
  // keystroke, and the channel shim must never submit a form or click Send.
  const channel = read("components/os/department/DepartmentChannel.tsx");
  assert.doesNotMatch(channel, /requestSubmit|\.submit\(|\.click\(\)/, "prefill must never send");
  assert.match(channel, /from "@\/components\/agents\/AgentChat"/, "the channel is AgentChat");
  assert.doesNotMatch(channel, /from "@\/components\/ChatWidget"/, "never the operator ChatWidget");
  // Keyed by department, or Sales' conversation carries into Marketing.
  assert.match(read("components/os/department/DepartmentTab.tsx"), /key=\{`\$\{dept\.key\}/);
}

// ── 8. /agents is the AI Team; the fleet is operator-only ─────────────────
{
  const page = read("app/agents/page.tsx");
  for (const operatorOnly of ['from "@/components/ChatWidget"', "bridge_pairings", "aiServicesWithKey", "getTenantBridgeOwner", "agentStates("]) {
    assert.ok(!page.includes(operatorOnly), `/agents is the roster, not the fleet, and must not touch ${operatorOnly}`);
  }
  // Gated exactly as the rail's row: the persona wall first, then the rail's
  // own predicate, both before the roster read.
  const wall = page.indexOf("await requireSystemSurface();");
  const rail = page.indexOf("if (!mayOpenOsHref(viewer.navInput, AI_TEAM_HREF)) notFound();");
  const firstRead = page.indexOf("loadAiTeam(");
  assert.ok(wall > 0 && rail > wall, "/agents: requireSystemSurface, then the rail's mayOpenOsHref");
  assert.ok(firstRead > rail, "/agents reads its roster before it has decided the viewer may see it");
  assert.match(page, /const AI_TEAM_HREF = "\/agents";/);
  assert.match(page, /if \(!viewer\.provisioned\) notFound\(\);/, "an unprovisioned workspace sees Today only");

  // One fleet, at Admin › Fleet. A second copy of the old page was once left
  // under components/os/aiteam — dead code carrying the ChatWidget and the
  // bridge reads, one stray import away from a non-operator page.
  assert.equal(
    existsSync(join(ROOT, "components/os/aiteam/AgentFleet.tsx")),
    false,
    "the fleet lives in components/os/landings; do not fork it into aiteam",
  );
  const fleetPage = read("app/admin/agents/page.tsx");
  assert.match(fleetPage, /from "@\/components\/os\/landings\/AgentFleet"/);
  // #464: the moved fleet must not bring back the glow or the pulse.
  for (const f of ["components/os/landings/AgentFleet.tsx", "app/admin/agents/page.tsx"]) {
    assert.doesNotMatch(read(f), /shadow-\[0_0_|animate-pulse|drop-shadow|bg-gradient/, f);
  }
}

// ── 9. Templates: the six the plan names, neutral, in the builder's terms ─
{
  assert.deepEqual(
    TEAMMATE_TEMPLATES.map((t) => t.name),
    ["Setter", "Support rep", "Bookkeeper", "Media buyer", "Content producer", "Project manager"],
  );
  const OASIS_STRINGS = /\b(bravo|maven|atlas|oasis|cc)\b/i;
  for (const t of TEAMMATE_TEMPLATES) {
    assert.ok(t.category in CATEGORY_LABELS, `${t.key}: category "${t.category}" is not one the builder offers`);
    assert.ok(!OASIS_STRINGS.test(JSON.stringify(t)), `${t.key}: template carries an OASIS string`);
    assert.match(t.key, /^[a-z-]+$/);
  }
}

// ── 10. Routines: plain English, the right owner, recent failures only ────
{
  const cases: Array<[string, string]> = [
    ["*/15 * * * *", "Every 15 minutes"],
    ["0 * * * *", "Hourly at :00"],
    ["30 7 * * 1-5", "Weekdays at 7:30 AM"],
    ["0 9 * * *", "Daily at 9:00 AM"],
    ["0 18 * * 1", "Mondays at 6:00 PM"],
    ["0 0 1 * *", "Monthly on day 1 at 12:00 AM"],
    ["0 */4 * * *", "Every 4 hours"],
    ["5 4 * JAN *", "Custom schedule"],
    ["garbage", "Custom schedule"],
  ];
  for (const [expr, want] of cases) assert.equal(describeSchedule(expr), want, expr);
  for (const [expr] of cases) assert.ok(!describeSchedule(expr).includes("*"), "cron syntax never reaches the panel");

  const row = (over: Partial<RoutineRow>): RoutineRow => ({
    id: "r", agentKey: "bravo", name: "x", description: "", schedule: "0 9 * * *",
    enabled: true, lastRunAt: null, lastRunStatus: null, ...over,
  });
  const rows = [row({ id: "a", agentKey: "bravo" }), row({ id: "b", agentKey: "maven" }), row({ id: "c", agentKey: "sdr" })];
  assert.equal(routinesForDepartment(rows, "operations", []).length, 3, "Operations lists every routine");
  assert.deepEqual(routinesForDepartment(rows, "marketing", ["maven"]).map((r) => r.id), ["b"]);
  assert.deepEqual(routinesForDepartment(rows, "marketing", []), [], "an unbound department owns no routines");

  const now = Date.parse("2026-09-28T12:00:00Z");
  const recent = row({ id: "f1", lastRunStatus: "error", lastRunAt: "2026-09-28T06:00:00Z" });
  const old = row({ id: "f2", lastRunStatus: "error", lastRunAt: "2026-09-20T06:00:00Z" });
  const ok = row({ id: "s", lastRunStatus: "success", lastRunAt: "2026-09-28T06:00:00Z" });
  assert.deepEqual(failedWithin([recent, old, ok], 24, now).map((r) => r.id), ["f1"]);

  assert.equal(lastRunLabel(row({}), () => "x"), "Never run");
  assert.equal(lastRunLabel(recent, () => "6h ago"), "Failed 6h ago");
  // SQLite hands booleans back as 0/1: a disabled routine must not read "On".
  assert.equal(normalizeRoutineRow({ id: 1, enabled: 0, agent_key: "BRAVO" }).enabled, false);
  assert.equal(normalizeRoutineRow({ id: 1, enabled: 1, agent_key: "BRAVO" }).agentKey, "bravo");
}

// ── 11. A capped ticket count is a floor on every tab ─────────────────────
// CodeRabbit #468: Client Success printed "500+" for a ticket list at its read
// ceiling while Chief of Staff printed the same count as an exact "500".
{
  assert.equal(tileCount(500, true), "500+");
  assert.equal(tileCount(1234, false), "1,234");
  assert.equal(tileCount(0, false), "0");
  const numbers = read("components/os/department/numbers.ts");
  assert.doesNotMatch(numbers, /\bn\(d\.open\)/, "an open-ticket tile printed the raw count, dropping the floor marker");
  // Breached / at-risk come from the same capped ticket read, active projects
  // from a capped project read: all floors when the read hit its ceiling.
  assert.doesNotMatch(
    numbers,
    /\bn\(d\.(breached|atRisk|activeProjects)\)/,
    "a delivery tile printed a raw count from a capped read, dropping the floor marker",
  );
  assert.match(numbers, /tileCount\(d\.breached, d\.truncated\)/);
  assert.match(numbers, /tileCount\(d\.atRisk, d\.truncated\)/);
  assert.match(numbers, /tileCount\(d\.activeProjects, d\.projectsTruncated\)/);
  // ONE floor rule for the whole shell: Today and Clients use lib/os/count.ts
  // too, so the same queue can never print "≥500" on one screen and "500+" on
  // another (three hand-rolled copies had drifted exactly that way).
  const today = read("components/os/today/model.ts");
  const clients = read("components/os/landings/clients-model.ts");
  assert.match(today, /from "@\/lib\/os\/count"/);
  assert.match(clients, /from "@\/lib\/os\/count"/);
  assert.doesNotMatch(today, /["`]≥/, "Today hand-rolls a floor marker instead of floorCount");
  assert.doesNotMatch(clients, /\$\{value\}\+`/, "Clients hand-rolls a floor marker instead of floorCount");
  assert.equal(
    (numbers.match(/tileCount\(d\.open, d\.truncated\)/g) || []).length,
    2,
    "Chief of Staff and Client Success both print open tickets through tileCount",
  );
  // No hand-rolled floor anywhere in the tile builders (CodeRabbit #469 found
  // two: new leads this week and form submissions).
  assert.doesNotMatch(numbers, /\$\{n\([^)]*\)\}\+/, "a tile hand-rolls a floor marker instead of tileCount");

  // The header's "Needs you" total is a floor whenever any item behind it is
  // (CodeRabbit #469): the header must not print "2" over a line saying "2+".
  assert.deepEqual(statusFor(true, 2, true), { kind: "needs_you", count: 2, capped: true });
  assert.deepEqual(statusFor(true, 2), { kind: "needs_you", count: 2, capped: false }, "uncapped by default");
  // A floor of 0 (a count that could not be read) is not "nothing waiting".
  assert.deepEqual(statusFor(true, 0, true), { kind: "unknown" });
  assert.deepEqual(statusFor(true, 0), { kind: "working" });
  assert.deepEqual(statusFor(false, 2, true), { kind: "not_connected" });
  const pill = read("components/os/department/StatusPill.tsx");
  assert.match(pill, /floorCount\(status\.count, status\.capped\)/, "the pill prints the total through the shared floor rule");
  assert.match(numbers, /capped: d\.truncated/, "a breach item carries its read's cap");
  const page = read("app/team/[dept]/page.tsx");
  assert.match(page, /numbers\.attention\.some\(\(item\) => item\.capped === true\)/);
  assert.match(page, /statusFor\(channel\.kind === "ready", needsYou, needsYouCapped\)/);
}

console.log(
  `os-departments: OK — ${OS_DEPARTMENTS.length} departments × ${PERSONAS.length} personas gated, ` +
    `Finance owner-only and OASIS-only, client channels neutral, gate-before-read pinned, ` +
    `${TEAMMATE_TEMPLATES.length} templates`,
);
