/**
 * tests/template-pool-store.test.ts — a broken read is not an empty pool.
 *
 * The send path wants the forgiving loader: if the template table is
 * unreachable, resolveCopy should fall back to the step's own copy rather than
 * hold every drip in the queue over a cosmetic dependency.
 *
 * A WRITE path wants the opposite. `validateInterchange` decides yes or no by
 * looking for the chosen template IN the pool, so an empty pool from a failed
 * read is a wrong answer wearing the right shape: the operator is told their
 * template does not exist when the truth is that nothing could be read, and the
 * message sends them off to fix a template that was never the problem.
 *
 * This is [[redundancy-hides-failure]] in miniature — the same shape as a
 * ranker that returns nothing on error and scores as merely unlucky.
 */

import assert from "node:assert/strict";
import { loadApprovedPool, loadApprovedPoolOrThrow } from "../lib/drips/template-pool-store";

type AnyDb = Parameters<typeof loadApprovedPool>[0];

/** Minimal PostgREST-shaped stub: every builder method returns itself, and the
 *  chain resolves to whatever result this fixture was constructed with. */
function fakeDb(result: { data?: unknown[]; error?: { message: string } }): AnyDb {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gt", "limit", "order"]) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return { from: () => chain } as unknown as AnyDb;
}

const ROW = {
  id: "t1",
  brand: "sunbiz",
  stage: "follow_up",
  role: "opener",
  subject: "s",
  body_text: "b",
  status: "approved",
  weight: 2,
};

async function main(): Promise<void> {
  // ── Happy path: both loaders agree ──────────────────────────────────────
  const okDb = fakeDb({ data: [ROW] });
  const safe = await loadApprovedPool(okDb, "tenant-1");
  const strict = await loadApprovedPoolOrThrow(okDb, "tenant-1");
  assert.deepEqual(safe, strict, "the two loaders must not disagree when the read works");
  assert.equal(strict.length, 1);
  assert.equal(strict[0].id, "t1");
  assert.equal(strict[0].role, "opener");
  assert.equal(strict[0].weight, 2);

  // A row with no role must land in the same bucket the executor defaults to,
  // or a roleless template becomes unpinnable for a roleless step.
  const roleless = await loadApprovedPoolOrThrow(fakeDb({ data: [{ ...ROW, role: null }] }), "tenant-1");
  assert.equal(roleless[0].role, "nudge");

  // ── A read error: the two loaders MUST diverge ──────────────────────────
  const brokenDb = fakeDb({ error: { message: "connection reset" } });

  // Send path: degrade quietly to today's behaviour.
  assert.deepEqual(await loadApprovedPool(brokenDb, "tenant-1"), [], "the send path falls back, it does not stall");

  // Write path: say so. If this ever starts returning [] instead of throwing,
  // the interchange validator silently changes its answer from "we could not
  // check" to "your template does not exist" — a confident wrong answer, and
  // the operator has no way to tell the difference.
  await assert.rejects(
    () => loadApprovedPoolOrThrow(brokenDb, "tenant-1"),
    /template pool read failed: connection reset/,
    "a decision-making read must fail loudly, and name the underlying error",
  );

  console.log("template-pool-store.test.ts — all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
