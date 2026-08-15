/**
 * insertChunkSalvagingDuplicates — keep the rows that are fine.
 *
 * A chunked insert is all-or-nothing: one colliding row fails the statement and
 * takes its 499 neighbours with it. Both cold-list importers answered that by
 * counting the WHOLE chunk as duplicates, so a 500-row chunk with a single
 * repeat lost 499 good leads and reported them to the operator as duplicates —
 * a plausible number, and a false one.
 *
 * That branch had been unreachable (a Postgres error code on a Turso backend),
 * which is exactly why nobody noticed what it did. Fixing the classifier made it
 * live and turned a loud 500 into quiet data loss.
 *
 * These drive the real function against a stub client rather than reading the
 * source, because the thing worth pinning is the ARITHMETIC: how many landed,
 * how many were genuinely duplicates, and when the caller must be told to stop.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { insertChunkSalvagingDuplicates } from "../lib/api-helpers";

const UNIQUE = { code: "TURSO_ADAPTER", message: "UNIQUE constraint failed: cold_leads.phone" };
const FATAL = { code: "TURSO_ADAPTER", message: "no such table: cold_leads" };

/**
 * Stub client. `dupes` is the set of row values that collide; the bulk insert
 * fails if the chunk contains any of them, mirroring a real all-or-nothing
 * statement.
 */
function stub(dupes: Set<unknown>, fatalOn?: unknown) {
  const calls = { bulk: 0, single: 0 };
  return {
    calls,
    db: {
      from() {
        return {
          insert(payload: unknown) {
            const rows = Array.isArray(payload) ? payload : [payload];
            if (Array.isArray(payload)) calls.bulk += 1;
            else calls.single += 1;
            // A real DB fails the bulk statement on the constraint it hits
            // first, and a unique violation on ANY row aborts the whole insert
            // before a later row's problem surfaces. So: duplicates win on a
            // bulk insert, and `fatalOn` can only appear once we are retrying
            // rows one at a time — which is exactly the sequence worth testing.
            const isBulk = Array.isArray(payload);
            const hasDupe = rows.some((r) => dupes.has(r));
            const hasFatal = rows.some((r) => r === fatalOn);
            const err =
              isBulk && hasDupe ? UNIQUE
              : hasFatal ? FATAL
              : hasDupe ? UNIQUE
              : null;
            return {
              select: () =>
                Promise.resolve(
                  err ? { data: null, error: err } : { data: rows.map(() => ({ id: "x" })), error: null },
                ),
            };
          },
        };
      },
    },
  };
}

test("a clean chunk inserts in one statement and never falls back", async () => {
  const s = stub(new Set());
  const r = await insertChunkSalvagingDuplicates(s.db, "cold_leads", [1, 2, 3]);
  assert.deepEqual({ inserted: r.inserted, duplicates: r.duplicates }, { inserted: 3, duplicates: 0 });
  assert.equal(r.failure, null);
  assert.equal(s.calls.single, 0, "no per-row retries when nothing collided");
});

test("one duplicate in a chunk keeps the other rows", async () => {
  // The whole point. Old behaviour: inserted 0, duplicates 3.
  const s = stub(new Set([2]));
  const r = await insertChunkSalvagingDuplicates(s.db, "cold_leads", [1, 2, 3]);
  assert.equal(r.inserted, 2, "the two non-colliding rows must still land");
  assert.equal(r.duplicates, 1, "exactly one row actually collided");
  assert.equal(r.failure, null);
  assert.equal(s.calls.single, 3, "each row retried individually after the bulk failure");
});

test("an all-duplicate chunk reports every row, and loses nothing that existed", async () => {
  const s = stub(new Set([1, 2, 3]));
  const r = await insertChunkSalvagingDuplicates(s.db, "cold_leads", [1, 2, 3]);
  assert.deepEqual({ inserted: r.inserted, duplicates: r.duplicates }, { inserted: 0, duplicates: 3 });
  assert.equal(r.failure, null);
});

test("a non-duplicate error on the bulk insert is surfaced, not retried", async () => {
  const s = stub(new Set(), 2);
  const r = await insertChunkSalvagingDuplicates(s.db, "cold_leads", [1, 2, 3]);
  assert.equal(r.failure?.message, FATAL.message);
  assert.equal(r.inserted, 0);
  assert.equal(s.calls.single, 0, "a broken table is not something to retry row by row");
});

test("a fatal error DURING the retry stops and reports what had landed", async () => {
  // Row 1 duplicates (forcing the fallback), row 3 then hits a real error.
  const s = stub(new Set([1]), 3);
  const r = await insertChunkSalvagingDuplicates(s.db, "cold_leads", [1, 2, 3]);
  assert.equal(r.failure?.message, FATAL.message);
  assert.equal(r.duplicates, 1);
  assert.equal(r.inserted, 1, "row 2 landed before the failure and must be counted");
});

test("an empty chunk is a no-op, not a failure", async () => {
  const s = stub(new Set());
  const r = await insertChunkSalvagingDuplicates(s.db, "cold_leads", []);
  assert.deepEqual({ inserted: r.inserted, duplicates: r.duplicates }, { inserted: 0, duplicates: 0 });
  assert.equal(r.failure, null);
});

test("inserted + duplicates never exceeds the chunk size", async () => {
  // The invariant the old code broke: it reported 3 duplicates for 1 collision.
  for (const dupes of [new Set(), new Set([1]), new Set([1, 2]), new Set([1, 2, 3])]) {
    const s = stub(dupes as Set<unknown>);
    const r = await insertChunkSalvagingDuplicates(s.db, "cold_leads", [1, 2, 3]);
    assert.equal(r.inserted + r.duplicates, 3, `accounting broke for ${[...dupes].join(",") || "none"}`);
  }
});
