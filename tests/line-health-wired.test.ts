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

console.log("line-health-wired.test.ts — all assertions passed");
