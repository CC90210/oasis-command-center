/**
 * tests/health-recovery-delivery.test.ts — a recovery nobody received is an
 * incident that never closed.
 *
 * A failure alert can afford to lose a lane. The decay ladder re-sends it, and
 * `alerting.telegram_delivery` turns a dead channel into an alert of its own.
 * A RECOVERY cannot: the runner clears `first_failed_at` and the episode is
 * over. There is no second attempt, ever.
 *
 * So the 2026-08-07 shape — @KnutRPEbot kicked from the sunbiz-ops group, every
 * send to that lane returning 403 — plays out like this if the recovery is
 * fire-and-forget:
 *
 *   1. drip check fails      → alert reaches BOTH lanes
 *   2. bot is kicked
 *   3. drip check recovers   → "RECOVERED" reaches operator, 403 on sunbiz-ops
 *   4. episode cleared       → sunbiz-ops keeps a red alert with nothing left
 *                              in the system that will ever resolve it
 *
 * The fix carries the unpaid lanes forward in `last_signature` and retries only
 * those. Retrying wholesale would be its own bug: a lane dead for days would
 * re-tell the REACHABLE audience "RECOVERED" every 15 minutes, ~96 times a day,
 * which is how people learn to mute the channel.
 *
 * `pendingRecoveryLanes` is exercised for real. The control flow around it is
 * asserted against the source, which is this file's established convention for
 * runner.ts (see tests/form-submit-failure-capture.test.ts) — the function
 * needs a live Supabase client and fifty checks to run end to end.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pendingRecoveryLanes, runHealthChecks } from "../lib/health/runner";
import { DEPLOY_CHECKS } from "../lib/health/deploy-checks";
import { evaluate } from "../lib/health/checks-core";
import { healthAlertStateKey } from "../lib/health/alert-state-key";

const RUNNER = readFileSync("lib/health/runner.ts", "utf8");

// ── the marker round-trips, and cannot collide with a real signature ────────

// A live failure signature. Nothing about it may read as a pending recovery,
// or a genuine outage would be mistaken for an undelivered "all clear".
assert.equal(
  pendingRecoveryLanes("forms.submit_failures_open:failing"),
  null,
  "a real alert signature parses as a pending recovery — a live failure would be read as an all-clear",
);
assert.equal(pendingRecoveryLanes(null), null, "a cleared signature is not a pending recovery");
assert.equal(pendingRecoveryLanes(undefined), null, "a missing signature is not a pending recovery");
assert.equal(
  pendingRecoveryLanes("recovery-pending:"),
  null,
  "an empty lane list must fall back to every lane, not to none — none means silence",
);

assert.deepEqual(
  pendingRecoveryLanes("recovery-pending:sunbiz-ops"),
  ["sunbiz-ops"],
  "a single owed lane does not round-trip",
);
assert.deepEqual(
  pendingRecoveryLanes("recovery-pending:operator,sunbiz-ops"),
  ["operator", "sunbiz-ops"],
  "two owed lanes do not round-trip",
);

// The format the runner writes must be the format it reads. If these drift, a
// retry silently degrades to re-announcing to everyone, forever.
const MARKER = /const RECOVERY_PENDING = "recovery-pending:";/;
assert.match(RUNNER, MARKER, "the marker prefix moved without the parser");
assert.match(
  RUNNER,
  /last_signature: stillOwed\.length \? `\$\{RECOVERY_PENDING\}\$\{stillOwed\.join\(","\)\}` : null/,
  "the runner no longer writes the pending-lane marker the parser expects",
);

// ── the episode stays open while a lane is still owed the news ──────────────

assert.match(
  RUNNER,
  /first_failed_at: stillOwed\.length \? state\.first_failed_at : null/,
  "the episode is cleared unconditionally again — a lane that rejected the recovery can never be retried",
);
assert.doesNotMatch(
  RUNNER,
  /repeat_n: 0, first_failed_at: null,/,
  "the unconditional clear is back",
);

// ── only the lanes that did NOT accept are retried ──────────────────────────

assert.match(
  RUNNER,
  /const owed = pendingRecoveryLanes\(state\.last_signature\) \?\? lanesFor\(check\);/,
  "the retry no longer narrows to the owed lanes — the reachable audience gets 'RECOVERED' every 15 minutes",
);
assert.match(
  RUNNER,
  /for \(const lane of owed\) \{/,
  "the recovery loop no longer iterates the owed lanes",
);

// ── the send result is read, not discarded ─────────────────────────────────

assert.doesNotMatch(
  RUNNER,
  /\{ lane \},\s*\)\.catch\(\(\) => undefined\);/,
  "the recovery send's result is discarded again — a rejection becomes invisible",
);
assert.match(
  RUNNER,
  /if \(!r\.ok\) stillOwed\.push\(lane\);/,
  "a rejected lane is no longer recorded as still owed",
);

// ── an undelivered recovery is recorded where the dead channel cannot hide it

assert.match(
  RUNNER,
  /reason: `could not deliver the \$\{result\.id\} recovery to \$\{stillOwed\.join\(", "\)\}`/,
  "an undelivered recovery no longer writes a telegram_delivery row",
);

// ── the alert path names the lanes that actually rejected it ───────────────

// This line read "the sunbiz-ops lane" unconditionally: the same defect as the
// rest of the branch, a lane constant standing in for a lane decision. It sent
// anyone reading the row to the wrong chat.
assert.doesNotMatch(
  RUNNER,
  /alert to the sunbiz-ops lane/,
  "the delivery-failure row hardcodes sunbiz-ops again, whichever lane actually failed",
);
assert.match(
  RUNNER,
  /could not deliver the \$\{result\.id\} alert to \$\{rejected\.join\(", "\)\}/,
  "the delivery-failure row no longer names the lanes that rejected it",
);

// ── a refused lane is recorded even when another lane accepted ──────────────

// This was `if (!sent.ok)`. With ONE lane the two conditions are the same
// sentence; with two they are not. The 2026-08-07 outage was exactly one dead
// lane while the other kept working, so `sent.ok` stayed true and the dead lane
// left no trace anywhere. The audience that heard nothing is the audience whose
// silence needs recording.
assert.doesNotMatch(
  RUNNER,
  /if \(!sent\.ok\) \{/,
  "a lane that refused is recorded again only when EVERY lane refused — a single dead lane goes untraced",
);
assert.match(
  RUNNER,
  /if \(rejected\.length\) \{/,
  "the delivery-failure row is no longer written whenever a lane refuses",
);
// "one of two lanes is down" and "the alert reached nobody" are different
// incidents with different urgency. A reader at 2am must not have to infer it.
assert.match(
  RUNNER,
  /sent\.ok[\s\S]{0,200}another lane took it[\s\S]{0,200}NO lane took it/,
  "the row no longer says whether ANY lane heard the alert",
);

// ── and something actually READS those rows ────────────────────────────────

// Three comments in runner.ts call this row the backstop that turns a dead
// channel into an alert of its own. It was not: `alerting.telegram_delivery`
// appeared in no check list, so the rows piled up in a table nobody graded. A
// guarantee asserted in a comment and enforced by nothing is worse than no
// guarantee, because it gets believed.
const DEPLOY_CHECKS_SRC = readFileSync("lib/health/deploy-checks.ts", "utf8");
assert.match(
  DEPLOY_CHECKS_SRC,
  /id: "alerting\.delivery_failures"/,
  "nothing grades the telegram_delivery rows again — the documented backstop does not exist",
);
assert.match(
  DEPLOY_CHECKS_SRC,
  /\.eq\("check_id", "alerting\.telegram_delivery"\)/,
  "the alerting check no longer reads the rows it exists to read",
);

// ── and the reader is exercised, not merely declared ───────────────────────

// The assertions above are greps: they prove the check EXISTS. That is exactly
// the weak form that let the favicon fix ship inert — every assertion about it
// was true and the thing still did nothing. So drive the real observe() and
// assert the query it actually builds.
//
// (A second copy of this stub lives in tests/extraction-queue-stalled.test.ts.
// Two copies is not yet a shared helper; a third use is when to extract it.)
function recordingDb(result: { count?: number; error?: { message: string } }) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {};
  for (const fn of ["select", "eq", "in", "lt", "gte", "gt", "lte", "order", "limit"]) {
    builder[fn] = (...args: unknown[]) => {
      calls.push({ fn, args });
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return {
    db: {
      from: (table: string) => {
        calls.push({ fn: "from", args: [table] });
        return builder;
      },
    },
    calls,
  };
}

type AlertStateRow = {
  alert_key: string;
  tenant_id: string;
  last_signature: string | null;
  last_alerted_at: string | null;
  repeat_n: number | null;
  first_failed_at: string | null;
  updated_at: string;
};

/** Minimal in-memory adapter that drives the runner's actual state machine. */
function tenantIsolationDb() {
  const states = new Map<string, AlertStateRow>();
  const stateReadFilters: Array<Record<string, string>> = [];
  const runRows: Array<Record<string, unknown>> = [];

  const db = {
    from(table: string) {
      if (table === "health_check_runs") {
        return {
          insert(row: Record<string, unknown>) {
            runRows.push(row);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      if (table !== "health_alert_state") throw new Error(`unexpected table ${table}`);
      return {
        select() {
          const filters: Record<string, string> = {};
          const query = {
            eq(column: string, value: string) {
              filters[column] = value;
              return query;
            },
            async maybeSingle() {
              stateReadFilters.push({ ...filters });
              const row = states.get(filters.alert_key);
              return {
                data: row && row.tenant_id === filters.tenant_id ? { ...row } : null,
                error: null,
              };
            },
          };
          return query;
        },
        upsert(row: AlertStateRow) {
          const existing = states.get(row.alert_key);
          if (existing && existing.tenant_id !== row.tenant_id) {
            return Promise.reject(new Error("cross-tenant alert-state overwrite"));
          }
          states.set(row.alert_key, { ...row });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  return { db, states, stateReadFilters, runRows };
}

const TENANT = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const NOW = Date.parse("2026-09-19T12:00:00.000Z");

async function main() {
  const alerting = DEPLOY_CHECKS.find((c) => c.id === "alerting.delivery_failures");
  assert.ok(alerting, "alerting.delivery_failures is not in DEPLOY_CHECKS — it runs nowhere");

  {
    const { db, calls } = recordingDb({ count: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const observed = await alerting!.observe(db as any, TENANT, NOW);
    assert.equal(observed, 0, "a clean window must read as zero, not null");

    assert.deepEqual(
      calls.find((c) => c.fn === "from")?.args,
      ["health_check_runs"],
      "the alerting check reads the wrong table",
    );
    assert.ok(
      calls.some((c) => c.fn === "eq" && c.args[0] === "check_id" && c.args[1] === "alerting.telegram_delivery"),
      "the check no longer filters to the delivery-failure rows — it would count every health row ever written",
    );
    assert.equal(
      calls.some((c) => c.fn === "eq" && c.args[0] === "tenant_id"),
      false,
      "delivery is estate-wide: an OASIS Calendar page rejected by Telegram must not disappear " +
        "because the scheduler also grades SunBiz outcomes",
    );
    // Bounded, unlike the stall check. A delivery failure from last month is
    // history; this one must be able to go green once the channel is repaired,
    // or nobody will believe it when it goes red.
    const since = calls.find((c) => c.fn === "gte" && c.args[0] === "ran_at");
    assert.ok(since, "the alerting check looks back forever — it can never recover to green");
    assert.equal(
      NOW - Date.parse(since!.args[1] as string),
      6 * 3_600_000,
      "the alerting window moved off 6h",
    );
  }

  {
    const { db } = recordingDb({ error: { message: "turso unreachable" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const observed = await alerting!.observe(db as any, TENANT, NOW);
    assert.equal(observed, null, "a failed query must not read as 'no delivery failures'");
    assert.equal(
      evaluate(alerting!.id, alerting!.rule, observed, []).verdict,
      "check_broken",
      "a check that could not run must never read as ok",
    );
  }

  assert.equal(evaluate(alerting!.id, alerting!.rule, 0, []).verdict, "ok");
  assert.equal(
    evaluate(alerting!.id, alerting!.rule, 1, []).verdict,
    "failing",
    "one undelivered page is already an audience hearing nothing",
  );

  // Drive the real runner twice with the same check id in two tenants. This is
  // behavioral coverage: both alert, both retain independent state, and one
  // tenant recovering cannot close the other tenant's incident.
  {
    const tenantA = "11111111-1111-4111-8111-111111111111";
    const tenantB = "22222222-2222-4222-8222-222222222222";
    const observed = new Map([[tenantA, 1], [tenantB, 1]]);
    const deliveries: Array<{ message: string; lane: string | undefined }> = [];
    const memory = tenantIsolationDb();
    const sharedCheck = {
      id: "shared.synthetic_failure",
      severity: "critical" as const,
      lane: "operator" as const,
      rule: { kind: "must_be_zero" as const },
      observe: async (_db: unknown, tenantId: string) => observed.get(tenantId) ?? 0,
      describe: () => "synthetic failure",
    };
    const send = async (message: string, options?: { lane?: string }) => {
      deliveries.push({ message, lane: options?.lane });
      return { ok: true };
    };

    for (const tenantId of [tenantA, tenantB]) {
      await runHealthChecks(tenantId, {
        nowMs: NOW,
        checks: [sharedCheck],
        db: memory.db as never,
        sendTelegramImpl: send as never,
      });
    }

    assert.equal(deliveries.length, 2, "each tenant's first failure must page independently");
    assert.deepEqual(
      [...memory.states.keys()].sort(),
      [
        healthAlertStateKey(tenantA, sharedCheck.id),
        healthAlertStateKey(tenantB, sharedCheck.id),
      ].sort(),
      "the same check id must persist as two tenant-qualified alert episodes",
    );
    assert.ok(
      memory.stateReadFilters.some((filters) => filters.tenant_id === tenantA),
      "tenant A state read was not tenant-scoped",
    );
    assert.ok(
      memory.stateReadFilters.some((filters) => filters.tenant_id === tenantB),
      "tenant B state read was not tenant-scoped",
    );

    observed.set(tenantA, 0);
    await runHealthChecks(tenantA, {
      nowMs: NOW + 15 * 60_000,
      checks: [sharedCheck],
      db: memory.db as never,
      sendTelegramImpl: send as never,
    });

    assert.equal(
      memory.states.get(healthAlertStateKey(tenantA, sharedCheck.id))?.first_failed_at,
      null,
      "tenant A recovery did not close tenant A's episode",
    );
    assert.notEqual(
      memory.states.get(healthAlertStateKey(tenantB, sharedCheck.id))?.first_failed_at,
      null,
      "tenant A recovery closed tenant B's episode",
    );
  }
}
assert.match(
  DEPLOY_CHECKS_SRC,
  /id: "alerting\.delivery_failures"[\s\S]{0,900}lane: \["operator", "sunbiz-ops"\]/,
  "the alerting check no longer names both lanes — whichever audience can still be reached must hear it",
);
// Production serving the wrong commit is estate-wide; it had been inheriting
// the runner's sunbiz-ops default, so an OASIS-only regression would have
// paged the client's ops channel and nobody else.
assert.match(
  DEPLOY_CHECKS_SRC,
  /id: "deploy\.prod_serves_main"[\s\S]{0,700}lane: \["operator", "sunbiz-ops"\]/,
  "deploy.prod_serves_main inherits the default lane again — an estate-wide fault paging one company",
);

main().then(
  () => console.log("health-recovery-delivery: all assertions passed"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
