/**
 * tests/lender-auto-route.test.ts — when a lender's reply may move the deal.
 *
 * Adon, 2026-08-12: "move the clear ones, flag the rest."
 *
 * THE ASYMMETRY IS THE WHOLE TEST. A deal is shopped to several funders at
 * once, so an approval and a decline do not carry the same weight:
 *
 *   an APPROVAL is a fact about the DEAL   -> the first clean one moves it
 *   a DECLINE is a fact about that FUNDER  -> needs unanimity, and silence from
 *                                             anyone still out is not a decline
 *
 * Reading a single decline as "the deal is dead" would kill live files every
 * time the first funder passed, which is the ordinary case in this business.
 *
 * This rule decides what happens to a real merchant's live funding, and since
 * 2026-08-12 the application's status ALSO decides whether that merchant keeps
 * receiving drip email (lib/drips/deal-state.ts). Both consequences ride on
 * these assertions.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { CRON_TABLE } from "../workers/oasis-cc-cron/src/index";
import {
  planApplicationRoute,
  minConfidenceFromEnv,
  autoRouteLive,
  DEFAULT_MIN_CONFIDENCE,
} from "../lib/lenders/auto-route";

const HIGH = 0.95;
/** Every call needs provenance + a routable current status; the two guards
 *  below own those dimensions and the rest of the file holds them fixed. */
const OK = { hasMatchedThread: true, currentStatus: "application_in" };
const sent = { status: "sent" };
const noResp = { status: "no_response" };
const declined = { status: "declined" };
const approved = { status: "approved" };
const errored = { status: "error" };

// ---------------------------------------------------------------------------
// APPROVAL — one funder saying yes is a fact about the deal.
// ---------------------------------------------------------------------------
{
  const d = planApplicationRoute({
    threads: [sent, noResp, declined],
    reply: { category: "approved", confidence: HIGH },
    ...OK,
  });
  assert.equal(d.move, true, "one clean approval moves the deal even with others still out");
  assert.equal(d.move === true && d.to, "approved");
}

// ---------------------------------------------------------------------------
// DECLINE — the case that must NOT move, and the reason this file exists.
// ---------------------------------------------------------------------------
{
  const d = planApplicationRoute({
    threads: [declined, sent, noResp],
    reply: { category: "declined", confidence: HIGH },
    ...OK,
  });
  assert.equal(d.move, false, "ONE decline out of three must never kill a live deal");
  assert.match(d.move === false ? d.reason : "", /still_out/);
}

// Unanimous, nobody outstanding — the deal really is dead.
{
  const d = planApplicationRoute({
    threads: [declined, declined, declined],
    reply: { category: "declined", confidence: HIGH },
    ...OK,
  });
  assert.equal(d.move, true);
  assert.equal(d.move === true && d.to, "declined");
}

// An approval sitting on another thread means the deal is alive, whatever this
// funder just said.
assert.equal(
  planApplicationRoute({
    threads: [declined, declined, approved],
    reply: { category: "declined", confidence: HIGH },
    ...OK,
  }).move,
  false,
  "a live approval elsewhere outranks a decline",
);

// A FAILED SEND IS AN UNASKED FUNDER, not a silent decline. Treating `error` as
// answered would let a delivery bug read as unanimous rejection — the same
// "failure becomes a plausible answer" shape this estate has been bitten by.
{
  const d = planApplicationRoute({
    threads: [declined, declined, errored],
    reply: { category: "declined", confidence: HIGH },
    ...OK,
  });
  assert.equal(d.move, false, "a thread that errored was never actually asked");
  assert.match(d.move === false ? d.reason : "", /still_out/);
}

// No visible threads is not unanimity. It is a partial view, and refusing here
// is the difference between "every funder passed" and "we know of one funder".
assert.equal(
  planApplicationRoute({ threads: [], reply: { category: "declined", confidence: HIGH }, ...OK }).move,
  false,
);

// ---------------------------------------------------------------------------
// CONFIDENCE — a guess is not a decision, and it is checked for approvals too.
// An uncertain "approved" is exactly the reading that would move a deal to
// Approved on a funder's polite maybe.
// ---------------------------------------------------------------------------
for (const category of ["approved", "declined"]) {
  const d = planApplicationRoute({
    threads: [declined, declined],
    reply: { category, confidence: 0.6 },
    ...OK,
    minConfidence: 0.8,
  });
  assert.equal(d.move, false, `a 0.6-confidence ${category} must not move the deal`);
  assert.match(d.move === false ? d.reason : "", /low_confidence/);
}
// A missing confidence is not a high one.
assert.equal(
  planApplicationRoute({ threads: [declined], reply: { category: "approved" }, ...OK }).move,
  false,
  "absent confidence must read as zero, never as certain",
);

// ---------------------------------------------------------------------------
// EVERYTHING ELSE IS FLAGGED, NOT ROUTED. A counter-offer is a negotiation, an
// info request is a task, an unknown is an unknown. None are decisions a
// classifier gets to make about someone's funding.
// ---------------------------------------------------------------------------
for (const category of ["counter_offer", "info_needed", "submitted", "unknown", ""]) {
  const d = planApplicationRoute({
    threads: [declined],
    reply: { category, confidence: 1 },
    ...OK,
  });
  assert.equal(d.move, false, `${category || "(empty)"} must never auto-route`);
  assert.match(d.move === false ? d.reason : "", /not_a_decision/);
}

// Hand-entered casing must not change a funding decision.
assert.equal(
  planApplicationRoute({ threads: [declined], reply: { category: "  APPROVED ", confidence: HIGH }, ...OK }).move,
  true,
);
assert.equal(
  planApplicationRoute({
    threads: [{ status: " DECLINED " }, { status: "Declined" }],
    reply: { category: "declined", confidence: HIGH },
    ...OK,
  }).move,
  true,
);

// ---------------------------------------------------------------------------
// PROVENANCE BEFORE CONTENT (Codex review P1, 2026-08-12).
//
// Replies are matched to a deal by the business name in the SUBJECT, and to a
// lender by the SENDER, separately. An approval moves the deal without
// consulting the thread list at all — one yes is enough — so without this
// guard anyone emailing submissions@ with `Re: New Deal (Some Business)` and
// approving-sounding text could move a live file to Approved.
//
// That is untrusted inbound email driving a side effect, which the LLM-input
// boundary rule forbids outright. An unmatched sender gets no say in a deal's
// state, however confidently its message reads.
// ---------------------------------------------------------------------------
for (const category of ["approved", "declined"]) {
  const d = planApplicationRoute({
    threads: [declined, declined],
    reply: { category, confidence: 1 },
    hasMatchedThread: false,
    currentStatus: "application_in",
  });
  assert.equal(d.move, false, `an unmatched sender must not route a deal (${category})`);
  assert.equal(d.move === false && d.reason, "no_matched_lender_thread");
}

// ---------------------------------------------------------------------------
// A LATE REPLY MUST NOT REGRESS A CLOSED DEAL (Codex review P1, 2026-08-12).
//
// A funder's approval landing a week after the deal FUNDED would otherwise drag
// it back to `approved` — and since 2026-08-12 that also restarts the
// merchant's drip email. Same for a late unanimous decline overwriting a funded
// file. The router only ever moves a deal that is still in the shopping phase.
// ---------------------------------------------------------------------------
for (const closed of ["funded", "declined", "dead_file", "default", "docs_out", "login", "requested_docs", "approved"]) {
  const d = planApplicationRoute({
    threads: [declined, declined],
    reply: { category: "approved", confidence: HIGH },
    hasMatchedThread: true,
    currentStatus: closed,
  });
  assert.equal(d.move, false, `a deal at ${closed} is not the router's to move`);
  assert.match(d.move === false ? d.reason : "", /not_routable_from/);
}
// The shopping-phase states it MAY move, including the blank one every
// app-created application carries until someone touches it.
for (const open of ["", "application_in", "shopping", "  Application_In  "]) {
  assert.equal(
    planApplicationRoute({
      threads: [sent],
      reply: { category: "approved", confidence: HIGH },
      hasMatchedThread: true,
      currentStatus: open,
    }).move,
    true,
    `a deal at "${open}" is still in play`,
  );
}
// An absent status is the blank case, not an unknown one.
assert.equal(
  planApplicationRoute({
    threads: [sent],
    reply: { category: "approved", confidence: HIGH },
    hasMatchedThread: true,
  }).move,
  true,
);

// ---------------------------------------------------------------------------
// The env gates fail SAFE. A blank or nonsense threshold must not read as 0,
// which would auto-route every guess the classifier makes.
// ---------------------------------------------------------------------------
{
  const prev = process.env.LENDER_AUTOROUTE_MIN_CONFIDENCE;
  for (const bad of ["", "   ", "abc", "0", "-1", "2"]) {
    process.env.LENDER_AUTOROUTE_MIN_CONFIDENCE = bad;
    assert.equal(minConfidenceFromEnv(), DEFAULT_MIN_CONFIDENCE, `"${bad}" must fall back to the default`);
  }
  process.env.LENDER_AUTOROUTE_MIN_CONFIDENCE = "0.9";
  assert.equal(minConfidenceFromEnv(), 0.9, "a real value is honoured");
  if (prev === undefined) delete process.env.LENDER_AUTOROUTE_MIN_CONFIDENCE;
  else process.env.LENDER_AUTOROUTE_MIN_CONFIDENCE = prev;
}

// The master switch is OFF unless explicitly "1". Everything ships inert.
{
  const prev = process.env.LENDER_AUTOROUTE_LIVE;
  for (const off of [undefined, "", "0", "true", "yes", "TRUE"]) {
    if (off === undefined) delete process.env.LENDER_AUTOROUTE_LIVE;
    else process.env.LENDER_AUTOROUTE_LIVE = off;
    assert.equal(autoRouteLive(), false, `LENDER_AUTOROUTE_LIVE=${String(off)} must not arm it`);
  }
  process.env.LENDER_AUTOROUTE_LIVE = "1";
  assert.equal(autoRouteLive(), true);
  if (prev === undefined) delete process.env.LENDER_AUTOROUTE_LIVE;
  else process.env.LENDER_AUTOROUTE_LIVE = prev;
}

// ---------------------------------------------------------------------------
// THE SCANNER IS GONE. /api/cron/scan-lender-replies served SunBiz only; it was
// unscheduled when SunBiz retired (2026-09-28, runbook C-6a) and deleted on
// 2026-10-01 with the other SunBiz-only cron routes (OS plan W0). The rule
// above is pure and stays pinned; the registration assertions are kept
// inverted so re-adding the route or a schedule for it fails here by name.
// ---------------------------------------------------------------------------
{
  const read = (p: string) => readFileSync(p, "utf8");
  const SCANNER = "/api/cron/scan-lender-replies";
  assert.equal(existsSync("app/api/cron/scan-lender-replies"), false, "the retired lender scanner route is back");
  const registry = JSON.parse(read("config/cron-registry.json")) as { crons?: Array<{ path: string }> };
  assert.ok(
    !(registry.crons ?? []).some((c) => c.path.split("?")[0] === SCANNER),
    "config/cron-registry.json must not schedule the retired lender scanner",
  );
  assert.ok(
    !CRON_TABLE.some((c) => c.path.split("?")[0] === SCANNER),
    "the cron Worker must not schedule the retired lender scanner",
  );
  assert.ok(
    !read(".github/workflows/cron-driver.yml").includes(SCANNER),
    "the GitHub cron driver must not drive the retired lender scanner",
  );

  // updateRecord's compare-and-set guard is app-wide (every manifest record
  // write), not the scanner's; it stays pinned.
  {
    const data = read("lib/manifest/data.ts");
    assert.ok(data.includes("ifMatch"), "updateRecord must support the guard");
    // The guard on the same statement is the whole point; asserting it sits
    // before the write's .select keeps a refactor from splitting it back out.
    // Scoped to updateRecord's own body — publishStatusChange also appears in
    // this file's imports and in createRecord, so an unscoped indexOf compares
    // against the wrong occurrence.
    const body = data.slice(data.indexOf("export async function updateRecord"));
    const guardAt = body.indexOf("input.ifMatch.value === null");
    const hooksAt = body.indexOf("runStageTransitionHooks(");
    assert.ok(guardAt > 0, "updateRecord must apply the guard");
    assert.ok(
      guardAt < hooksAt,
      "the guard must be applied before the transition side effects are emitted",
    );
    // An absent field is guarded with null; `data->>x = ''` never matches a
    // missing key, so an empty-string guard would refuse forever.
    assert.ok(/\.is\(`data->>\$\{input\.ifMatch\.field\}`, null\)/.test(data),
      "an absent field must be guarded with is-null, not eq-empty-string");
    // AND the row version. updateRecord replaces the whole data document, so a
    // single-field guard still lets a concurrent edit to any OTHER field be
    // overwritten by the stale merge — a field check wearing the name of
    // concurrency control.
    assert.ok(/writeQ\.eq\("updated_at", existing\.updated_at\)/.test(data),
      "a guarded update must pin the row version, not just the one field");
  }
}

console.log("lender-auto-route.test.ts — one lender is not the deal ✓");
