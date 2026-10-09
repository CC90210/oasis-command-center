/**
 * offer-pages-save-queue.test.ts - the offer builder saves its draft one save
 * at a time (lib/offer-pages/save-queue.ts), so its own autosaves never read
 * as someone else's edit (CodeRabbit on #557: a save slower than the 900 ms
 * autosave, plus one more keystroke, sent the old version twice; the second
 * came back draft_conflict and nothing saved for the rest of the visit).
 *
 * WHAT IS PINNED, against a stand-in for PUT /api/forms/[id]/offer that does
 * what the route does (a compare-and-swap on the draft version), with every
 * request held until the test releases it:
 *   - a save made while one is in flight waits for it, then carries the
 *     version the first returned: one request at a time, no draft_conflict;
 *   - while it waits only the newest value is kept (three edits made mid-save
 *     go out as one save, of the last edit);
 *   - save() resolves only once its value (or a newer one) is saved;
 *   - idle() waits for the save in flight (Publish reads the version after it);
 *   - a save that throws does not jam the queue: the next one goes out.
 *
 * Pure. Run: node --conditions=react-server --import tsx tests/offer-pages-save-queue.test.ts
 */
import assert from "node:assert/strict";
import { serialSaver } from "../lib/offer-pages/save-queue";

type Server = {
  put(value: string, sentVersion: number): Promise<number | "draft_conflict">;
  saved: string[];
  conflicts: string[];
  held: Array<() => void>;
  maxInFlight: () => number;
  version: () => number;
};

/** The PUT route's compare-and-swap, each request held until released. */
function server(): Server {
  let version = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const saved: string[] = [];
  const conflicts: string[] = [];
  const held: Array<() => void> = [];
  return {
    async put(value, sentVersion) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => held.push(resolve));
      inFlight -= 1;
      if (sentVersion !== version) {
        conflicts.push(value);
        return "draft_conflict";
      }
      version += 1;
      saved.push(value);
      return version;
    },
    saved,
    conflicts,
    held,
    maxInFlight: () => maxInFlight,
    version: () => version,
  };
}

/** The builder's side: every save sends the version the last save returned. */
function builder(s: Server) {
  let versionRef = 0;
  return serialSaver(async (value: string) => {
    const r = await s.put(value, versionRef);
    if (r !== "draft_conflict") versionRef = r;
  });
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function release(s: Server): Promise<void> {
  const next = s.held.shift();
  assert.ok(next, "no request is waiting");
  next();
  await turn();
}

let groups = 0;
async function t(_name: string, fn: () => Promise<void>) {
  await fn();
  groups += 1;
}

async function main() {
  await t("a save made mid-flight waits, then carries the version the first returned", async () => {
    const s = server();
    const q = builder(s);
    const a = q.save("edit 1");
    await turn();
    const b = q.save("edit 2");
    await turn();
    assert.equal(s.held.length, 1, "the second save went out while the first was in flight");
    await release(s);
    assert.equal(s.held.length, 1, "the waiting save did not go out after the first");
    await release(s);
    await Promise.all([a, b]);
    assert.deepEqual(s.saved, ["edit 1", "edit 2"]);
    assert.deepEqual(s.conflicts, [], "the builder conflicted with its own save");
    assert.equal(s.maxInFlight(), 1);
  });

  await t("while a save is in flight only the newest value waits", async () => {
    const s = server();
    const q = builder(s);
    const first = q.save("v1");
    await turn();
    const waiting = [q.save("v2"), q.save("v3"), q.save("v4")];
    await release(s);
    await release(s);
    await Promise.all([first, ...waiting]);
    assert.deepEqual(s.saved, ["v1", "v4"]);
    assert.equal(s.held.length, 0);
    assert.deepEqual(s.conflicts, []);
  });

  await t("save() resolves only once its value is saved", async () => {
    const s = server();
    const q = builder(s);
    void q.save("x1");
    await turn();
    let resolved = false;
    const p = q.save("x2").then(() => {
      resolved = true;
    });
    await release(s);
    await turn();
    assert.equal(resolved, false, "resolved before its value was saved");
    assert.deepEqual(s.saved, ["x1"]);
    await release(s);
    await p;
    assert.deepEqual(s.saved, ["x1", "x2"]);
  });

  await t("idle() waits for the save in flight, and is immediate when there is none", async () => {
    const s = server();
    const q = builder(s);
    await q.idle();
    void q.save("y1");
    await turn();
    let idle = false;
    const w = q.idle().then(() => {
      idle = true;
    });
    await turn();
    assert.equal(idle, false, "idle() did not wait for the save in flight");
    await release(s);
    await w;
    assert.equal(s.version(), 1, "Publish would read the version before the save moved it on");
  });

  await t("a save that throws does not jam the queue", async () => {
    let calls = 0;
    const q = serialSaver(async (v: string) => {
      calls += 1;
      if (v === "boom") throw new Error("connection dropped");
    });
    await assert.rejects(q.save("boom"), /connection dropped/);
    await q.save("after");
    assert.equal(calls, 2);
  });

  console.log(`offer-pages-save-queue: OK - ${groups} groups of checks`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
