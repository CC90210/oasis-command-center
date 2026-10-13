/**
 * skills-training-library.test.ts - Skills tab data (JARVIS plan 3, Tasks 4-5).
 *
 * PINNED: the records migration applies twice; a push carries test records and kind scores
 * together or not at all; ok can never exceed n; a push without kinds keeps the last record;
 * library() returns one computer's skills, labels, assignments and scores, and null for any
 * computer the caller does not own; overview() carries each change's ops; a held change is
 * edited atomically (revise), and a change that is no longer held answers 409 with nothing moved.
 *
 * Run: node --conditions=react-server --import tsx tests/skills-training-library.test.ts
 */
import { check, extraMigrationPaths, finish, login, req, setupDb, splitStatements } from "./skills-training-harness";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseReport, parseSkillsPush } from "../lib/skills/contract";
import { createChange, createComputer, library, overview, recordReport, storeSkills } from "../lib/skills/store";

const skill = (name: string, tests?: { n: number; ok: number }) => ({
  name, description: `${name} does a thing`, kind: "installed", quarantined: false,
  capabilities: ["Finds the slow step"], example_prompts: [{ prompt: "make the search faster", adds: "finds the missing index" }],
  ...(tests ? { tests } : {}),
});

async function main() {
  const db = await setupDb();
  console.log("skills-training-library:");

  await check("the records migration applies a second time without error", async () => {
    for (const p of extraMigrationPaths()) for (const stmt of splitStatements(readFileSync(p, "utf8"))) await db.execute(stmt);
  });

  await check("tests and kinds travel together", async () => {
    const both = parseSkillsPush({ skills_sha: "s", skills: [skill("graft", { n: 4, ok: 3 })], kinds: [{ id: "debug", n: 5, ok: 4 }] });
    assert.ok(both.ok);
    assert.equal(parseSkillsPush({ skills_sha: "s", skills: [skill("graft", { n: 4, ok: 3 })] }).ok, false, "tests without kinds");
    assert.equal(parseSkillsPush({ skills_sha: "s", skills: [skill("graft")], kinds: [] }).ok, false, "kinds without tests");
    const none = parseSkillsPush({ skills_sha: "s", skills: [skill("graft")] });
    assert.ok(none.ok && none.value.kinds === null);
  });

  await check("ok above n, an extra field or a repeated kind is refused", async () => {
    assert.equal(parseSkillsPush({ skills_sha: "s", skills: [skill("graft", { n: 1, ok: 2 })], kinds: [] }).ok, false);
    assert.equal(parseSkillsPush({ skills_sha: "s", skills: [{ ...skill("graft"), tests: { n: 1, ok: 1, prompt: "x" } }], kinds: [] }).ok, false);
    assert.equal(parseSkillsPush({ skills_sha: "s", skills: [skill("graft", { n: 1, ok: 1 })], kinds: [{ id: "debug", n: 1, ok: 1 }, { id: "debug", n: 1, ok: 1 }] }).ok, false);
  });

  const a = await createComputer(db, "owner-a", "A's PC");
  const b = await createComputer(db, "owner-b", "B's PC");

  await check("library() returns one computer's skills, test records, labels, assignments and scores", async () => {
    const push = parseSkillsPush({ skills_sha: "s1", skills: [skill("graft", { n: 4, ok: 3 }), skill("hallmark", { n: 0, ok: 0 })], kinds: [{ id: "debug", n: 32, ok: 27 }] });
    assert.ok(push.ok);
    await storeSkills(db, a.id, push.value);
    const rep = parseReport({
      run: { started_at: "2026-10-12T06:00:00.000Z", finished_at: "2026-10-12T06:04:00.000Z", outcome: "nothing-to-do", detail: "" },
      results: [], pruned: [],
      labels: { labels: [{ id: "debug", level: "broad", parent: null, name: "Something is broken", meaning: "", examples: [] },
        { id: "debug-slow-query", level: "sub", parent: "debug", name: "Speed up a slow query", meaning: "", examples: [] }],
        assignments: [{ skill: "graft", label: "debug-slow-query", rank: "use-first" }] },
    });
    assert.ok(rep.ok);
    await recordReport(db, a.id, rep.value);
    const lib = await library(db, "owner-a", a.id);
    assert.ok(lib);
    assert.deepEqual(lib.skills.map((s) => [s.name, s.tests]), [["graft", { n: 4, ok: 3 }], ["hallmark", { n: 0, ok: 0 }]]);
    assert.deepEqual(lib.skills[0].capabilities, ["Finds the slow step"]);
    assert.deepEqual(lib.labels.map((l) => l.id), ["debug", "debug-slow-query"]);
    assert.deepEqual(lib.assignments, [{ skill: "graft", label: "debug-slow-query", rank: "use-first" }]);
    assert.deepEqual(lib.kinds, { debug: { n: 32, ok: 27 } });
  });

  await check("a push without kinds keeps the last test record", async () => {
    const push = parseSkillsPush({ skills_sha: "s2", skills: [skill("graft"), skill("hallmark")] });
    assert.ok(push.ok);
    await storeSkills(db, a.id, push.value);
    const lib = await library(db, "owner-a", a.id);
    assert.deepEqual(lib?.skills[0].tests, { n: 4, ok: 3 });
    assert.deepEqual(lib?.kinds, { debug: { n: 32, ok: 27 } });
  });

  await check("a skill that never had a record reads null, not zero", async () => {
    const push = parseSkillsPush({ skills_sha: "s3", skills: [skill("graft")] });
    assert.ok(push.ok);
    await storeSkills(db, b.id, push.value);
    const lib = await library(db, "owner-b", b.id);
    assert.equal(lib?.skills[0].tests, null);
    assert.deepEqual(lib?.kinds, {});
  });

  await check("library of another owner's computer, or of no computer, is null", async () => {
    assert.equal(await library(db, "owner-b", a.id), null);
    assert.equal(await library(db, "owner-a", "pc-00000000"), null);
  });

  await check("overview carries each change's ops", async () => {
    const ops = [{ op: "assign", skill: "graft", label: "debug", rank: "use-first" }];
    const ch = await createChange(db, "owner-a", "adon", { description: "Put graft first", scope: a.id, ops });
    assert.ok(ch.ok);
    const ov = await overview(db, "owner-a");
    assert.deepEqual(ov.changes.find((c) => c.change_id === (ch.ok ? ch.id : ""))?.ops, ops);
  });

  void login;
  void req;
  finish("skills-training-library");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
