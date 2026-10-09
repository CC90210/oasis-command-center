/**
 * skills-training-store.test.ts - the Skills Training storage (JARVIS plan 2, Task 6).
 *
 * PINNED: the migration applies twice cleanly; every contract parser refuses unknown fields,
 * file paths, oversize text and illegal status moves; a check-in key exists only as a hash; the
 * first computer is primary; only the primary computer's owner queues a shared change; a
 * report moves a status only if it is still what the PC pulled (a decision Adon made in the
 * meantime wins); a rebuild requested after the run started survives the report; a prune is
 * recorded as an applied system change; the overview never shows another owner's computer.
 *
 * Run: node --conditions=react-server --import tsx tests/skills-training-store.test.ts
 */
import { check, finish, migrationPath, setupDb, splitStatements, USERS } from "./skills-training-harness";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sha256 } from "../lib/api-helpers";
import { parseNewChange, parseOps, parseReport, parseSkillsPush } from "../lib/skills/contract";
import {
  createChange, createComputer, decide, overview, pendingChanges, pollState, recordReport,
  requestRebuild, revokeComputer, storeSkills,
} from "../lib/skills/store";

const skill = (over: Record<string, unknown> = {}) => ({
  name: "graft", description: "Find code by structure.", kind: "installed", quarantined: false,
  capabilities: [], example_prompts: [], ...over,
});
const run = (over: Record<string, unknown> = {}) => ({
  started_at: "2026-10-09T06:00:00.000Z", finished_at: "2026-10-09T06:40:00.000Z", outcome: "applied", detail: "", ...over,
});
const labels = { labels: [{ id: "debug", level: "broad", parent: null, name: "Fix something broken", meaning: "", examples: [] }],
  assignments: [{ skill: "graft", label: "debug", rank: "use-first" }] };
const result = (over: Record<string, unknown>) => ({
  change_id: "x", pulled_status: "waiting", status: "applied", reason: "", worse: 0, better: 0, totals: {}, ...over,
});
const report = (over: Record<string, unknown> = {}) => {
  const p = parseReport({ run: run(), results: [], pruned: [], labels, ...over });
  if (!p.ok) throw new Error(p.error);
  return p.value;
};

async function main() {
  const db = await setupDb();
  console.log("skills-training-store:");

  await check("the migration applies a second time without error (IF NOT EXISTS)", async () => {
    for (const stmt of splitStatements(readFileSync(migrationPath(), "utf8"))) await db.execute(stmt);
  });

  await check("the skill list refuses unknown fields, paths, oversize text and duplicates", () => {
    assert.equal(parseSkillsPush({ skills_sha: "a", skills: [skill()] }).ok, true);
    assert.equal(parseSkillsPush({ skills_sha: "a", skills: [skill({ path: "x" })] }).ok, false);
    assert.equal(parseSkillsPush({ skills_sha: "a", skills: [skill({ description: "see C:/Users/echel/x" })] }).ok, false);
    assert.equal(parseSkillsPush({ skills_sha: "a", skills: [skill({ description: "see https://example.com/a" })] }).ok, true);
    assert.equal(parseSkillsPush({ skills_sha: "a", skills: [skill({ description: "x".repeat(1201) })] }).ok, false);
    assert.equal(parseSkillsPush({ skills_sha: "a", skills: [skill(), skill()] }).ok, false);
    assert.equal(parseSkillsPush({ skills_sha: "a", skills: [], prompt: "hi" }).ok, false);
  });

  await check("ops are exactly the PC's labels_ops shapes", () => {
    assert.equal(parseOps([{ op: "assign", skill: "graft", label: "debug", rank: "use-first" }]).ok, true);
    assert.equal(parseOps([{ op: "assign", skill: "graft", label: "debug", rank: "maybe" }]).ok, false);
    assert.equal(parseOps([{ op: "explode" }]).ok, false);
    assert.equal(parseOps([{ op: "unassign", skill: "graft" }]).ok, false);
    assert.equal(parseOps([{ op: "rename", id: "Debug Thing", name: "n" }]).ok, false);
    assert.equal(parseNewChange({ description: "d", scope: "shared", ops: [] }).ok, false);
  });

  await check("a report refuses an illegal status move and a non-ISO time", () => {
    assert.equal(parseReport({ run: run(), results: [result({ pulled_status: "accepted-anyway", status: "held" })], pruned: [], labels }).ok, false);
    assert.equal(parseReport({ run: run(), results: [result({ pulled_status: "held", status: "applied" })], pruned: [], labels }).ok, false);
    assert.equal(parseReport({ run: run({ started_at: "yesterday" }), results: [], pruned: [], labels }).ok, false);
    assert.equal(parseReport({ run: run(), results: [result({ prompt: "raw text" })], pruned: [], labels }).ok, false);
  });

  const adonPc = await createComputer(db, USERS.adon.id, "Adon's PC");
  const ccPc = await createComputer(db, USERS.cc.id, "CC's PC");

  await check("a key exists only as its hash, and the first computer is primary", async () => {
    const rows = (await db.execute("SELECT * FROM skills_computer")).rows;
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes(adonPc.key) && !dump.includes(ccPc.key));
    const a = rows.find((r) => r.id === adonPc.id)!;
    assert.equal(a.key_hash, sha256(adonPc.key));
    assert.equal(Number(a.is_primary), 1);
    assert.equal(Number(rows.find((r) => r.id === ccPc.id)!.is_primary), 0);
    assert.match(adonPc.key, /^skc_pc-[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
  });

  await check("only the primary computer's owner queues a shared change; an owner may scope one to their own computer", async () => {
    const ops = [{ op: "assign", skill: "graft", label: "debug", rank: "use-first" }];
    assert.deepEqual(await createChange(db, USERS.cc.id, "cc", { description: "d", scope: "shared", ops }), { ok: false, error: "not_allowed" });
    assert.deepEqual(await createChange(db, USERS.cc.id, "cc", { description: "d", scope: adonPc.id, ops }), { ok: false, error: "not_allowed" });
    const mine = await createChange(db, USERS.cc.id, "cc", { description: "cc only", scope: ccPc.id, ops });
    assert.equal(mine.ok, true);
    const shared = await createChange(db, USERS.adon.id, "adon", { description: "shared", scope: "shared", ops });
    assert.equal(shared.ok, true);
    assert.deepEqual((await pendingChanges(db, adonPc.id)).map((c) => c.description), ["shared"]);
    assert.deepEqual((await pendingChanges(db, ccPc.id)).map((c) => c.description), ["cc only", "shared"]);
    assert.deepEqual(await pollState(db, adonPc.id), { rebuild_requested: false, pending: 1 });
  });

  await check("a report moves a status only if it is still what the PC pulled", async () => {
    const [ch] = await pendingChanges(db, adonPc.id);
    const first = await recordReport(db, adonPc.id, report({ results: [result({ change_id: ch.id, status: "held", worse: 2 })] }));
    assert.deepEqual(first, { updated: 1, skipped: 0 });
    assert.equal(await decide(db, USERS.adon.id, "adon", ch.id, adonPc.id, "accept-anyway"), "ok");
    // the PC re-sends its old report (outbox) after Adon decided: his decision wins
    const resent = await recordReport(db, adonPc.id, report({ results: [result({ change_id: ch.id, status: "held", worse: 2 })] }));
    assert.deepEqual(resent, { updated: 0, skipped: 1 });
    const row = (await db.execute({ sql: "SELECT status, decided_by FROM skills_change_status WHERE change_id = ? AND computer_id = ?", args: [ch.id, adonPc.id] })).rows[0];
    assert.equal(row.status, "accepted-anyway");
    assert.equal(row.decided_by, "adon");
    assert.equal(await decide(db, USERS.adon.id, "adon", ch.id, adonPc.id, "reject"), "not_held");
  });

  await check("a rebuild asked for after the run started survives the report; one asked before is cleared", async () => {
    assert.equal(await requestRebuild(db, USERS.adon.id, adonPc.id), true);
    await db.execute({ sql: "UPDATE skills_computer SET rebuild_requested_at = ? WHERE id = ?", args: ["2026-10-09T06:10:00.000Z", adonPc.id] });
    await recordReport(db, adonPc.id, report());          // run started 06:00, request at 06:10
    assert.equal((await pollState(db, adonPc.id)).rebuild_requested, true);
    await db.execute({ sql: "UPDATE skills_computer SET rebuild_requested_at = ? WHERE id = ?", args: ["2026-10-09T05:59:00.000Z", adonPc.id] });
    await recordReport(db, adonPc.id, report());
    assert.equal((await pollState(db, adonPc.id)).rebuild_requested, false);
  });

  await check("a prune is recorded once as an applied system change, and the labels mirror is replaced", async () => {
    const pruned = [{ skill: "old-skill", label: "debug", why: "not installed on this computer" }];
    await recordReport(db, adonPc.id, report({ pruned }));
    await recordReport(db, adonPc.id, report({ pruned }));     // a re-sent report adds nothing
    const rows = (await db.execute({ sql: `SELECT c.author, s.status FROM skills_change c JOIN skills_change_status s ON s.change_id = c.id
                                            WHERE c.author = 'system' AND s.computer_id = ?`, args: [adonPc.id] })).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "applied");
    const mirror = (await db.execute({ sql: "SELECT skill, label_id, rank FROM skills_skill_label WHERE computer_id = ?", args: [adonPc.id] })).rows;
    assert.deepEqual(mirror.map((r) => [r.skill, r.label_id, r.rank]), [["graft", "debug", "use-first"]]);
    await recordReport(db, adonPc.id, report({ labels: null }));    // withheld snapshot: the mirror stays
    const kept = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM skills_skill_label WHERE computer_id = ?", args: [adonPc.id] })).rows[0];
    assert.equal(Number(kept.n), 1);
  });

  await check("the skill list is stored per computer and replaces the previous one", async () => {
    const p = parseSkillsPush({ skills_sha: "s1", skills: [skill(), skill({ name: "hallmark", kind: "library", quarantined: true })] });
    assert.ok(p.ok);
    if (!p.ok) return;
    assert.equal(await storeSkills(db, adonPc.id, p.value), 2);
    const p2 = parseSkillsPush({ skills_sha: "s2", skills: [skill()] });
    if (!p2.ok) throw new Error(p2.error);
    await storeSkills(db, adonPc.id, p2.value);
    const rows = (await db.execute({ sql: "SELECT name FROM skills_skill WHERE computer_id = ?", args: [adonPc.id] })).rows;
    assert.deepEqual(rows.map((r) => r.name), ["graft"]);
  });

  await check("the overview never shows another owner's computer or its changes (spec test 6)", async () => {
    const a = await overview(db, USERS.adon.id);
    const c = await overview(db, USERS.cc.id);
    assert.deepEqual(a.computers.map((x) => x.id), [adonPc.id]);
    assert.ok(a.changes.every((x) => x.computer_id === adonPc.id));
    assert.deepEqual(c.computers.map((x) => x.id), [ccPc.id]);
    assert.ok(c.changes.every((x) => x.computer_id === ccPc.id));
    assert.equal(await decide(db, USERS.cc.id, "cc", "anything", adonPc.id, "reject"), "not_found");
  });

  await check("a revoked computer cannot be asked to rebuild", async () => {
    assert.equal(await revokeComputer(db, USERS.cc.id, adonPc.id), false);     // not cc's computer
    assert.equal(await revokeComputer(db, USERS.cc.id, ccPc.id), true);
    assert.equal(await requestRebuild(db, USERS.cc.id, ccPc.id), false);
  });

  finish("skills-training-store");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
