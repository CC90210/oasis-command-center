/**
 * skills-tab-render.test.ts - server-rendered markup of the Skills tab (JARVIS plan 3, Tasks 7-11).
 * PINNED (accessibility and honesty, not pixels): every control has a name, pressed/selected states
 * are exposed, numbers are tabular, "not tested" never renders as a score, held changes show their
 * totals and why Accept anyway is off, misses read "not checked yet", never "0 misses".
 * Run: node --import tsx tests/skills-tab-render.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CHANGES, COMPUTER, LIB, NOW } from "./skills-tab-fixture";
import type { Library } from "../lib/skills/view";

const ROOT = join(__dirname, "..");
type Scenario = { id: string; component: string; props: Record<string, unknown> };
function render(scenarios: Scenario[]): Record<string, string> {
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/skills-tab.render.ts"], {
    encoding: "utf8", cwd: ROOT, env: { ...process.env, NODE_OPTIONS: "" }, input: JSON.stringify(scenarios),
  });
  assert.equal(r.status, 0, `the render helper exited ${r.status}:\n${r.stderr}`);
  return JSON.parse(r.stdout) as Record<string, string>;
}
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); }
}
const sections: (() => void)[] = [];
void CHANGES; void COMPUTER; void NOW;

// Fix round 1 (task 7) #3: a group where the use-first skill sorts LATER alphabetically than the
// also-helps skill, so a regression to plain alphabetical order (instead of rank-then-alphabetical)
// would actually be caught. Kept local to this test file so the shared fixture and its other
// pinned assertions (tile/member counts in both render and view tests) are untouched.
const RANK_LIB: Library = {
  skills: [
    { name: "aardvark-also-helps", description: "d", kind: "installed", quarantined: false, capabilities: [], example_prompts: [], tests: null },
    { name: "zebra-use-first", description: "d", kind: "installed", quarantined: false, capabilities: [], example_prompts: [], tests: null },
  ],
  labels: [{ id: "rank-check", level: "broad", parent: null, name: "Rank check", meaning: "", examples: [] }],
  assignments: [
    { skill: "aardvark-also-helps", label: "rank-check", rank: "also-helps" },
    { skill: "zebra-use-first", label: "rank-check", rank: "use-first" },
  ],
  kinds: {},
  records_at: null,
};

// --- Task 7: Library ---
sections.push(() => {
  const html = render([
    { id: "tiles", component: "LibraryView", props: { lib: LIB, group: null } },
    { id: "group", component: "LibraryView", props: { lib: LIB, group: "debug" } },
    { id: "rank", component: "LibraryView", props: { lib: RANK_LIB, group: "rank-check" } },
  ]);
  check("tiles show plain names, skill counts and scores as prompt counts", () => {
    const t = text(html.tiles);
    assert.match(t, /Fix something broken 3 skills 27 of 32 routed right/);
    assert.match(t, /A kind with no short name yet 0 skills Not tested yet/);
  });
  check("the sort control exposes its pressed state", () => {
    assert.match(html.tiles, /aria-pressed="true"[^>]*>Biggest/);
    assert.match(html.tiles, /aria-pressed="false"[^>]*>Weakest/);
  });
  check("a meter is announced as a count, an untested kind has no meter value", () => {
    assert.match(html.tiles, /role="img" aria-label="27 of 32 test prompts routed right"/);
    assert.doesNotMatch(html.tiles, /aria-label="0 of 0/);
    // Fix round 1 (task 7) #4: not just absent text - the untested kind ("brand-new-kind") carries
    // no role="img" meter value at all. Only the two kinds with a real score (debug, ui-build) do.
    const meters = html.tiles.match(/role="img" aria-label="\d+ of \d+ test prompts routed right"/g) ?? [];
    assert.equal(meters.length, 2, "exactly the two tested kinds should carry a meter value, never the untested one");
  });
  check("a kind of work opens to its chips and its skills, use-first first", () => {
    const t = text(html.group);
    assert.match(t, /All kinds of work/);
    assert.match(html.group, /role="group" aria-label="Filter by sub-label"/);
    assert.ok(t.indexOf("graft") < t.indexOf("turso-cloud"));
    assert.match(t, /turso-cloud Also helps .* Not tested/);
  });
  check("fix round 1 (task 7) #3: use-first sorts before also-helps even against alphabetical order", () => {
    const t = text(html.rank);
    assert.ok(t.indexOf("zebra-use-first") < t.indexOf("aardvark-also-helps"),
      "zebra-use-first is ranked use-first and must sort before the alphabetically-earlier also-helps skill");
  });
  check("fix round 1 (task 7) #2: a truncated skill name and description can be read via title (D18)", () => {
    assert.match(html.group, /title="graft"/);
    assert.match(html.group, /title="Find code by symbol and trace who calls what\."/);
    assert.match(html.group, /title="turso-cloud"/);
    assert.match(html.group, /title="Turso Cloud databases and tokens\."/);
  });
  check("numbers are tabular", () => {
    assert.match(html.tiles, /tabular-nums/);
  });
});
// --- Task 8: skill sheet ---
sections.push(() => {
  const html = render([
    { id: "graft", component: "SkillSheetBody", props: { lib: LIB, name: "graft" } },
    { id: "turso", component: "SkillSheetBody", props: { lib: LIB, name: "turso-cloud" } },
    { id: "gone", component: "SkillSheetBody", props: { lib: LIB, name: "not-installed-here" } },
  ]);
  check("the sheet shows the description, capabilities, an example and the test record", () => {
    const t = text(html.graft);
    assert.match(t, /Find code by symbol/);
    assert.match(t, /What it can do for a prompt Finds the function behind a slow screen/);
    // Ruling C5: no required space after "seconds" - the markup closes the quoted prompt with a
    // closing curly quote right against the word, e.g. `...4 seconds"finds the query...`.
    assert.match(t, /the owner search takes 4 seconds.*finds the query and every caller/);
    assert.match(t, /3 of 4 test prompts routed here/);
    assert.match(html.graft, /role="img" aria-label="3 of 4 test prompts routed here"/);
  });
  check("an untested skill says so and draws no squares", () => {
    assert.match(text(html.turso), /Not tested, no evidence/);
    assert.doesNotMatch(html.turso, /role="img"/);
  });
  check("each group offers rank and remove buttons with a full accessible name", () => {
    assert.match(html.graft, /aria-label="Make graft also helps in Speed up a slow query"/);
    assert.match(html.graft, /aria-label="Take graft out of Speed up a slow query"/);
    assert.match(html.turso, /aria-label="Make turso-cloud use first in Speed up a slow query"/);
  });
  check("adding to a group uses a labelled select", () => {
    assert.match(html.graft, /<label[^>]*for="skill-add-to"[^>]*>Add to a group/);
    assert.match(html.graft, /<select[^>]*id="skill-add-to"/);
  });
  check("a skill no longer on this computer says so", () => {
    assert.match(text(html.gone), /no longer on this computer/);
  });
});
// --- Task 9: Training ---
sections.push(() => {
  const held = CHANGES.find((c) => c.change_id === "ch-held");
  // Fix round 1 (task 9) #6: a revoked computer must say why its rebuild button is off, and must
  // never offer "ask now" (asking is not actually possible once access is revoked).
  const REVOKED_COMPUTER = { ...COMPUTER, revoked: true };
  // Fix round 1 (task 9) #6: a held change with nothing to edit must say why "Edit change" is off.
  const NO_OPS_CHANGE = { ...held!, change_id: "ch-held-noops", ops: [] };
  const html = render([
    { id: "training", component: "TrainingView", props: { lib: LIB, computer: COMPUTER, changes: CHANGES, nowIso: NOW, rebuildBusy: false } },
    { id: "empty", component: "TrainingView", props: { lib: LIB, computer: COMPUTER, changes: [], nowIso: NOW, rebuildBusy: false } },
    // Ruling D10: HeldChange is tested directly here (not only through TrainingView), so it must
    // carry computerName itself rather than relying on the parent to resolve a display name.
    { id: "held", component: "HeldChange", props: { change: held, lib: LIB, computerId: COMPUTER.id, computerName: COMPUTER.display_name } },
    { id: "revoked", component: "TrainingView", props: { lib: LIB, computer: REVOKED_COMPUTER, changes: CHANGES, nowIso: NOW, rebuildBusy: false } },
    { id: "noops", component: "HeldChange", props: { change: NO_OPS_CHANGE, lib: LIB, computerId: COMPUTER.id, computerName: COMPUTER.display_name } },
  ]);
  check("misses read not checked yet, never zero", () => {
    const t = text(html.training);
    assert.match(t, /Misses to fix/);
    assert.match(t, /not checked yet/i);
    assert.doesNotMatch(t, /\b0 misses\b/i);
    assert.match(text(html.empty), /not checked yet/i);
  });
  check("a held change shows who, how many got worse and better, and totals worst first", () => {
    const t = text(html.held);
    assert.match(t, /Outreach scripts/);
    assert.match(t, /By apex/);
    assert.match(t, /1 got worse/);
    assert.match(t, /1 got better/);
    assert.ok(t.indexOf("Sell, price and pitch") < t.indexOf("Plan a new feature"));
    assert.match(html.held, /<table/);
    assert.match(html.held, /<th[^>]*scope="col"[^>]*>Before/);
  });
  check("D10: a held change also names which computer it is for", () => {
    const t = text(html.held);
    assert.match(t, /Adon's PC/);
    // Still through TrainingView's own resolution (computer.display_name), not just the direct prop.
    assert.match(text(html.training), /Adon's PC/);
  });
  check("Accept anyway is off and says why", () => {
    assert.match(html.held, /<button[^>]*disabled=""[^>]*aria-describedby="proof-ch-held"[^>]*>Accept anyway/);
    assert.match(html.held, /id="proof-ch-held"[^>]*>[^<]*not uploaded yet/);
  });
  check("did not go live, queued and applied sections show only this computer's changes", () => {
    const t = text(html.training);
    assert.match(t, /Did not go live .*Put tanstack-table in Charts .*the router build refused it/);
    assert.match(t, /Queued for tonight's check .*Put graft in Fix something broken as use first/);
    assert.match(t, /Applied this week .*Speed up a slow query/);
    assert.doesNotMatch(t, /Someone else's change/);
    assert.doesNotMatch(t, /An old change/);
  });
  check("nothing held reads as a clear all-good line", () => {
    assert.match(text(html.empty), /Nothing is held/);
  });
  check("fix round 1 (task 9) #6: a revoked computer's rebuild button states why, never offering to ask now", () => {
    const t = text(html.revoked);
    assert.match(t, /revoked/i);
    assert.doesNotMatch(t, /or now if you ask/);
    assert.match(html.revoked, /<button[^>]*disabled=""[^>]*aria-describedby="rebuild-reason-pc-66997cf1"[^>]*>/);
    assert.match(html.revoked, /id="rebuild-reason-pc-66997cf1"[^>]*>[^<]*revoked/i);
  });
  check("fix round 1 (task 9) #6: Edit change states why it is off when there is nothing to edit", () => {
    assert.match(html.noops, /<button[^>]*disabled=""[^>]*aria-describedby="edit-reason-ch-held-noops"[^>]*>Edit change/);
    assert.match(text(html.noops), /nothing to edit/i);
  });
  check("fix round 1 (task 9) #7: the status live region is always present, not mounted only while busy", () => {
    assert.match(html.held, /role="status"/);
  });
  check("fix round 1 (task 9) #8: the held count badge carries hidden context for screen readers", () => {
    assert.match(html.training, /class="sr-only"[^>]*> waiting for you/);
    assert.match(text(html.training), /Held for you 1/);
  });
});
// (later tasks push more sections here)

console.log("skills-tab-render:");
for (const s of sections) s();
console.log(`skills-tab-render: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
