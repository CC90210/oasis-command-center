/**
 * skills-training-checkin.test.ts - the machine check-in routes (JARVIS plan 2, Task 7).
 *
 * PINNED: no key / a malformed key / a wrong key / a revoked key is 401 and the body is never
 * read; an oversize body is 413; an extra field is 400; a good key polls, pushes skills, pulls
 * only its own pending changes and reports; a report naming a status that moved on is skipped.
 *
 * Run: node --conditions=react-server --import tsx tests/skills-training-checkin.test.ts
 */
import { check, finish, req, setupDb, USERS } from "./skills-training-harness";
import assert from "node:assert/strict";
import { createChange, createComputer, revokeComputer } from "../lib/skills/store";
import { GET as poll } from "../app/api/skills/checkin/poll/route";
import { POST as pushSkills } from "../app/api/skills/checkin/skills/route";
import { GET as changes } from "../app/api/skills/checkin/changes/route";
import { POST as report } from "../app/api/skills/checkin/report/route";

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const run = { started_at: "2026-10-09T06:00:00.000Z", finished_at: "2026-10-09T06:30:00.000Z", outcome: "held", detail: "" };
const labels = { labels: [{ id: "debug", level: "broad", parent: null, name: "Fix something broken", meaning: "", examples: [] }], assignments: [] };

/** A Request whose body throws if anything reads it: proves auth runs before the body. */
function untouchable(url: string, headers: Record<string, string>): Request {
  const r = req(url, { method: "POST", headers, raw: "{}" });
  Object.defineProperty(r, "text", { value: () => { throw new Error("body read before auth"); } });
  Object.defineProperty(r, "json", { value: () => { throw new Error("body read before auth"); } });
  return r;
}

async function main() {
  const db = await setupDb();
  const pc = await createComputer(db, USERS.adon.id, "Adon's PC");
  const other = await createComputer(db, USERS.cc.id, "CC's PC");
  console.log("skills-training-checkin:");

  await check("no key, a malformed key, a wrong key: 401 without reading the body", async () => {
    const wrongLastChar = pc.key.slice(-1) === "A" ? "B" : "A";
    for (const headers of [{}, { authorization: "Bearer nope" }, bearer(`${pc.key.slice(0, -1)}${wrongLastChar}`), bearer(other.key.replace(other.id, pc.id))]) {
      const res = await report(untouchable("/api/skills/checkin/report", headers) as never);
      assert.equal(res.status, 401);
    }
  });

  await check("a good key polls", async () => {
    const res = await poll(req("/api/skills/checkin/poll", { headers: bearer(pc.key) }) as never);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, rebuild_requested: false, pending: 0 });
  });

  await check("the skill list: extra field 400, path 400, oversize 413, good 200", async () => {
    const good = { skills_sha: "s1", skills: [{ name: "graft", description: "d", kind: "installed", quarantined: false, capabilities: [], example_prompts: [] }] };
    const send = (body: unknown, raw?: string) =>
      pushSkills(req("/api/skills/checkin/skills", { method: "POST", headers: bearer(pc.key), body: raw === undefined ? body : undefined, raw }) as never);
    assert.equal((await send({ ...good, prompts: ["x"] })).status, 400);
    assert.equal((await send({ ...good, skills: [{ ...good.skills[0], description: "C:\\Users\\echel\\x" }] })).status, 400);
    assert.equal((await send(undefined, JSON.stringify({ ...good, pad: "x".repeat(2_100_000) }))).status, 413);
    const ok = await send(good);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, stored: 1 });
  });

  await check("an oversize body is 413 by BYTES, not UTF-16 characters (fix round 1)", async () => {
    // "€" (EUR SIGN) is one UTF-16 code unit but three UTF-8 bytes: 700,000 of them is
    // ~700,040 *characters* (under the 2,000,000-character false floor a naive text.length
    // check would apply) but ~2,100,040 *bytes* (over MAX_BODY_BYTES). No content-length
    // header is sent (the harness's req() never sets one for a constructed Request), so this
    // also exercises the streamed-read path rather than the content-length fast path.
    const raw = JSON.stringify({ skills_sha: "s2", skills: [], pad: "€".repeat(700_000) });
    assert.ok(raw.length < 2_000_000, "test precondition: under the character-count false floor");
    assert.ok(Buffer.byteLength(raw, "utf8") > 2_000_000, "test precondition: over the real byte cap");
    const res = await pushSkills(req("/api/skills/checkin/skills", { method: "POST", headers: bearer(pc.key), raw }) as never);
    assert.equal(res.status, 413);
  });

  await check("a computer pulls only its own pending changes, oldest first", async () => {
    const ops = [{ op: "assign", skill: "graft", label: "debug", rank: "use-first" }];
    await createChange(db, USERS.adon.id, "adon", { description: "first", scope: "shared", ops });
    await createChange(db, USERS.cc.id, "cc", { description: "cc only", scope: other.id, ops });
    const res = await changes(req("/api/skills/checkin/changes", { headers: bearer(pc.key) }) as never);
    const body = (await res.json()) as { changes: { description: string; status: string; ops: unknown[] }[] };
    assert.deepEqual(body.changes.map((c) => [c.description, c.status]), [["first", "waiting"]]);
    assert.deepEqual(body.changes[0].ops, ops);
  });

  await check("a report updates what it pulled, skips what moved on, and refuses a prompt field", async () => {
    const pulled = (await (await changes(req("/api/skills/checkin/changes", { headers: bearer(pc.key) }) as never)).json()) as { changes: { id: string }[] };
    const result = { change_id: pulled.changes[0].id, pulled_status: "waiting", status: "held", reason: "2 prompt(s) route worse", worse: 2, better: 0, totals: { debug: { n: 3, before: 3, after: 1 } } };
    const send = (body: unknown) => report(req("/api/skills/checkin/report", { method: "POST", headers: bearer(pc.key), body }) as never);
    assert.equal((await send({ run, results: [{ ...result, prompt: "raw" }], pruned: [], labels })).status, 400);
    const first = await send({ run, results: [result], pruned: [], labels });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, updated: 1, skipped: 0 });
    const again = await send({ run, results: [result], pruned: [], labels });
    assert.deepEqual(await again.json(), { ok: true, updated: 0, skipped: 1 });
  });

  await check("a revoked key is 401 (the PC reports BLOCKED skills-checkin-key)", async () => {
    await revokeComputer(db, USERS.cc.id, other.id);
    const res = await poll(req("/api/skills/checkin/poll", { headers: bearer(other.key) }) as never);
    assert.equal(res.status, 401);
  });

  finish("skills-training-checkin");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
