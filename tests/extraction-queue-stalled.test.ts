/**
 * tests/extraction-queue-stalled.test.ts — a dead reader files no errors.
 *
 * `forms.extraction_jobs_failed` counts jobs that FAILED. A consumer that has
 * died does not fail anything: it stops taking work, the rows sit in `queued`,
 * the failure count goes to zero and the check beside this one turns green.
 * Absence of failure is the exact shape a dead consumer makes.
 *
 * It matters more here than anywhere else in the intake path because the
 * consumer is the one piece that does not run on Cloudflare — a single-instance
 * PM2 process on srv1723601, which on 2026-09-06 was 82 commits behind main
 * with nothing on this side able to see whether it was alive. This check is the
 * liveness signal that needs no SSH.
 *
 * These assertions drive the real `observe` against a recording stub, so they
 * describe the query that will actually run rather than the one the source
 * appears to say.
 */
import assert from "node:assert/strict";
import { FORM_CHECKS } from "../lib/health/form-checks";
import { evaluate } from "../lib/health/checks-core";

const check = FORM_CHECKS.find((c) => c.id === "forms.extraction_queue_stalled");
assert.ok(check, "forms.extraction_queue_stalled is gone — nothing watches whether the reader is alive");

type Call = { fn: string; args: unknown[] };

/** A fluent stub that records the query and resolves to whatever we hand it. */
function recordingDb(result: { count?: number; error?: { message: string } }) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const fn of ["select", "eq", "in", "lt", "gte", "gt", "lte", "order", "limit", "not"]) {
    builder[fn] = (...args: unknown[]) => {
      calls.push({ fn, args });
      return builder;
    };
  }
  // Awaiting the chain is what fires it.
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  const db = {
    from: (table: string) => {
      calls.push({ fn: "from", args: [table] });
      return builder;
    },
  };
  return { db, calls };
}

const TENANT = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const NOW = Date.parse("2026-09-19T12:00:00.000Z");

// Wrapped: tsx emits CJS here, which has no top-level await.
async function main() {

// ── the query ──────────────────────────────────────────────────────────────

{
  const { db, calls } = recordingDb({ count: 0 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const observed = await check!.observe(db as any, TENANT, NOW);
  assert.equal(observed, 0, "a clean queue must read as zero, not null");

  const from = calls.find((c) => c.fn === "from");
  assert.deepEqual(from?.args, ["document_extraction_jobs"], "the check reads the wrong table");

  // Scoped to the tenant it was GIVEN. A hardcoded tenant here would be the
  // same defect this branch exists to remove.
  const eqs = calls.filter((c) => c.fn === "eq");
  assert.ok(
    eqs.some((c) => c.args[0] === "tenant_id" && c.args[1] === TENANT),
    "the stalled-queue check is not scoped to the tenant the runner passed it",
  );

  // Exactly the three non-terminal states. `extracted` belongs: the read
  // succeeded but the apply step never ran, and the rep is still looking at an
  // application that never populated.
  const inCall = calls.find((c) => c.fn === "in");
  assert.ok(inCall, "the check no longer filters by status — it would count finished jobs as stalled");
  assert.equal(inCall!.args[0], "status");
  const statuses = [...(inCall!.args[1] as string[])].sort();
  assert.deepEqual(
    statuses,
    ["extracted", "processing", "queued"],
    "the non-terminal status set changed — a state dropped from this list is a stall nobody sees",
  );
  assert.ok(
    !statuses.includes("applied") && !statuses.includes("failed"),
    "a terminal status is being counted as stalled — the check would never go green",
  );

  // Older than the grace period, and NO lower bound on age.
  const lt = calls.find((c) => c.fn === "lt" && c.args[0] === "created_at");
  assert.ok(lt, "the check no longer requires the job to be OLD — every fresh job would page");
  const cutoff = Date.parse(lt!.args[1] as string);
  assert.equal(
    NOW - cutoff,
    30 * 60_000,
    "the stall grace period moved; under a few minutes it pages on normal work",
  );

  // THE TRAP THIS CHECK IS WRITTEN AROUND. Its sibling looks back 48h, which is
  // right for counting failures. Applied here, a daemon dead for three days
  // would watch its stuck rows age out of the window and the check would go
  // GREEN while the daemon was still dead.
  assert.equal(
    calls.filter((c) => (c.fn === "gte" || c.fn === "gt") && c.args[0] === "created_at").length,
    0,
    "a lower bound on age is back — stuck rows will age out and a dead consumer will read as healthy",
  );
}

// ── it fails closed ────────────────────────────────────────────────────────

{
  const { db } = recordingDb({ error: { message: "turso unreachable" } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const observed = await check!.observe(db as any, TENANT, NOW);
  assert.equal(observed, null, "a failed query must not read as an empty queue");
  assert.equal(
    evaluate(check!.id, check!.rule, observed, []).verdict,
    "check_broken",
    "a check that could not run must never read as ok",
  );
}

// ── one stuck job is an outage ─────────────────────────────────────────────

assert.equal(evaluate(check!.id, check!.rule, 0, []).verdict, "ok");
assert.equal(
  evaluate(check!.id, check!.rule, 1, []).verdict,
  "failing",
  "a single unread application is still a rep staring at a spinner",
);

// ── it names its audience rather than inheriting one ───────────────────────

assert.equal(
  check!.lane,
  "sunbiz-ops",
  "the lane is undeclared again — it would fall to the runner's default instead of being chosen",
);

// The page must tell whoever reads it where the process lives, because it does
// not live where the rest of this app does.
assert.match(
  check!.describe({ id: check!.id, verdict: "failing", observed: 2, baseline: 0, reason: "" }),
  /srv1723601/,
  "the alert no longer says which host to look at",
);

}

main().then(
  () => console.log("extraction-queue-stalled: all assertions passed"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
