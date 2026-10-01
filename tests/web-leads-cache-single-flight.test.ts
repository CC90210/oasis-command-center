/**
 * tests/web-leads-cache-single-flight.test.ts - the Web Leads read cache shares
 * one load between concurrent callers WITHOUT sharing its promise.
 *
 * lib/web-leads/cache.ts used to put the load's promise in a module-level map
 * so five reps opening the page together paid one 15 MB read. On Cloudflare
 * Workers a request that awaits a promise another request's I/O settles is
 * canceled as hung, and a load whose own request was canceled never settled,
 * so every /api/web-leads call on that isolate hung until the TTL ran out
 * (2026-10-01 pipeline incident follow-up to PR #509). This pins:
 *   - a settled value is shared, and concurrent callers still trigger ONE load;
 *   - a caller never waits on a dead load past its wait budget, then loads;
 *   - a failed load is not cached, and a waiting caller runs its own;
 *   - a write during a load (invalidate) keeps the possibly stale rows out of
 *     the cache;
 *   - the module never stores a promise in its maps.
 *
 * Run: node --conditions=react-server --import tsx tests/web-leads-cache-single-flight.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invalidate, memo } from "../lib/web-leads/cache";

const ROOT = join(__dirname, "..");

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").join("\n        ")}`);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const FAST = { flightWaitMs: 300, pollMs: 10 };

function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: still waiting after ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

async function main() {
  console.log("web leads cache: single flight without a shared promise");

  await check("a settled value is shared without loading again", async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return ["lead"];
    };
    const a = await memo("t1:leads", 60_000, load, FAST);
    const b = await memo("t1:leads", 60_000, load, FAST);
    assert.equal(a, b);
    assert.equal(loads, 1);
  });

  await check("concurrent callers still trigger ONE load (the reason the cache exists)", async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      await sleep(120);
      return { rows: 31_000 };
    };
    const first = memo("t2:leads", 60_000, load, FAST);
    await sleep(20);
    const second = memo("t2:leads", 60_000, load, FAST);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(loads, 1, "the second caller waited for the first load's result");
    assert.equal(a, b);
  });

  await check("a caller never waits on a dead load past its budget, then loads itself", async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      // The first load never settles, like a read whose request was canceled.
      if (loads === 1) return new Promise<string>(() => {});
      return "rows";
    };
    void memo("t3:leads", 60_000, load, FAST);
    await sleep(5);
    assert.equal(await within(2_000, memo("t3:leads", 60_000, load, FAST), "the second caller"), "rows");
    assert.equal(loads, 2);
    assert.equal(await memo("t3:leads", 60_000, load, FAST), "rows", "its result is cached for the next caller");
    assert.equal(loads, 2);
  });

  await check("a failed load is not cached, and a caller waiting on it runs its own at once", async () => {
    // A long wait budget: a caller that only noticed the failure when its
    // budget ran out would take 3 s here, not well under one.
    const opts = { flightWaitMs: 3_000, pollMs: 10 };
    let loads = 0;
    const load = async () => {
      loads += 1;
      await sleep(40);
      if (loads === 1) throw new Error("bridge unreachable");
      return "rows";
    };
    const first = memo("t4:leads", 60_000, load, opts);
    await sleep(5);
    const started = Date.now();
    const second = memo("t4:leads", 60_000, load, opts);
    await assert.rejects(first, /bridge unreachable/);
    assert.equal(await within(5_000, second, "the waiting caller"), "rows");
    assert.ok(Date.now() - started < 1_000, `the waiting caller took ${Date.now() - started} ms to notice the failure`);
    assert.equal(loads, 2);
  });

  await check("a write during a load keeps its possibly stale rows out of the cache", async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      await sleep(80);
      return loads === 1 ? "before the claim" : "after the claim";
    };
    const inFlight = memo("t5:leads:pool", 60_000, load, FAST);
    await sleep(20);
    invalidate("t5:");
    assert.equal(await inFlight, "before the claim", "the caller that started it still gets its rows");
    assert.equal(await memo("t5:leads:pool", 60_000, load, FAST), "after the claim", "the next caller reads again");
    assert.equal(loads, 2);
  });

  await check("the module never stores a promise in its maps", () => {
    const src = readFileSync(join(ROOT, "lib/web-leads/cache.ts"), "utf8");
    const sets = [...src.matchAll(/\b(store|flights)\.set\(([^;]*)\);/g)].map((m) => m[0]);
    assert.ok(sets.length >= 2, "both maps are still written");
    for (const s of sets) assert.doesNotMatch(s, /promise|\.then\(|\.catch\(|load\(\)/i, `stores a promise: ${s}`);
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
