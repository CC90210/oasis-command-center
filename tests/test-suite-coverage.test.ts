/**
 * tests/test-suite-coverage.test.ts — every test file in tests/ is run by CI,
 * or is on the EXCLUDED list below with the reason it is not.
 *
 * WHY THIS EXISTS (F0 release gate, 2026-09-29)
 * ---------------------------------------------
 * 54 tests/*.test.ts files were named by no npm script and no suite runner,
 * and six more sat in package.json groups that ci.yml never runs. Among them
 * were the OS connections suite and four Phase-0 security tests written the
 * day before. Suite membership is explicit on purpose (tests/_suite.mjs says
 * why: a glob would adopt a file that needs credentials or a live database),
 * so every new file has to be registered by hand, and nothing noticed when one
 * was not. This test turns "never registered" into a red build.
 *
 * WHAT COUNTS AS RUN
 * ------------------
 * Only what CI reaches. ci.yml runs `npm run test:<group>`; the group's
 * package.json command names the file directly, or names a runner under
 * tests/ whose TESTS list names it. A package.json group CI does not run does
 * not count, and neither does a commented-out list entry. A registration that
 * points at a file that does not exist fails too: it reads as coverage and
 * runs nothing.
 *
 * EXCLUDING A FILE
 * ----------------
 * Add it to EXCLUDED with the reason. An exclusion is for a test that exposes
 * a real product bug nobody has fixed yet, or one that cannot run in CI. When
 * the file is registered, the exclusion must go: an exclusion for a covered
 * file fails here, so the list cannot quietly outlive its reasons.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "..");

// ── The explicit exclusions, each with its reason ─────────────────────────
const EXCLUDED: Record<string, string> = {
  // PRODUCT BUG, not a stale test. recordDnsVerification() in
  // lib/client-automation-profiles.ts stores any verifiedAt string it is given;
  // only the database CHECK from migration 150 refuses a note such as "no", so
  // the operator is shown a raw SQLITE_CONSTRAINT message instead of the app's
  // "is not a verification time". It also tells an operator that a profile
  // with no reply identity mode (a pre-149 row) "is on null, which sends from
  // an OASIS-owned domain", which is false. The test pins both; fixing them is
  // product work outside the release gate.
  "tests/client-automation-lifecycle.test.ts":
    "exposes two unfixed product bugs in recordDnsVerification (no app-side ISO-8601 check before the DB constraint; a false 'OASIS-owned' message for a profile with no mode)",
};

// ── The rules, as a pure function over the three sources ──────────────────
type Sources = {
  ciYaml: string;
  scripts: Record<string, string>;
  /** Text of a runner file under tests/, or null when it does not exist. */
  readRunner: (file: string) => string | null;
  testFiles: string[];
  exists: (file: string) => boolean;
  excluded: Record<string, string>;
};

type Coverage = {
  ciGroups: string[];
  unknownGroups: string[];
  unreadableRunners: string[];
  covered: Set<string>;
  missing: string[];
  orphans: string[];
  staleExclusions: string[];
  unexplainedExclusions: string[];
};

const TEST_FILE = /\.test\.(?:ts|mts|mjs)$/;
const PATH_TOKEN = /(?<![\w/.-])tests\/[\w./@[\]-]+\.(?:ts|mts|mjs)\b/g;

/**
 * Groups the CI workflow runs: `npm run test:*` inside a step's `run:` value
 * only. A step `name:` or a comment that mentions a group runs nothing, so it
 * must not count. `run:` is either inline or a block scalar (`|` / `>`) whose
 * body is every following line indented deeper than the key.
 */
function ciTestGroups(ciYaml: string): string[] {
  const groups: string[] = [];
  const collect = (command: string) => {
    const code = command.trim();
    if (!code || code.startsWith("#")) return;
    for (const m of code.matchAll(/(?:^|[\s;&|(])npm run (test:[\w:-]+)/g)) groups.push(m[1]);
  };
  let blockIndent: number | null = null;
  for (const line of ciYaml.split(/\r?\n/)) {
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null) {
      if (!line.trim() || indent > blockIndent) {
        collect(line);
        continue;
      }
      blockIndent = null;
    }
    const run = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(line);
    if (!run) continue;
    const value = run[2].trim();
    if (/^[|>][+-]?$/.test(value)) blockIndent = run[1].length;
    else collect(value);
  }
  return groups;
}

/** Every test file under <repoRoot>/tests, at any depth, as "tests/..." paths. */
function listTestFiles(repoRoot: string): string[] {
  const found: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(repoRoot, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) walk(child);
      } else if (TEST_FILE.test(entry.name)) {
        found.push(child);
      }
    }
  };
  walk("tests");
  return found.sort();
}

/** The string entries of a runner's `const TESTS = [ ... ];`, comments skipped. */
function runnerEntries(text: string): string[] | null {
  const block = /const TESTS = \[([\s\S]*?)\n\];/.exec(text);
  if (!block) return null;
  const entries: string[] = [];
  for (const line of block[1].split(/\r?\n/)) {
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*")) continue;
    for (const m of code.matchAll(/"([^"]+)"/g)) entries.push(m[1]);
  }
  return entries;
}

function coverage(src: Sources): Coverage {
  const ciGroups = ciTestGroups(src.ciYaml);
  const unknownGroups = ciGroups.filter((g) => !(g in src.scripts));
  const unreadableRunners: string[] = [];
  const named = new Set<string>();

  const seen = new Set<string>();
  const expand = (group: string) => {
    if (seen.has(group) || !(group in src.scripts)) return;
    seen.add(group);
    const command = src.scripts[group];
    for (const m of command.matchAll(/npm run ([\w:-]+)/g)) expand(m[1]);
    for (const token of command.match(PATH_TOKEN) || []) {
      if (TEST_FILE.test(token)) {
        named.add(token);
        continue;
      }
      // Anything else under tests/ that a group invokes is a runner.
      const text = src.readRunner(token);
      const entries = text === null ? null : runnerEntries(text);
      if (!entries) unreadableRunners.push(token);
      else for (const e of entries) named.add(e);
    }
  };
  for (const g of ciGroups) expand(g);

  const missing = [...named].filter((f) => !src.exists(f)).sort();
  const covered = new Set([...named].filter((f) => src.exists(f)));
  const orphans = src.testFiles.filter((f) => !covered.has(f) && !(f in src.excluded)).sort();
  const staleExclusions = Object.keys(src.excluded)
    .filter((f) => covered.has(f) || !src.exists(f))
    .sort();
  const unexplainedExclusions = Object.entries(src.excluded)
    .filter(([, reason]) => reason.trim().length < 20)
    .map(([f]) => f)
    .sort();
  return { ciGroups, unknownGroups, unreadableRunners, covered, missing, orphans, staleExclusions, unexplainedExclusions };
}

// ── The rules catch what they claim to (synthetic sources) ────────────────
{
  const runner = [
    "const TESTS = [",
    '  "tests/in-runner.test.ts",',
    '  // "tests/commented-out.test.ts",',
    '  "tests/points-at-nothing.test.ts",',
    "];",
  ].join("\n");
  const files = new Set([
    "tests/direct.test.ts",
    "tests/in-runner.test.ts",
    "tests/commented-out.test.ts",
    "tests/in-unrun-group.test.ts",
    "tests/in-commented-ci-line.test.ts",
    "tests/nowhere.test.ts",
    "tests/excluded.test.ts",
    "tests/wrongly-excluded.test.ts",
  ]);
  const base: Sources = {
    ciYaml: [
      "      - run: npm run typecheck",
      "      - name: npm run test:unrun",
      "        run: echo a step name runs nothing",
      "      - name: Tests",
      "        env:",
      "          NODE_OPTIONS: --conditions=react-server",
      "        run: |",
      "          npm run test:a",
      "          # npm run test:commented",
      "",
      "          npm run test:runner",
      "      - name: after the block, npm run test:unrun is prose again",
      "        run: echo done",
    ].join("\n"),
    scripts: {
      "test:a": "node --import tsx tests/direct.test.ts && node --import tsx tests/wrongly-excluded.test.ts",
      "test:runner": "node tests/_runner.mjs",
      "test:unrun": "node --import tsx tests/in-unrun-group.test.ts",
      "test:commented": "node --import tsx tests/in-commented-ci-line.test.ts",
    },
    readRunner: (f) => (f === "tests/_runner.mjs" ? runner : null),
    testFiles: [...files],
    exists: (f) => files.has(f) || f === "tests/_runner.mjs",
    excluded: {
      "tests/excluded.test.ts": "a reason long enough to mean something",
      "tests/wrongly-excluded.test.ts": "a reason long enough to mean something",
    },
  };
  const c = coverage(base);
  assert.deepEqual(
    c.ciGroups,
    ["test:a", "test:runner"],
    "only `run:` values count: not a step name, not a shell comment, not text after the block ends",
  );
  assert.ok(c.covered.has("tests/direct.test.ts"), "named by a group CI runs");
  assert.ok(c.covered.has("tests/in-runner.test.ts"), "named by a runner a CI group invokes");
  assert.deepEqual(
    c.orphans,
    [
      "tests/commented-out.test.ts",
      "tests/in-commented-ci-line.test.ts",
      "tests/in-unrun-group.test.ts",
      "tests/nowhere.test.ts",
    ],
    "a commented entry, a group CI does not run, and no registration at all are all orphans",
  );
  assert.deepEqual(c.missing, ["tests/points-at-nothing.test.ts"], "a registration for a file that does not exist is caught");
  assert.deepEqual(c.staleExclusions, ["tests/wrongly-excluded.test.ts"], "an exclusion for a covered file must be removed");
  assert.deepEqual(c.unexplainedExclusions, [], "both reasons are real sentences");

  const lazy = coverage({ ...base, excluded: { "tests/nowhere.test.ts": "flaky" } });
  assert.deepEqual(lazy.unexplainedExclusions, ["tests/nowhere.test.ts"], "an exclusion needs a reason, not a word");
  const gone = coverage({ ...base, excluded: { "tests/deleted.test.ts": "a reason long enough to mean something" } });
  assert.deepEqual(gone.staleExclusions, ["tests/deleted.test.ts"], "an exclusion for a deleted file must be removed");
  const typo = coverage({ ...base, ciYaml: "      - run: npm run test:nope" });
  assert.deepEqual(typo.unknownGroups, ["test:nope"], "CI running a group package.json lacks is caught");
  const noRunner = coverage({ ...base, readRunner: () => null });
  assert.deepEqual(noRunner.unreadableRunners, ["tests/_runner.mjs"], "a runner with no readable TESTS list is caught, not read as empty");

  // Discovery walks subdirectories: a nested test nobody registered is still
  // found, and paths come back repository-relative with forward slashes.
  const scratch = mkdtempSync(path.join(tmpdir(), "suite-coverage-"));
  try {
    mkdirSync(path.join(scratch, "tests", "security", "deep"), { recursive: true });
    writeFileSync(path.join(scratch, "tests", "top.test.ts"), "");
    writeFileSync(path.join(scratch, "tests", "security", "deep", "nested.test.mts"), "");
    writeFileSync(path.join(scratch, "tests", "security", "helper.ts"), "");
    assert.deepEqual(
      listTestFiles(scratch),
      ["tests/security/deep/nested.test.mts", "tests/top.test.ts"],
      "nested test files are discovered; helpers are not",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── This repository ───────────────────────────────────────────────────────
{
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const c = coverage({
    ciYaml: readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"),
    scripts: pkg.scripts,
    readRunner: (f) => (existsSync(path.join(root, f)) ? readFileSync(path.join(root, f), "utf8") : null),
    testFiles: listTestFiles(root),
    exists: (f) => existsSync(path.join(root, f)),
    excluded: EXCLUDED,
  });

  // Fail closed: if ci.yml stops parsing, everything would look orphaned or,
  // worse, the checks below would pass over an empty set.
  assert.ok(c.ciGroups.length >= 10, `ci.yml's Tests step names ${c.ciGroups.length} test groups; expected the full list`);
  assert.ok(c.covered.size >= 400, `only ${c.covered.size} test files reached; the parser has lost a suite`);
  assert.ok(c.covered.has("tests/test-suite-coverage.test.ts"), "this gate must itself run in CI");

  const fix =
    "Register it in a suite CI runs (tests/_suite.mjs, tests/_suite-web-leads.mjs, or a package.json " +
    "test: group named in .github/workflows/ci.yml), or add it to EXCLUDED in this file with the reason.";
  assert.deepEqual(c.unknownGroups, [], `ci.yml runs groups package.json does not define: ${c.unknownGroups.join(", ")}`);
  assert.deepEqual(c.unreadableRunners, [], `runners with no readable TESTS list: ${c.unreadableRunners.join(", ")}`);
  assert.deepEqual(c.missing, [], `registered but missing, so they run nothing:\n  ${c.missing.join("\n  ")}`);
  assert.deepEqual(c.orphans, [], `test files CI never runs:\n  ${c.orphans.join("\n  ")}\n${fix}`);
  assert.deepEqual(c.staleExclusions, [], `EXCLUDED entries that are now covered or deleted; remove them:\n  ${c.staleExclusions.join("\n  ")}`);
  assert.deepEqual(c.unexplainedExclusions, [], `EXCLUDED entries without a reason: ${c.unexplainedExclusions.join(", ")}`);

  console.log(
    `test-suite-coverage: ${c.covered.size} files reached from ${c.ciGroups.length} CI groups; ` +
      `${Object.keys(EXCLUDED).length} excluded with a reason`,
  );
}
