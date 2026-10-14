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
import { POST as createComputerRoute } from "../app/api/skills/computers/route";
import { POST as createChangeRoute } from "../app/api/skills/changes/route";
import { POST as reviseRoute } from "../app/api/skills/changes/[id]/revise/route";
import { parseReport, parseSkillsPush } from "../lib/skills/contract";
import { createChange, createComputer, library, overview, recordReport, revokeComputer, skillsPageData, storeSkills } from "../lib/skills/store";

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
  // owner-a's SECOND computer, not primary. Created here (not inline in the records_at check
  // below) so it is also in scope for the skillsPageData check further down.
  const rc = await createComputer(db, "owner-a", "Records PC");

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

  await check("records_at is the latest kind-score update: null before kinds, a timestamp after, unchanged without kinds", async () => {
    assert.equal((await library(db, "owner-a", rc.id))?.records_at, null);
    const withKinds = parseSkillsPush({ skills_sha: "r1", skills: [skill("graft", { n: 1, ok: 1 })], kinds: [{ id: "debug", n: 1, ok: 1 }] });
    assert.ok(withKinds.ok);
    await storeSkills(db, rc.id, withKinds.value);
    const after = await library(db, "owner-a", rc.id);
    assert.equal(typeof after?.records_at, "string");
    const fixedStamp = "2020-01-01T00:00:00.000Z";
    await db.execute({ sql: "UPDATE skills_kind_score SET updated_at = ? WHERE computer_id = ?", args: [fixedStamp, rc.id] });
    const withoutKinds = parseSkillsPush({ skills_sha: "r2", skills: [skill("graft")] });
    assert.ok(withoutKinds.ok);
    await storeSkills(db, rc.id, withoutKinds.value);
    assert.equal((await library(db, "owner-a", rc.id))?.records_at, fixedStamp);
  });

  await check("overview carries each change's ops", async () => {
    const ops = [{ op: "assign", skill: "graft", label: "debug", rank: "use-first" }];
    const ch = await createChange(db, "owner-a", "adon", { description: "Put graft first", scope: a.id, ops });
    assert.ok(ch.ok);
    const ov = await overview(db, "owner-a");
    assert.deepEqual(ov.changes.find((c) => c.change_id === (ch.ok ? ch.id : ""))?.ops, ops);
  });

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const asJson = async (r: Response) => (await r.json()) as Record<string, unknown>;
  await login("adon");
  const pc = await asJson(await createComputerRoute(req("/api/skills/computers", { method: "POST", body: { display_name: "Adon's PC" } })));
  const ops = [
    { op: "add-sub", id: "sales-offer-outreach-script", parent: "sales-offer", name: "Outreach scripts", meaning: "write a cold email or call script", phrasings: ["cold email"], keywords: ["outreach"], examples: ["write a cold email"] },
    { op: "assign", skill: "storybrand", label: "sales-offer-outreach-script", rank: "also-helps" },
  ];
  const queued = await asJson(await createChangeRoute(req("/api/skills/changes", { method: "POST", body: { description: "Outreach scripts", scope: pc.id, ops } })));
  await db.execute({ sql: "UPDATE skills_change_status SET status = 'held' WHERE change_id = ?", args: [String(queued.id)] });
  const reviseReq = (body: unknown, headers?: Record<string, string>) =>
    reviseRoute(req(`/api/skills/changes/${queued.id}/revise`, { method: "POST", body, headers }), params(String(queued.id)));

  await check("revise refuses a cross-origin write, an extra field and an empty change", async () => {
    assert.equal((await reviseReq({ computer_id: pc.id, description: "x", ops: ops.slice(0, 1) }, { origin: "https://evil.test" })).status, 403);
    assert.equal((await reviseReq({ computer_id: pc.id, description: "x", ops: ops.slice(0, 1), note: "hi" })).status, 400);
    const before = await db.execute("SELECT COUNT(*) AS n FROM skills_change");
    assert.equal((await reviseReq({ computer_id: pc.id, description: "x", ops: [] })).status, 400);
    const after = await db.execute("SELECT COUNT(*) AS n FROM skills_change");
    assert.equal(Number(after.rows[0].n), Number(before.rows[0].n), "an empty change must queue nothing");
    const st = await db.execute({ sql: "SELECT status FROM skills_change_status WHERE change_id = ?", args: [String(queued.id)] });
    assert.equal(String(st.rows[0].status), "held", "the held row must stay held");
  });

  await check("another founder gets 404 and nothing moves", async () => {
    const before = await db.execute("SELECT COUNT(*) AS n FROM skills_change");
    await login("cc");
    assert.equal((await reviseReq({ computer_id: pc.id, description: "x", ops: ops.slice(0, 1) })).status, 404);
    await login("adon");
    const st = await db.execute({ sql: "SELECT status FROM skills_change_status WHERE change_id = ?", args: [String(queued.id)] });
    assert.equal(String(st.rows[0].status), "held");
    const after = await db.execute("SELECT COUNT(*) AS n FROM skills_change");
    assert.equal(Number(after.rows[0].n), Number(before.rows[0].n));
  });

  await check("revise rejects the held change and queues the edited ops, atomically", async () => {
    const r = await reviseReq({ computer_id: pc.id, description: "Outreach scripts (edited)", ops: ops.slice(0, 1) });
    assert.equal(r.status, 201);
    const out = await asJson(r);
    const old = await db.execute({ sql: "SELECT status, reason FROM skills_change_status WHERE change_id = ?", args: [String(queued.id)] });
    assert.equal(String(old.rows[0].status), "rejected");
    assert.equal(String(old.rows[0].reason), `edited into ${out.id}`);
    const fresh = await db.execute({ sql: "SELECT c.ops_json, c.scope, s.status FROM skills_change c JOIN skills_change_status s ON s.change_id = c.id WHERE c.id = ?", args: [String(out.id)] });
    assert.equal(String(fresh.rows[0].status), "waiting");
    assert.equal(String(fresh.rows[0].scope), String(pc.id));
    assert.deepEqual(JSON.parse(String(fresh.rows[0].ops_json)), ops.slice(0, 1));
  });

  await check("a change that is no longer held answers 409 and nothing moves", async () => {
    const before = await db.execute("SELECT COUNT(*) AS n FROM skills_change");
    const r = await reviseReq({ computer_id: pc.id, description: "again", ops: ops.slice(0, 1) });
    assert.equal(r.status, 409);
    const after = await db.execute("SELECT COUNT(*) AS n FROM skills_change");
    assert.equal(Number(after.rows[0].n), Number(before.rows[0].n));
  });

  await check("the page never shows another owner's computer", async () => {
    // owner-a has TWO computers: `a` (primary) and `rc` (not primary). An explicit `asked` match
    // returns exactly that computer, even when it is not the primary one.
    const askedRc = await skillsPageData(db, "owner-a", rc.id);
    assert.equal(askedRc.computer?.id, rc.id);
    // No `asked` at all falls back to the primary.
    const askedNothing = await skillsPageData(db, "owner-a");
    assert.equal(askedNothing.computer?.id, a.id);
    // Asking for someone ELSE's computer id falls back to the caller's OWN primary, never to that
    // computer, and the caller's own computer/change lists carry none of the other owner's data.
    const asksForA = await skillsPageData(db, "owner-b", a.id);
    assert.equal(asksForA.computer?.id, b.id);
    assert.ok(asksForA.computers.every((c) => c.id !== a.id));
    assert.ok(asksForA.changes.every((c) => c.computer_id !== a.id), "must carry none of owner-a's changes");
    const nothing = await skillsPageData(db, "owner-nobody", a.id);
    assert.equal(nothing.computer, null);
    assert.equal(nothing.lib, null);
  });

  await check("with no primary computer, the fallback never silently picks a revoked one", async () => {
    const x1 = await createComputer(db, "owner-x", "X1 (will be revoked)");
    const x2 = await createComputer(db, "owner-x", "X2");
    assert.ok(await revokeComputer(db, "owner-x", x1.id));
    // createComputer always makes the FIRST computer for an owner primary, and revoking never
    // clears that flag - so "no primary computer" is a state the admin API cannot itself reach.
    // It is still a state the store must answer safely (a stray row, a future bulk edit), the one
    // case this check exercises directly.
    await db.execute({ sql: "UPDATE skills_computer SET is_primary = 0 WHERE owner_user_id = ?", args: ["owner-x"] });
    const data = await skillsPageData(db, "owner-x");
    assert.equal(data.computer?.id, x2.id, "a revoked computer must never be the silent default");
  });

  // Final fix round, item (b): the actually-reachable case - revokeComputer never clears
  // is_primary, so a revoked computer that WAS primary stays flagged primary forever. The old
  // fallback chain tried `.find(c => c.primary)` BEFORE it ever checked `!c.revoked`, so that
  // revoked-but-still-primary row won the fallback and the page opened on stale, disabled data.
  await check("a revoked PRIMARY computer is never the default; an explicit ask for it by id still works", async () => {
    const y1 = await createComputer(db, "owner-y", "Y1 (primary, will be revoked)");
    const y2 = await createComputer(db, "owner-y", "Y2 (active, not primary)");
    // Force y1 to actually be the primary: createComputer's "first computer is primary" rule
    // checks for ANY existing primary row rather than scoping to this owner, so which computer
    // lands primary can depend on what earlier checks in this file already created. Forcing it
    // here makes this check exercise the real shape every time, regardless of ordering.
    await db.execute({ sql: "UPDATE skills_computer SET is_primary = 0 WHERE owner_user_id = ?", args: ["owner-y"] });
    await db.execute({ sql: "UPDATE skills_computer SET is_primary = 1 WHERE id = ?", args: [y1.id] });
    assert.ok(await revokeComputer(db, "owner-y", y1.id));
    const data = await skillsPageData(db, "owner-y");
    assert.equal(data.computer?.id, y2.id, "the active non-primary computer must be the default, not the revoked primary");
    assert.equal(data.computer?.revoked, false);
    const asked = await skillsPageData(db, "owner-y", y1.id);
    assert.equal(asked.computer?.id, y1.id, "an explicit ask for the revoked computer by id must still return it");
  });

  finish("skills-training-library");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
