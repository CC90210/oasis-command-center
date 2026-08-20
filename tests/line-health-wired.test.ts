/**
 * tests/line-health-wired.test.ts — the per-line bench is WIRED INTO dispatch,
 * and wired in the one order that works.
 *
 * Every silent failure found on 2026-08-20 was a rule that existed and was
 * never consulted, or was consulted in a way that could not match. So these
 * assertions are about the call site, not the rule.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const exec = readFileSync(new URL("../lib/drips/executor.ts", import.meta.url), "utf8");

// ── It runs, on this wire's own lines ─────────────────────────────────────
assert.ok(
  exec.includes("const pool = await sendablePool(row.tenant_id, wireLines, { wire });"),
  "dispatch must filter the wire's pool down to lines that are actually delivering",
);
assert.ok(
  /import \{ sendablePool, announceBenchedLines \} from "@\/lib\/sms\/line-health";/.test(exec),
  "and the import must exist",
);

// ── THE ASYMMETRY THAT MAKES THE BREAKER STILL WORK ───────────────────────
// The per-line filter narrows the SENDING pool. The breaker must still read
// EVERY line's receipts. If the breaker were scoped to the survivors it would
// only ever see numbers that are working, and could never halt a dying route —
// each line would be benched one at a time, silently, forever.
{
  const breakerCall = exec.indexOf("smsSendAllowed(row.tenant_id, { wire, onlyLines: wireLines })");
  assert.ok(breakerCall > 0, "the breaker must be scoped to wireLines, NOT to pool.lines");
  assert.ok(
    !exec.includes("smsSendAllowed(row.tenant_id, { wire, onlyLines: pool.lines })"),
    "scoping the breaker to the healthy lines would blind it to the route dying",
  );
  const poolCall = exec.indexOf("const pool = await sendablePool");
  assert.ok(poolCall < breakerCall, "the per-line check runs before the per-wire one");
}

// ── A benched line HOLDS the row, it does not fail it ─────────────────────
// The row is undamaged: another line can pick it up on the next tick, and the
// merchant is not dropped.
assert.ok(
  exec.includes("`sms_line_benched: ${"),
  "a lead assigned to a benched number must hold with a named reason",
);
assert.ok(
  exec.includes("`sms_no_healthy_line: ${pool.reason}`"),
  "an entirely benched pool must hold rather than pick a dead line anyway",
);
{
  const start = exec.indexOf("const pool = await sendablePool");
  const window = exec.slice(start, start + 1400);
  assert.ok(!/markPermanentFail/.test(window), "must never permanently fail a row for a line-health problem");
  assert.ok(/holdOrEmailInstead/.test(window), "must hold, or fall back to email");
}

// ── Alerting can never block a send ───────────────────────────────────────
// The bench decision is already made; a Telegram outage must not also stop
// texting.
assert.ok(
  exec.includes("await announceBenchedLines(row.tenant_id, pool, { wire }).catch(() => undefined);"),
  "alert failures must be swallowed",
);

// ── The alert is keyed on the CONDITION, so it decays ────────────────────
// One ladder in this codebase. Keying on the message would re-page every
// dispatch tick, which is how an alert channel gets muted by its reader.
{
  const lh = readFileSync(new URL("../lib/sms/line-health.ts", import.meta.url), "utf8");
  assert.ok(lh.includes("`sms-line-benched:${wire}:${b.number}`"), "per-line alert key names the line and the wire");
  assert.ok(lh.includes("`sms-wire-halt:${wire}`"), "wire halt has its own condition key");
  assert.ok(lh.includes("shouldAlert("), "must go through the standing decay ladder, not a second one");
  assert.ok(
    lh.includes("if (!decision.send) continue;"),
    "a suppressed alert must skip quietly rather than send anyway",
  );
}

// ── The pool read fails CLOSED ───────────────────────────────────────────
{
  const core = readFileSync(new URL("../lib/sms/line-health-core.ts", import.meta.url), "utf8");
  assert.ok(
    core.includes('return { lines: [], blocked: [], reason: "line health unreadable'),
    "an unreadable history must yield an EMPTY pool, never the full one",
  );
}

// ── CODEX P1: BOTH new mechanisms must have a PRODUCTION CALLER ──────────
// Found in review 2026-08-20, and it is the same bug class the whole day was
// spent on: a mechanism that exists, is correct, and is never invoked.
{
  const lh = readFileSync(new URL("../lib/sms/line-health.ts", import.meta.url), "utf8");

  // 1. The canary allow-list is enforced at DISPATCH, not at resume.
  //    resumePlan() knows which lines cleared, but a script that only raises
  //    the caps cannot stop the executor picking a line the canary just
  //    refused — it would take three PRODUCTION failures per bad line, which on
  //    the six dead numbers is eighteen texts aimed at real merchants.
  assert.ok(
    lh.includes("const canary = await canaryStatus(tenantId, { lines: pool });"),
    "the sending pool must consult canary verdicts on every dispatch",
  );
  assert.ok(
    lh.includes('canary.results.filter((r) => r.verdict === "failed")'),
    "a line that refused a canary must be excluded",
  );
  assert.ok(
    lh.includes("const allowed = lines.filter((n) => !canaryFailed.has(n));"),
    "and the filtered list must be what is returned, not the unfiltered one",
  );
  assert.ok(
    lh.includes("return { lines: allowed,") || /lines: allowed,/.test(lh),
    "the returned pool must be the canary-filtered one",
  );
  // Fail closed: an unreadable canary history must not mean "everything is fine".
  assert.ok(
    lh.includes("canary history unreadable"),
    "an unreadable canary history must empty the pool, not pass it through",
  );

  // 2. Destination health must actually be materialised on a schedule.
  //    refreshDestinationHealth had NO production caller, and a missing row
  //    reads as textable by design, so the landline gate was a permanent no-op.
  const cron = readFileSync(new URL("../app/api/cron/reconcile-sms/route.ts", import.meta.url), "utf8");
  assert.ok(
    cron.includes("await refreshDestinationHealth(t)"),
    "the landline table must be refreshed by a scheduled job, or the gate never has data",
  );
  assert.ok(
    /import \{ refreshDestinationHealth \} from "@\/lib\/sms\/destination-health";/.test(cron),
    "and the import must exist",
  );
  // It must not be able to take down reconciliation, which is the load-bearing
  // job on that route.
  assert.ok(
    cron.includes("refreshDestinationHealth(t).catch("),
    "a refresh failure must not abort the reconcile run",
  );
  // It runs AFTER the verdicts land, or it recomputes from a staler picture
  // than the one that exists at that instant.
  assert.ok(
    cron.indexOf("reconcileReceipts(t,") < cron.indexOf("refreshDestinationHealth(t)"),
    "the refresh must run after reconciliation, not before",
  );
}

console.log("line-health-wired.test.ts — all assertions passed");
