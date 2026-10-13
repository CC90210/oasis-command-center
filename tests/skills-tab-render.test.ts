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

// --- Task 7: Library ---
sections.push(() => {
  const html = render([
    { id: "tiles", component: "LibraryView", props: { lib: LIB, group: null } },
    { id: "group", component: "LibraryView", props: { lib: LIB, group: "debug" } },
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
  });
  check("a kind of work opens to its chips and its skills, use-first first", () => {
    const t = text(html.group);
    assert.match(t, /All kinds of work/);
    assert.match(html.group, /role="group" aria-label="Filter by sub-label"/);
    assert.ok(t.indexOf("graft") < t.indexOf("turso-cloud"));
    assert.match(t, /turso-cloud Also helps .* Not tested/);
  });
  check("numbers are tabular", () => {
    assert.match(html.tiles, /tabular-nums/);
  });
});
// (later tasks push more sections here)

console.log("skills-tab-render:");
for (const s of sections) s();
console.log(`skills-tab-render: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
