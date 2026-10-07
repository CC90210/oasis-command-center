/**
 * OASIS OS rail — who sees which row (lib/os/nav.ts buildOsNav).
 *
 * WHY THIS EXISTS. The rail is the first thing every viewer of every workspace
 * sees, and it is computed from persona × capability × operator × workspace ×
 * module. The failures that matter are all "a row appeared where it must not":
 * OASIS's Admin, Prospects or Money on a client's rail; Money on a rep's; CC's
 * nav on an unprovisioned signup (the seeds.ts fail-open this OS replaces).
 * Each is invisible until someone screenshots it, so the matrix is executed
 * here, adversarially — callers are handed every flag set wrong, and the
 * function must still fail closed.
 *
 * It also pins that every rail <Link> in components/os/ keeps prefetch off:
 * every row is in the viewport, and viewport prefetch cost ~3 s of server work
 * per page load when it was on (tests/perf-prefetch.test.ts has the numbers).
 *
 * Run: node --conditions=react-server --import tsx tests/os-nav.test.ts
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASK_HREF,
  OS_NAV_CATALOG,
  OS_SECTIONS,
  askHrefFor,
  buildOsNav,
  mayOpenOsHref,
  osNavRows,
  type BuildOsNavInput,
} from "../lib/os/nav";
import { OS_DEPARTMENTS, departmentBySlug } from "../lib/os/departments";
import { ALL_MODULES, TIER_MODULES, resolveOsModules } from "../lib/os/modules";
import {
  BUILDER_NAV_ALLOWLIST,
  MANAGER_NAV_ALLOWLIST,
  MARKETING_NAV_ALLOWLIST,
  SALES_NAV_ALLOWLIST,
  capabilitiesFor,
  type Persona,
} from "../lib/role-surfaces";
import type { OsSectionKey } from "../lib/os/types";
import { activeRailMode, lastNormalMode, modeToRemember } from "../components/os/rail-mode";

const PERSONAS: Persona[] = ["founder", "manager", "sales", "marketing", "builder", "worker", "readonly", "legacy"];
const OASIS = "oasis-ai-cc";

const hrefs = (input: BuildOsNavInput) => osNavRows(buildOsNav(input)).map((r) => r.href);
const sectionKeys = (input: BuildOsNavInput) => buildOsNav(input).map((s) => s.key);

/** The OASIS viewer as the layout builds it: honest flags. */
function oasisViewer(persona: Persona, over: Partial<BuildOsNavInput> = {}): BuildOsNavInput {
  const founders = persona === "founder";
  return {
    persona,
    capabilities: capabilitiesFor(persona, OASIS),
    isOperator: false,
    tenantSlug: OASIS,
    isOasisTenant: true,
    modules: resolveOsModules({ tenantSlug: OASIS, provisioned: true }),
    provisioned: true,
    founders: { content: founders, finances: founders },
    ...over,
  };
}

// ── 1. The catalog is well-formed ─────────────────────────────────────────
{
  const sectionKeysKnown = new Set(OS_SECTIONS.map((s) => s.key));
  const ids = new Set<string>();
  const seenHrefs = new Set<string>();
  for (const entry of OS_NAV_CATALOG) {
    assert.ok(sectionKeysKnown.has(entry.section), `${entry.id} names unknown section ${entry.section}`);
    assert.ok(!ids.has(entry.id), `duplicate catalog id ${entry.id}`);
    ids.add(entry.id);
    // One home per route: two rows for one href both light up as active.
    assert.ok(!seenHrefs.has(entry.href), `${entry.href} is listed twice (choose one home)`);
    seenHrefs.add(entry.href);
    assert.ok(entry.href.startsWith("/"), `${entry.id} href must be absolute`);
    if (entry.module) assert.ok(ALL_MODULES.includes(entry.module), `${entry.id} names unknown module`);
    // Sentence case: a group or label is never ALL CAPS.
    for (const text of [entry.label, entry.group].filter(Boolean) as string[]) {
      assert.notEqual(text, text.toUpperCase(), `${entry.id}: "${text}" must be sentence case`);
    }
  }
  // Every department is a row, generated from the one department list.
  for (const d of OS_DEPARTMENTS) {
    const row = OS_NAV_CATALOG.find((e) => e.department === d.key);
    assert.ok(row, `department ${d.key} has no rail row`);
    assert.equal(row!.href, d.href);
    assert.equal(row!.label, d.label);
    assert.equal(row!.group, "Departments");
    assert.equal(departmentBySlug(d.slug), d);
    assert.equal(departmentBySlug(d.slug.toUpperCase()), d, "slug lookup is case-insensitive");
  }
  assert.equal(departmentBySlug("research"), null, "a department with no page has no slug");
  // The spec's routes are where the spec put them.
  const at = (href: string) => OS_NAV_CATALOG.find((e) => e.href === href);
  const expectSection: Array<[string, OsSectionKey]> = [
    ["/", "team"], ["/feed", "team"], ["/schedule", "team"], ["/projects", "team"], ["/playbook", "team"],
    ["/agents", "team"], ["/team/chief-of-staff", "team"], ["/pipeline", "growth"], ["/web-leads", "growth"],
    ["/training", "growth"], ["/commissions", "growth"], ["/forms", "growth"], ["/growth/ads", "growth"],
    ["/founders/marketing", "growth"], ["/seo", "growth"], ["/clients", "clients"], ["/tickets", "clients"], ["/money", "money"],
    ["/analytics", "money"], ["/operations", "admin"], ["/automations", "admin"], ["/health", "admin"],
    ["/agent", "admin"], ["/admin/agents", "admin"], ["/runs", "admin"], ["/inbox", "admin"],
  ];
  // One System health (2026-09-30): /system-health folded into /health and
  // redirects there, so the catalog has no row for it.
  assert.equal(at("/system-health"), undefined, "no second System health row");
  assert.equal(at("/health")?.label, "System health");
  assert.equal(at("/agent")?.label, "Coding harness");
  for (const [href, section] of expectSection) {
    assert.equal(at(href)?.section, section, `${href} belongs in ${section}`);
  }
}

// ── 2. Unknown and non-OASIS workspaces never see OASIS's rows ────────────
// Adversarial: every flag a careless caller could set wrong IS set wrong —
// operator true, founders gates open, every module on, and isOasisTenant true.
{
  // /agents (the AI Team) left this list in W4a (decision 22): it is every
  // workspace's own roster, for its owners and admins (section 4 below).
  const OASIS_ONLY = ["/web-leads", "/training", "/objections", "/founders/marketing", "/money", "/analytics", "/playbook", "/seo"];
  for (const slug of [null, "", "acme-roofing", "sun", "submissions", "oasis-ai-cc-evil", "unprovisioned"]) {
    for (const persona of PERSONAS) {
      for (const lyingOasisFlag of [true, false]) {
        const input: BuildOsNavInput = {
          persona,
          capabilities: capabilitiesFor(persona, OASIS), // even OASIS-grade capabilities
          isOperator: true,
          tenantSlug: slug,
          isOasisTenant: lyingOasisFlag,
          modules: ALL_MODULES,
          provisioned: true,
          founders: { content: true, finances: true },
        };
        const rows = hrefs(input);
        const sections = sectionKeys(input);
        const where = `slug=${JSON.stringify(slug)} persona=${persona} isOasisTenant=${lyingOasisFlag}`;
        assert.ok(!sections.includes("admin"), `Admin on a non-OASIS rail (${where})`);
        assert.ok(!sections.includes("money"), `Money on a non-OASIS rail (${where})`);
        for (const href of OASIS_ONLY) {
          assert.ok(!rows.includes(href), `${href} on a non-OASIS rail (${where})`);
        }
      }
    }
  }
}

// ── 3. Unprovisioned workspace, unresolved viewer: Today only ─────────────
{
  for (const persona of PERSONAS) {
    const unprovisioned = oasisViewer(persona, { provisioned: false, isOperator: true });
    assert.deepEqual(hrefs(unprovisioned), ["/"], `unprovisioned ${persona} gets Today only`);
  }
  assert.deepEqual(hrefs(oasisViewer("founder", { persona: null, isOperator: true })), ["/"], "unknown persona gets Today only");
  assert.deepEqual(resolveOsModules({ tenantSlug: OASIS, provisioned: false }), [], "no modules before provisioning");
  assert.deepEqual(resolveOsModules({ tenantSlug: "acme-roofing", provisioned: true }), [], "client modules fail closed");
  assert.deepEqual(resolveOsModules({ tenantSlug: OASIS, provisioned: true }), TIER_MODULES.internal);
  // The one row every member has, and it is where Team starts.
  const today = buildOsNav(oasisViewer("sales", { provisioned: false }));
  assert.equal(today.length, 1);
  assert.equal(today[0].key, "team");
  assert.equal(today[0].home, "/");
}

// ── 4. Money: owners only ─────────────────────────────────────────────────
{
  for (const persona of PERSONAS.filter((p) => p !== "founder")) {
    // Founders gates forced open: the persona rule must still hold.
    const input = oasisViewer(persona, { founders: { content: true, finances: true } });
    assert.ok(!sectionKeys(input).includes("money"), `${persona} must not get a Money section`);
    assert.ok(!hrefs(input).includes("/money"), `${persona} must not get /money`);
    assert.ok(!hrefs(input).includes("/analytics"), `${persona} must not get /analytics`);
    assert.ok(!hrefs(input).includes("/team/finance"), `${persona} must not get the Finance department`);
  }
  const owner = oasisViewer("founder");
  assert.ok(sectionKeys(owner).includes("money"));
  assert.deepEqual(
    buildOsNav(owner).find((s) => s.key === "money")!.groups.flatMap((g) => g.rows.map((r) => r.href)),
    ["/money", "/analytics"],
  );
  // A founder who is not a finance owner keeps Analytics (company money they
  // may see) but not the founders Finances overview (CC and Adon only).
  const otherAdmin = oasisViewer("founder", { founders: { content: true, finances: false } });
  assert.ok(!hrefs(otherAdmin).includes("/money"));
  assert.ok(hrefs(otherAdmin).includes("/analytics"));
  // A client workspace's owner: no Money at all until fin_* is tenant-scoped.
  const clientOwner: BuildOsNavInput = {
    persona: "founder",
    capabilities: capabilitiesFor("founder", "acme-roofing"),
    isOperator: false,
    tenantSlug: "acme-roofing",
    isOasisTenant: false,
    modules: resolveOsModules({ tenantSlug: "acme-roofing", provisioned: true }),
    provisioned: true,
  };
  assert.ok(!sectionKeys(clientOwner).includes("money"), "client owner: no Money yet");
  assert.ok(!hrefs(clientOwner).includes("/team/finance"), "client owner: no Finance department yet");
  // …but the core OS they bought is there, the AI Team included (decision 22).
  for (const href of ["/", "/feed", "/schedule", "/projects", "/pipeline", "/forms", "/clients", "/tickets", "/agents",
    "/team/chief-of-staff", "/team/sales", "/team/marketing", "/team/client-success", "/team/operations"]) {
    assert.ok(hrefs(clientOwner).includes(href), `client owner keeps ${href}`);
  }
  // The AI Team is a manage surface: no one below an owner/admin gets it, in
  // a client's workspace or OASIS's.
  for (const persona of PERSONAS.filter((p) => p !== "founder")) {
    const member: BuildOsNavInput = { ...clientOwner, persona, capabilities: capabilitiesFor(persona, "acme-roofing") };
    assert.ok(!hrefs(member).includes("/agents"), `client ${persona} must not get the AI Team`);
    assert.ok(!hrefs(oasisViewer(persona)).includes("/agents"), `OASIS ${persona} must not get the AI Team`);
  }
  assert.ok(hrefs(oasisViewer("founder")).includes("/agents"), "OASIS's owner keeps the AI Team");
}

// ── 5. Admin: platform operators in an OASIS workspace ────────────────────
{
  const ADMIN = ["/operations", "/automations", "/health", "/agent", "/admin/agents", "/runs", "/inbox"];
  const operator = oasisViewer("founder", { isOperator: true });
  const admin = buildOsNav(operator).find((s) => s.key === "admin");
  assert.ok(admin, "an operator gets the Admin section");
  assert.deepEqual(admin!.groups.flatMap((g) => g.rows.map((r) => r.href)), ADMIN);
  // Admin is never a mode tab's neighbour by accident: it is last.
  assert.equal(buildOsNav(operator).at(-1)!.key, "admin");
  for (const persona of PERSONAS) {
    const notOperator = oasisViewer(persona, { isOperator: false });
    assert.ok(!sectionKeys(notOperator).includes("admin"), `${persona} without operator status has no Admin`);
    for (const href of ADMIN) assert.ok(!hrefs(notOperator).includes(href), `${persona} must not get ${href}`);
  }
  // The plumbing left the normal rail: a founder who is not an operator no
  // longer has Operations / Automations / Health / Agents anywhere.
}

// ── 6. Reps keep every surface they use daily ─────────────────────────────
{
  const DAILY = ["/", "/schedule", "/playbook", "/pipeline", "/web-leads", "/training", "/objections", "/commissions"];
  for (const persona of ["sales", "manager"] as const) {
    const rows = hrefs(oasisViewer(persona));
    for (const href of DAILY) assert.ok(rows.includes(href), `${persona} lost ${href}`);
    assert.ok(rows.includes("/team/sales"), `${persona} works in the Sales department`);
    assert.ok(rows.includes("/team/chief-of-staff"), `${persona} can ask Chief of Staff`);
    // The Feed row is for everyone; a rep's page is Needs you only (tests/os-landings.test.ts).
    assert.ok(rows.includes("/feed"), `${persona} gets the Feed`);
    for (const forbidden of ["/team/marketing", "/team/finance", "/team/operations", "/team/client-success",
      "/founders/marketing", "/forms", "/clients", "/tickets", "/projects", "/agents"]) {
      assert.ok(!rows.includes(forbidden), `${persona} must not get ${forbidden}`);
    }
    // Zero-row sections vanish: a rep has nothing in Clients or Money.
    assert.deepEqual(sectionKeys(oasisViewer(persona)), ["team", "growth"], `${persona} modes`);
    assert.equal(askHrefFor(buildOsNav(oasisViewer(persona))), ASK_HREF);
  }
  // Marketing and the builder keep what they had, plus their departments.
  const marketing = hrefs(oasisViewer("marketing", { founders: { content: true, finances: false } }));
  for (const href of ["/", "/feed", "/schedule", "/pipeline", "/playbook", "/founders/marketing", "/team/marketing", "/growth/ads"]) {
    assert.ok(marketing.includes(href), `marketing lost ${href}`);
  }
  assert.ok(!marketing.includes("/web-leads"), "marketing does not prospect");
  const builder = hrefs(oasisViewer("builder", { founders: { content: true, finances: false } }));
  for (const href of ["/", "/feed", "/pipeline", "/web-leads", "/commissions", "/founders/marketing", "/team/sales", "/team/marketing"]) {
    assert.ok(builder.includes(href), `builder lost ${href}`);
  }
  assert.ok(!builder.includes("/automations") && !builder.includes("/operations"), "never the machine controls");
  // An internal worker sees the work, not the money or the commission ledger.
  const worker = hrefs(oasisViewer("worker"));
  assert.ok(worker.includes("/pipeline") && worker.includes("/web-leads"));
  assert.ok(!worker.includes("/commissions"), "the commission page 404s for a worker; no dead tab");
  assert.ok(!worker.includes("/projects") && !worker.includes("/tickets"), "delivery is founder-only inside OASIS");
}

// ── 7. The persona allowlists and the catalog agree ───────────────────────
// A narrowed persona's allowlist row that no catalog row carries is a surface
// the rail can never show them. "/settings" is the footer gear, not a row.
{
  const catalogHrefs = new Set(OS_NAV_CATALOG.map((e) => e.href));
  for (const [name, list] of [
    ["sales", SALES_NAV_ALLOWLIST],
    ["manager", MANAGER_NAV_ALLOWLIST],
    ["marketing", MARKETING_NAV_ALLOWLIST],
    ["builder", BUILDER_NAV_ALLOWLIST],
  ] as const) {
    for (const href of list) {
      assert.ok(href === "/settings" || catalogHrefs.has(href), `${name} allowlists ${href}, which no rail row carries`);
    }
  }
  // The Feed row's audience is "everyone" (feed-model.ts: without the tape you
  // still get Needs you), so no persona allowlist may filter it back out —
  // CodeRabbit #468 found four that did.
  for (const persona of PERSONAS) {
    assert.ok(hrefs(oasisViewer(persona)).includes("/feed"), `${persona} lost the Feed row`);
  }
}

// ── 8. Content and the Ask button follow their gates ──────────────────────
{
  assert.ok(hrefs(oasisViewer("founder")).includes("/founders/marketing"));
  assert.ok(
    !hrefs(oasisViewer("founder", { founders: { content: false, finances: false } })).includes("/founders/marketing"),
    "Content needs the founders gate",
  );
  assert.equal(askHrefFor(buildOsNav(oasisViewer("founder", { provisioned: false }))), null, "no Ask into a 404");
}

// ── 9. mayOpenOsHref is the rail's own answer ─────────────────────────────
{
  for (const persona of PERSONAS) {
    for (const isOperator of [true, false]) {
      const input = oasisViewer(persona, { isOperator });
      const drawn = new Set(hrefs(input));
      for (const entry of OS_NAV_CATALOG) {
        assert.equal(mayOpenOsHref(input, entry.href), drawn.has(entry.href), `${persona} ${entry.href}`);
      }
    }
  }
  assert.equal(mayOpenOsHref(oasisViewer("founder"), "/not-a-rail-route"), false);
}

// ── 10. The data is plain: it crosses the server → client boundary ────────
{
  const sections = buildOsNav(oasisViewer("founder", { isOperator: true }));
  assert.deepEqual(JSON.parse(JSON.stringify(sections)), sections, "sections must survive RSC serialisation");
  for (const s of sections) assert.equal(s.home, s.groups[0].rows[0].href, `${s.key} tab goes to its first row`);
}

// ── 11. Every rail <Link> keeps prefetch off ──────────────────────────────
// The shell's own files only: they render on every page, and every one of
// their links is in the viewport. Page components under components/os/ make
// their own prefetch calls.
{
  const dir = join(process.cwd(), "components", "os");
  const SHELL_FILES = [
    "OsRail.tsx", "ModeTabs.tsx", "RailGroup.tsx", "RailRow.tsx", "RailFooter.tsx",
    "ContentHeader.tsx", "PageFrame.tsx", "KpiTile.tsx",
  ];
  const present = readdirSync(dir);
  for (const name of SHELL_FILES) assert.ok(present.includes(name), `components/os/${name} is missing`);
  for (const name of SHELL_FILES) {
    const src = readFileSync(join(dir, name), "utf8");
    // `<Link` followed by whitespace = a JSX element with attributes; a prose
    // mention like "<Link>" in a comment is not counted.
    const links = (src.match(/<Link\s/g) || []).length;
    const off = (src.match(/prefetch=\{false\}/g) || []).length;
    assert.equal(off, links, `components/os/${name}: ${links} <Link> but ${off} prefetch={false}`);
  }
  const railRow = readFileSync(join(dir, "RailRow.tsx"), "utf8");
  assert.ok(/router\.prefetch\(/.test(railRow), "intent warming must still warm the route");
  assert.ok(/onMouseEnter=\{warm\}/.test(railRow) && /onFocus=\{warm\}/.test(railRow), "warm on hover and focus");
  // The OS rail's source must not reintroduce the looks #464 removed.
  for (const name of SHELL_FILES) {
    const src = readFileSync(join(dir, name), "utf8");
    assert.ok(!/bg-gradient|from-accent|blur-|shadow-glow|animate-pulse|drop-shadow/.test(src), `components/os/${name} has a gradient/glow/perpetual animation`);
  }
}

// ── 12. The rail remembers the mode actually used (components/os/rail-mode.ts) ─
// CodeRabbit #468: the remembered mode was read once on mount, so a tab that
// mounted in Team, moved to Growth and toggled Admin on and off landed on Team.
{
  const available: OsSectionKey[] = ["team", "growth", "clients", "admin"];
  const step = (remembered: OsSectionKey | null, active: OsSectionKey | null) => modeToRemember(active, true) ?? remembered;

  let remembered: OsSectionKey | null = "team"; // what the mount read from sessionStorage
  let active = activeRailMode({ manual: null, pathMode: "growth", remembered, available });
  assert.equal(active, "growth", "the path owns the mode");
  remembered = step(remembered, active);
  active = activeRailMode({ manual: "admin", pathMode: "growth", remembered, available });
  assert.equal(active, "admin", "the shield opens Admin");
  remembered = step(remembered, active);
  assert.equal(remembered, "growth", "Admin is never the remembered mode");
  assert.equal(lastNormalMode({ remembered, available }), "growth", "leaving Admin returns to the mode last used, not the mount-time one");
  // A page no row owns (/settings) keeps the mode last used, not the first one.
  assert.equal(activeRailMode({ manual: null, pathMode: null, remembered, available }), "growth");

  // Mount race: the first render (before storage is read) falls back to the
  // first mode, and must not be remembered over the stored one.
  assert.equal(activeRailMode({ manual: null, pathMode: null, remembered: null, available }), "team");
  assert.equal(modeToRemember("team", false), null, "nothing is remembered before storage has been read");
  assert.equal(modeToRemember("admin", true), null);
  assert.equal(modeToRemember(null, true), null);

  // A remembered mode the viewer no longer has (or a tampered value) falls back.
  assert.equal(lastNormalMode({ remembered: "money", available }), "team");
  assert.equal(lastNormalMode({ remembered: "admin", available }), "team");
  assert.equal(activeRailMode({ manual: "money", pathMode: null, remembered: null, available }), "team", "a tab the viewer lacks is ignored");
}

console.log(
  `os-nav: OK — ${OS_NAV_CATALOG.length} catalog rows, ${PERSONAS.length} personas, ` +
    `${OS_DEPARTMENTS.length} departments, non-OASIS / unprovisioned / non-owner / non-operator all fail closed`,
);
