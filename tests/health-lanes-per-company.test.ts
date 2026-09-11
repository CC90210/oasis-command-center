/**
 * tests/health-lanes-per-company.test.ts — each company's health alerts reach
 * that company's operators, and only theirs.
 *
 * OASIS AI and SunBiz are separate companies that share one health runner.
 * Before this, a check written without a lane defaulted to sunbiz-ops, and the
 * coverage-gap report posted every uncovered cron route — OASIS-only routes
 * included — to sunbiz-ops. These assertions pin the split, so a new check or a
 * new cron route cannot quietly land in the other company's channel.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DRIP_CHECKS } from "../lib/health/drip-checks";
import { emailDripChecks } from "../lib/health/email-drip-checks";
import { FORM_CHECKS } from "../lib/health/form-checks";
import { DEPLOY_CHECKS } from "../lib/health/deploy-checks";
import { CALENDAR_CHECKS } from "../lib/health/calendar-checks";
import {
  computeCoverage,
  coverageGapMessages,
  companyForCoverageId,
  cronPathsFrom,
  CRON_ROUTE_COMPANY,
  COMPANY_LANE,
} from "../lib/health/coverage";

const LANES = new Set(["operator", "sunbiz-ops"]);

// ── 1. Every check names its lane; nothing falls back to one ────────────────
const groups = {
  DRIP_CHECKS,
  emailDripChecks: emailDripChecks(),
  FORM_CHECKS,
  DEPLOY_CHECKS,
  CALENDAR_CHECKS,
};
for (const [name, list] of Object.entries(groups)) {
  for (const c of list) {
    assert.ok(LANES.has(c.lane), `${name}/${c.id} must declare its lane, got ${String(c.lane)}`);
  }
}

// Making the field required moved no alert: SunBiz's drip, form and deploy
// checks stay on sunbiz-ops, and OASIS's calendar check stays on CC's lane.
for (const c of [...DRIP_CHECKS, ...emailDripChecks(), ...FORM_CHECKS, ...DEPLOY_CHECKS]) {
  assert.equal(c.lane, "sunbiz-ops", `${c.id} paged sunbiz-ops before this change and must still`);
}
assert.equal(
  CALENDAR_CHECKS.find((c) => c.id === "calendar.workspace_credential_usable")?.lane,
  "operator",
  "the OASIS calendar check stays on CC's lane",
);

const RUNNER = readFileSync("lib/health/runner.ts", "utf8");
const DRIP_SRC = readFileSync("lib/health/drip-checks.ts", "utf8");
assert.ok(/\n  lane: TelegramLane;/.test(DRIP_SRC), "DripCheck.lane must be a required field");
assert.ok(!/\blane\?\s*:/.test(DRIP_SRC), "DripCheck.lane must not be optional");
assert.ok(!/\?\?\s*"sunbiz-ops"/.test(RUNNER), "the runner must not default a lane to sunbiz-ops");
assert.ok(!/lane: "sunbiz-ops"/.test(RUNNER), "the runner must not hardcode one company's lane anywhere");

// ── 2. Every cron route has an owning company, and only real routes do ─────
const registry = JSON.parse(readFileSync("config/cron-registry.json", "utf8"));
const routes = cronPathsFrom(registry).filter((p) => !p.includes("/health-check"));
for (const p of routes) {
  assert.ok(
    Object.prototype.hasOwnProperty.call(CRON_ROUTE_COMPANY, p),
    `${p} is in config/cron-registry.json but CRON_ROUTE_COMPANY (lib/health/coverage.ts) does not say whose it is`,
  );
}
for (const p of Object.keys(CRON_ROUTE_COMPANY)) {
  assert.ok(routes.includes(p), `CRON_ROUTE_COMPANY lists ${p}, which is no longer a registered cron`);
}
assert.equal(COMPANY_LANE.oasis, "operator");
assert.equal(COMPANY_LANE.sunbiz, "sunbiz-ops");

// ── 3. The coverage-gap alert is split: each lane sees only its own ────────
const OASIS_IDS = [
  "cron.reconcile-website-sales-payments.ran",
  "cron.dispatch-founder-meeting-reminders.ran",
  "cron.sms-reply-agent.ran",
  "cron.materialize-plans.ran",
  "brand.oasis.sendable",
];
const SUNBIZ_IDS = [
  "cron.dispatch-drips.ran",
  "cron.scan-lender-replies.ran",
  "cron.sync-tt-inbox.ran",
  "brand.sunbiz.sendable",
  "brand.bluerise.sendable",
];
{
  const cov = computeCoverage({ vercelConfig: registry, knownCheckIds: [] });
  const { messages, unowned } = coverageGapMessages(cov.uncovered, cov.crons);
  assert.deepEqual(unowned, [], "every discovered surface must have an owning company");
  assert.equal(messages.length, 2, "one message per company");
  const cc = messages.find((m) => m.lane === "operator");
  const ops = messages.find((m) => m.lane === "sunbiz-ops");
  assert.ok(cc && ops, "both companies have gaps in the unchecked registry");

  for (const id of OASIS_IDS) {
    assert.ok(cc.ids.includes(id), `${id} must reach OASIS's lane`);
    assert.ok(!ops.ids.includes(id) && !ops.text.includes(id), `${id} is OASIS's and must never reach sunbiz-ops`);
  }
  for (const id of SUNBIZ_IDS) {
    assert.ok(ops.ids.includes(id), `${id} must reach SunBiz's lane`);
    assert.ok(!cc.ids.includes(id) && !cc.text.includes(id), `${id} is SunBiz's and must never reach CC's lane`);
  }
  // Every surface lands in exactly one company's message.
  assert.equal(cc.ids.length + ops.ids.length, cov.uncovered.length);
  for (const id of cc.ids) assert.equal(companyForCoverageId(id), "oasis", id);
  for (const id of ops.ids) assert.equal(companyForCoverageId(id), "sunbiz", id);
  // The footer counts only the audience's own routes and names only its company.
  assert.match(cc.text, /4 OASIS cron routes discovered/);
  assert.ok(!/sunbiz/i.test(cc.text), "CC's message must not mention SunBiz at all");
  assert.match(ops.text, /\d+ SunBiz cron routes discovered/);
  assert.ok(!/oasis/i.test(ops.text), "SunBiz's message must not mention OASIS at all");
}

// A company with nothing uncovered gets no message.
{
  const { messages } = coverageGapMessages(["cron.dispatch-drips.ran"], routes);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].lane, "sunbiz-ops");
}

// A surface nobody classified is sent to NOBODY rather than guessed at.
{
  const odd = ["cron.some-new-route.ran", "drips.new_stage.sent_24h", "brand.unknown.sendable"];
  const { messages, unowned } = coverageGapMessages(odd, routes);
  assert.deepEqual(messages, []);
  assert.deepEqual(unowned, odd);
}

// ── 4. The runner sends each company's message to that company's lane ─────
{
  const start = RUNNER.indexOf("export async function reportCoverageGap");
  const end = RUNNER.indexOf("export async function checkFleetHeartbeat");
  assert.ok(start >= 0 && end > start, "reportCoverageGap must exist");
  const gap = RUNNER.slice(start, end);
  assert.ok(/coverageGapMessages\(cov\.uncovered, cov\.crons\)/.test(gap), "the gap must be split by company");
  assert.ok(/sendTelegram\(m\.text, \{ lane: m\.lane \}\)/.test(gap), "each message goes to its own company's lane");
}

console.log("health-lanes-per-company.test.ts — all assertions passed ✓");
