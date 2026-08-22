/**
 * tests/guard-audit.test.ts — the self-check that would have caught all three
 * of 2026-08-20's bugs.
 *
 * Each one existed, ran, raised no error, and affected nothing:
 *   1. a thread matcher gating on a provider field the provider stopped sending
 *      (excluded 100% of candidates; delivery verification died estate-wide)
 *   2. a reconciler hardcoding one account's credentials (one wire's receipts
 *      never readable, stuck at check_attempts=0 forever)
 *   3. a routing list missing a stage (25 texts silently pointed at a dead wire)
 *
 * Two questions catch all three. Did you act on anything? Did you act on
 * everything?
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  auditInstruments, reportable, summarize, type InstrumentReading,
} from "../lib/health/guard-audit-core";

const r = (over: Partial<InstrumentReading>): InstrumentReading => ({
  id: "x", considered: 10, acted: 3, expectation: "expect_action", what: "a thing", ...over,
});

// ── BUG 1: the 100%-exclusion filter ─────────────────────────────────────
// matchThreadMessage rejected every candidate because an optional field went
// missing. Nothing errored; it looked like nobody was texting.
{
  const f = auditInstruments([r({ id: "sms.thread_matcher", considered: 40, acted: 40, expectation: "must_not_be_total" })]);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "high");
  assert.match(f[0].message, /excluded ALL 40/);
  assert.match(f[0].message, /quiet upstream/);
}
// Excluding SOME is the normal, healthy case.
{
  const f = auditInstruments([r({ considered: 40, acted: 12, expectation: "must_not_be_total" })]);
  assert.deepEqual(reportable(f), [], "a filter doing its job is not a finding");
}

// ── BUG 2: the mechanism that never fired ────────────────────────────────
// The reconciler had work queued and resolved none of it for four days.
{
  const f = auditInstruments([r({ id: "sms.reconciler", considered: 15, acted: 0, expectation: "expect_action" })]);
  assert.equal(f[0].severity, "high");
  assert.match(f[0].message, /saw 15 item\(s\) and acted on none/);
  assert.match(f[0].message, /unwired|match condition/);
}

// ── NOT KNOWING IS A FINDING, not a skip ─────────────────────────────────
// The whole lesson of 2026-08-16 is that an absent signal reads identically to
// a healthy one. Dropping unreadable instruments would reproduce the bug.
for (const broken of [{ considered: null }, { acted: null }, { considered: null, acted: null }]) {
  const f = auditInstruments([r(broken as Partial<InstrumentReading>)]);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "high", `unreadable reading ${JSON.stringify(broken)} must be reported`);
  assert.match(f[0].message, /could not be measured/);
}

// ── A guard we HOPE never fires is not a problem ─────────────────────────
// The circuit breaker firing zero times is the good outcome. Reporting it at
// high severity would train the reader to ignore the report.
{
  const f = auditInstruments([r({ id: "sms.breaker", considered: 500, acted: 0, expectation: "zero_is_fine" })]);
  assert.equal(f[0].severity, "info");
  assert.deepEqual(reportable(f), []);
}

// ── Nothing to examine is info, not failure ──────────────────────────────
// Worth saying once: an instrument with no input for a week may be watching
// something that no longer happens.
{
  const f = auditInstruments([r({ considered: 0, acted: 0 })]);
  assert.equal(f[0].severity, "info");
  assert.match(f[0].message, /nothing to examine/);
}
// ...and that holds even for an exclusion filter, which must not be accused of
// excluding everything when it saw nothing.
{
  const f = auditInstruments([r({ considered: 0, acted: 0, expectation: "must_not_be_total" })]);
  assert.equal(f[0].severity, "info");
  assert.doesNotMatch(f[0].message, /excluded ALL/);
}

// ── The summary states the DENOMINATOR ───────────────────────────────────
// "3 findings" invites the reader to assume everything else was checked and
// passed. "3 of 9" tells them how much of the estate is actually covered.
{
  const readings = [
    r({ id: "a", considered: 10, acted: 5 }),
    r({ id: "b", considered: 10, acted: 0 }),
    r({ id: "c", considered: null }),
  ];
  const s = summarize(readings, auditInstruments(readings));
  assert.match(s, /2 of 3/);

  const clean = [r({ id: "a" }), r({ id: "b" })];
  assert.match(summarize(clean, auditInstruments(clean)), /all 2 instrument/);
}

// ── THE AUDIT IS ACTUALLY RUN, on a schedule ─────────────────────────────
// reportCoverageGap in runner.ts was written, exported, and called from
// nowhere — a monitor that never runs, which is the very bug class this audit
// exists to catch. So the wiring is asserted, not assumed.
{
  const route = readFileSync(new URL("../app/api/cron/health-check/route.ts", import.meta.url), "utf8");
  assert.ok(
    route.includes("await runGuardAudit(SUNBIZ_TENANT_ID)"),
    "the guard audit must be invoked by the health cron, or it is decorative",
  );
  assert.ok(
    route.includes("announceGuardAudit(SUNBIZ_TENANT_ID, guards)"),
    "and its findings must be announced, not just returned in a JSON body nobody reads",
  );
  // A broken self-check must never take down the health check it rides on.
  assert.ok(
    route.includes("runGuardAudit(SUNBIZ_TENANT_ID).catch(() => null)"),
    "audit failures are swallowed",
  );
  assert.ok(
    route.includes('{ summary: "guard audit could not run", findings: [] }'),
    "and a failed audit says so in the response rather than reporting an empty, healthy-looking result",
  );

  const impl = readFileSync(new URL("../lib/health/guard-audit.ts", import.meta.url), "utf8");
  // The reading is a 7-day window and the cron runs every 15 minutes. Alerting
  // per tick would repeat the same sentence 96 times a day and get the channel
  // muted, which is how a real alert goes unread.
  assert.ok(impl.includes("nowMs - lastAt < DAY"), "must not re-page more than once a day for the same condition");
  assert.ok(
    impl.includes("const sameCondition = row?.last_signature === signature;"),
    "a DIFFERENT set of broken instruments is a new condition and must page immediately",
  );
}

console.log("guard-audit.test.ts — all assertions passed");
