/**
 * tests/health-alert-backoff.test.ts — COUNT THE PAGES.
 *
 * Per the alert-decay-discipline rule: a rate limiter you have never watched
 * suppress anything is a rate limiter you are guessing about. So this file
 * simulates a 24-hour outage tick by tick and counts actual pages, rather than
 * asserting that the function ran.
 *
 * It also runs the SAME simulation against the old flat-window policy to prove
 * the bound is not vacuous. A bound that passes for every policy tests nothing.
 */
import assert from "node:assert/strict";
import {
  LADDER_MS,
  claimAlertSlot,
  clearCondition,
  conditionKey,
  ladderDelayMs,
} from "../lib/health/alert-backoff";

/* -------------------------------------------------------------- */
/* Minimal in-memory stand-in for the PostgREST surface used here. */
/* -------------------------------------------------------------- */
type Row = Record<string, unknown>;

function makeFakeDb() {
  const table = new Map<string, Row>();

  const client = {
    from(_name: string) {
      return {
        select(_cols: string) {
          const filters: Row = {};
          const q = {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return q;
            },
            async maybeSingle<T>() {
              const key = filters.condition_key as string;
              const row = table.get(key);
              return { data: (row as T) ?? null, error: null };
            },
          };
          return q;
        },
        async upsert(row: Row, _opts?: unknown) {
          table.set(row.condition_key as string, { ...table.get(row.condition_key as string), ...row });
          return { error: null };
        },
        update(patch: Row) {
          const filters: Row = {};
          const q = {
            eq(col: string, val: unknown) {
              filters[col] = val;
              // Terminal await: resolve once the caller stops chaining.
              return Object.assign(
                Promise.resolve().then(() => {
                  const key = filters.condition_key as string;
                  const row = table.get(key);
                  if (!row) return { error: null };
                  for (const [c, v] of Object.entries(filters)) {
                    if (c === "condition_key") continue;
                    if (row[c] !== v) return { error: null }; // guard did not match
                  }
                  table.set(key, { ...row, ...patch });
                  return { error: null };
                }),
                q,
              );
            },
          };
          return q;
        },
      };
    },
    _table: table,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client as any;
}

/* -------------------------------------------------------------- */
/* 1. Condition keys are stable across changing message text.      */
/* -------------------------------------------------------------- */
{
  const a = conditionKey("feature_health", "down", "sms.drip.sends");
  const b = conditionKey("feature_health", "down", "sms.drip.sends");
  assert.equal(a, b, "the same condition must produce the same key");
  assert.equal(a, "feature_health:down:sms.drip.sends");

  // The failure this prevents: keying on a message that embeds a count or a
  // timestamp produces a fresh key every tick and dedups nothing.
  const m1 = "SMS drip down (3 failures at 14:02)";
  const m2 = "SMS drip down (7 failures at 14:17)";
  assert.notEqual(m1, m2, "message text genuinely differs tick to tick");
  assert.equal(
    conditionKey("feature_health", "down", "sms.drip.sends"),
    conditionKey("feature_health", "down", "sms.drip.sends"),
    "...but the key derived from the condition does not",
  );
}

/* -------------------------------------------------------------- */
/* 2. THE PAGE COUNT over a simulated 24h permanent outage.        */
/* -------------------------------------------------------------- */
const TICK_MS = 15 * 60_000; // the scanner's real cadence
const DAY_MS = 24 * 60 * 60_000;

async function countPagesOverOutage(durationMs: number): Promise<number> {
  const db = makeFakeDb();
  const key = "feature_health:down:sms.drip.sends";
  let pages = 0;
  for (let t = 0; t <= durationMs; t += TICK_MS) {
    const decision = await claimAlertSlot(db, key, {
      component: "feature_health",
      scope: "sms.drip.sends",
      // Text changes every tick on purpose — it must not affect suppression.
      text: `SMS drip down (${t / TICK_MS} bad ticks)`,
      now: new Date(t),
    });
    if (decision.notify) pages++;
  }
  return pages;
}

async function main() {
  {
    const pages = await countPagesOverOutage(DAY_MS);
    assert.ok(pages <= 5, `ladder must not be an alarm clock: got ${pages} pages in 24h`);
    assert.ok(pages >= 2, `ladder must not go silent either: got ${pages} pages in 24h`);
    console.log(`  24h permanent outage -> ${pages} pages (immediate, +1h, +3h, +12h, daily)`);
  }

  /* ------------------------------------------------------------ */
  /* 3. Prove the bound FIRES against the old flat-window policy.  */
  /*    Without this, `pages <= 5` might pass for any policy.      */
  /* ------------------------------------------------------------ */
  {
    const FLAT_WINDOW_MS = 3 * 60 * 60 * 1000; // the policy this replaced
    let flatPages = 0;
    let lastAlert = -Infinity;
    for (let t = 0; t <= DAY_MS; t += TICK_MS) {
      if (t - lastAlert >= FLAT_WINDOW_MS) {
        flatPages++;
        lastAlert = t;
      }
    }
    assert.ok(
      flatPages > 5,
      `the old flat 3h window should BREACH the bound (got ${flatPages}); if it does not, the bound is vacuous`,
    );
    console.log(
      `  same outage under the old flat 3h window -> ${flatPages} pages (breaches the bound)`,
    );
  }

  /* ------------------------------------------------------------ */
  /* 4. Clear on recovery: the next breach pages IMMEDIATELY.      */
  /*    Forgetting this is the classic bug — a flapping check      */
  /*    recovers once and then stays quiet for 24h.                */
  /* ------------------------------------------------------------ */
  {
    const db = makeFakeDb();
    const key = "feature_health:down:forms.submissions";
    const opts = { component: "feature_health", scope: "forms.submissions", text: "down" };

    for (let t = 0; t <= DAY_MS; t += TICK_MS) {
      await claimAlertSlot(db, key, { ...opts, now: new Date(t) });
    }
    const highRung = db._table.get(key)?.rung as number;
    assert.ok(highRung >= 3, `expected to climb the ladder, got rung ${highRung}`);

    await clearCondition(db, key, new Date(DAY_MS + TICK_MS));

    const after = await claimAlertSlot(db, key, { ...opts, now: new Date(DAY_MS + 2 * TICK_MS) });
    assert.equal(after.notify, true, "a breach after recovery must page immediately");
    assert.equal(after.reason, "first", "and must restart the ladder at rung 0");
    assert.equal(after.rung, 0);
  }

  /* ------------------------------------------------------------ */
  /* 5. Restart safety: state is in the DB, not a module latch.    */
  /* ------------------------------------------------------------ */
  {
    const db = makeFakeDb();
    const key = "feature_health:down:email.outbound";
    const opts = { component: "feature_health", scope: "email.outbound", text: "down" };

    const first = await claimAlertSlot(db, key, { ...opts, now: new Date(0) });
    assert.equal(first.notify, true, "first breach pages");

    // Simulate a crash-loop: the worker restarts and immediately re-evaluates.
    // A module-scope `let alerted = false` would page again on every restart.
    for (let i = 1; i <= 10; i++) {
      const again = await claimAlertSlot(db, key, { ...opts, now: new Date(i * 60_000) });
      assert.equal(again.notify, false, `restart #${i} must not re-page inside the first hour`);
    }
  }

  /* ------------------------------------------------------------ */
  /* 6. Ladder shape                                               */
  /* ------------------------------------------------------------ */
  assert.equal(ladderDelayMs(0), 0, "rung 0 is immediate");
  assert.equal(ladderDelayMs(1), 60 * 60_000);
  assert.equal(ladderDelayMs(2), 3 * 60 * 60_000);
  assert.equal(ladderDelayMs(3), 12 * 60 * 60_000);
  assert.equal(ladderDelayMs(4), 24 * 60 * 60_000);
  assert.equal(
    ladderDelayMs(99),
    LADDER_MS[LADDER_MS.length - 1],
    "the top rung repeats forever, so an outage can never hide",
  );

  console.log("health-alert-backoff.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
