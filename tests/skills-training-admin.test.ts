/**
 * skills-training-admin.test.ts - the Skills admin routes (JARVIS plan 2, Task 8).
 *
 * PINNED: anonymous, a sales rep and another workspace get 404 on every admin route; a
 * cross-origin write is refused; a founder registers a computer and sees its key ONCE; only the
 * primary computer's owner queues a shared change; a decision works only on a held change of a
 * computer the caller owns; the overview of one founder never shows the other's computer or
 * its held change (spec test 6).
 *
 * Run: node --conditions=react-server --import tsx tests/skills-training-admin.test.ts
 */
import { check, finish, login, req, setupDb, USERS } from "./skills-training-harness";
import assert from "node:assert/strict";
import { recordReport } from "../lib/skills/store";
import { parseReport } from "../lib/skills/contract";
import { POST as createComputerRoute } from "../app/api/skills/computers/route";
import { POST as revokeRoute } from "../app/api/skills/computers/[id]/revoke/route";
import { POST as keyRoute } from "../app/api/skills/computers/[id]/key/route";
import { POST as createChangeRoute } from "../app/api/skills/changes/route";
import { POST as decisionRoute } from "../app/api/skills/changes/[id]/decision/route";
import { POST as rebuildRoute } from "../app/api/skills/rebuild/route";
import { GET as overviewRoute } from "../app/api/skills/overview/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const ops = [{ op: "assign", skill: "graft", label: "debug", rank: "use-first" }];
type Json = Record<string, unknown>;
const body = async (r: Response) => (await r.json()) as Json;

async function main() {
  const db = await setupDb();
  console.log("skills-training-admin:");

  await check("anonymous, a rep and another workspace get 404 everywhere", async () => {
    for (const who of ["anonymous", "rep", "client"] as const) {
      await login(who);
      assert.equal((await overviewRoute()).status, 404, `${who} overview`);
      assert.equal((await createComputerRoute(req("/api/skills/computers", { method: "POST", body: { display_name: "x" } }))).status, 404, `${who} create`);
      assert.equal((await rebuildRoute(req("/api/skills/rebuild", { method: "POST", body: { computer_id: "pc-00000000" } }))).status, 404, `${who} rebuild`);
    }
  });

  await check("a cross-origin write is refused", async () => {
    await login("adon");
    const r = await createComputerRoute(req("/api/skills/computers", { method: "POST", body: { display_name: "x" }, headers: { origin: "https://evil.test" } }));
    assert.equal(r.status, 403);
  });

  await login("adon");
  const adonPc = await body(await createComputerRoute(req("/api/skills/computers", { method: "POST", body: { display_name: "Adon's PC" } })));
  await login("cc");
  const ccPc = await body(await createComputerRoute(req("/api/skills/computers", { method: "POST", body: { display_name: "CC's PC" } })));

  await check("a founder registers a computer and sees the key once", async () => {
    assert.match(String(adonPc.key), /^skc_pc-[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    await login("adon");
    const ov = await body(await overviewRoute());
    assert.ok(!JSON.stringify(ov).includes(String(adonPc.key)), "the overview must never carry a key");
    const again = await body(await keyRoute(req(`/api/skills/computers/${adonPc.id}/key`, { method: "POST", body: {} }), params(String(adonPc.id))));
    assert.notEqual(again.key, adonPc.key);
  });

  await check("only the primary computer's owner queues a shared change", async () => {
    await login("cc");
    const refused = await createChangeRoute(req("/api/skills/changes", { method: "POST", body: { description: "d", scope: "shared", ops } }));
    assert.equal(refused.status, 403);
    const own = await createChangeRoute(req("/api/skills/changes", { method: "POST", body: { description: "cc only", scope: ccPc.id, ops } }));
    assert.equal(own.status, 201);
    await login("adon");
    const shared = await createChangeRoute(req("/api/skills/changes", { method: "POST", body: { description: "shared", scope: "shared", ops } }));
    assert.equal(shared.status, 201);
    const bad = await createChangeRoute(req("/api/skills/changes", { method: "POST", body: { description: "d", scope: "shared", ops: [{ op: "explode" }] } }));
    assert.equal(bad.status, 400);
  });

  await check("a decision works only on a held change of a computer the caller owns; each owner sees only their own (spec test 6)", async () => {
    await login("cc");
    const ccView = await body(await overviewRoute());
    const ccChange = (ccView.changes as Json[]).find((c) => c.description === "cc only")!;
    const rep = parseReport({
      run: { started_at: "2026-10-09T06:00:00.000Z", finished_at: "2026-10-09T06:30:00.000Z", outcome: "held", detail: "" },
      results: [{ change_id: ccChange.change_id, pulled_status: "waiting", status: "held", reason: "worse", worse: 1, better: 0, totals: {} }],
      pruned: [], labels: { labels: [], assignments: [] },
    });
    if (!rep.ok) throw new Error(rep.error);
    await recordReport(db, String(ccPc.id), rep.value);

    await login("adon");
    const adonView = await body(await overviewRoute());
    assert.ok((adonView.computers as Json[]).every((c) => c.id === adonPc.id));
    assert.ok((adonView.changes as Json[]).every((c) => c.computer_id === adonPc.id), "Adon must not see CC's held change");
    const steal = await decisionRoute(req(`/api/skills/changes/${ccChange.change_id}/decision`, { method: "POST", body: { computer_id: ccPc.id, decision: "accept-anyway" } }), params(String(ccChange.change_id)));
    assert.equal(steal.status, 404);

    await login("cc");
    const ok = await decisionRoute(req(`/api/skills/changes/${ccChange.change_id}/decision`, { method: "POST", body: { computer_id: ccPc.id, decision: "accept-anyway" } }), params(String(ccChange.change_id)));
    assert.equal(ok.status, 200);
    const twice = await decisionRoute(req(`/api/skills/changes/${ccChange.change_id}/decision`, { method: "POST", body: { computer_id: ccPc.id, decision: "reject" } }), params(String(ccChange.change_id)));
    assert.equal(twice.status, 409);
  });

  await check("rebuild and revoke act only on the caller's own computer", async () => {
    await login("adon");
    assert.equal((await rebuildRoute(req("/api/skills/rebuild", { method: "POST", body: { computer_id: ccPc.id } }))).status, 404);
    assert.equal((await rebuildRoute(req("/api/skills/rebuild", { method: "POST", body: { computer_id: adonPc.id } }))).status, 200);
    assert.equal((await revokeRoute(req(`/api/skills/computers/${ccPc.id}/revoke`, { method: "POST", body: {} }), params(String(ccPc.id)))).status, 404);
  });

  finish("skills-training-admin");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
