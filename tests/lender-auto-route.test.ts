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
import { readFileSync } from "node:fs";
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
// THE WRITE MUST GO THROUGH updateRecord. A raw
// db.from("tenant_records").update() sits directly above the new call in the
// same function (the offer write), so copying it is the easy mistake — and it
// would move the deal on the board while leaving the drip engine, the timeline
// and stage_entered_at blind to it. That is the two-fields-out-of-sync defect
// this session just spent a day closing, re-entering from a new direction.
// ---------------------------------------------------------------------------
{
  const route = readFileSync("app/api/cron/scan-lender-replies/route.ts", "utf8");
  assert.ok(route.includes("planApplicationRoute("), "the scanner must consult the rule");
  assert.ok(route.includes("updateRecord("), "and move the application through updateRecord");
  const at = route.indexOf("planApplicationRoute(");
  const after = route.slice(at, at + 2500);
  assert.ok(
    !/from\("tenant_records"\)[\s\S]{0,120}\.update\(/.test(after),
    "the routing write must NOT be a raw tenant_records update",
  );
}

// ---------------------------------------------------------------------------
// IT MUST ACTUALLY RUN. The whole reason this build exists is that the scanner
// was never registered anywhere, so it had not written since 2026-08-06 while
// 898 lender threads sat unread. A rule nothing calls is worth nothing.
//
// Registration is TWO facts in this repo: vercel.json declares it, and
// .github/workflows/cron-driver.yml is what actually fires it (Vercel's own
// scheduler was found unreliable — see that file's header). Both are asserted;
// cron-driver-coverage.test.ts enforces the pairing generally, this names the
// route so its removal fails by name.
// ---------------------------------------------------------------------------
{
  const read = (p: string) => readFileSync(p, "utf8");
  assert.ok(
    read("vercel.json").includes("/api/cron/scan-lender-replies"),
    "the scanner must be registered in vercel.json",
  );
  const driver = read(".github/workflows/cron-driver.yml");
  assert.ok(driver.includes("/api/cron/scan-lender-replies"), "and driven by the workflow");
  // BOTH registrations need write=1, not just the driver's. Dry-run is the
  // default, so a scheduled call without it reads the whole inbox, classifies
  // every reply, and stores none of it.
  for (const [name, text] of [["driver", driver], ["vercel.json", read("vercel.json")]] as const) {
    assert.ok(
      /scan-lender-replies\?write=1/.test(text),
      `${name} must drive the scanner with write=1, or it reads and stores nothing`,
    );
  }

  // THE AUTH SHAPE THAT MADE THE FIRST ATTEMPT A NO-OP (Codex review P1).
  //
  // The GitHub driver is what actually fires crons here; it sends the
  // CRON_SECRET bearer and NO x-vercel-cron header. Gating checkCronAuth
  // behind that header meant every scheduled call fell through to the
  // manual-trigger secret, failed it, and 401'd — leaving the scanner exactly
  // as dead as before, which is the one thing this change exists to fix.
  const route = read("app/api/cron/scan-lender-replies/route.ts");
  assert.ok(
    /if \(checkCronAuth\(req\) === null\) return null;/.test(route),
    "checkCronAuth must be TRIED first, unconditionally",
  );

  // COMPARE-AND-SET on the status. updateRecord has no conditional form — it
  // re-reads and merges — so without a claim an operator advancing the deal
  // between the status check and the write is silently overwritten, dragging a
  // funded file back to `approved` on a race.
  assert.ok(
    /status_changed_under_us/.test(route),
    "the routing write must defer when the status moved under it",
  );
  // ATOMIC, not merely narrowed. The guard must ride on the statement that
  // WRITES (updateRecord's ifMatch). A separate claim-then-write leaves the
  // race open, because updateRecord re-reads and merges.
  // BOTH writes are guarded. updateRecord re-reads and merges the WHOLE data
  // document, so even the small flag patch can rewrite an operator's newer
  // status as a side effect.
  assert.equal(
    (route.match(/ifMatch:/g) || []).length,
    2,
    "the routing write AND the flag write must both compare-and-set on status",
  );
  // Provenance requires the thread to belong to the SENDING lender. Phase 1
  // falls back to "the only thread on this deal", which would let lender B's
  // approval move a deal shopped only to lender A.
  assert.ok(
    /c\.thread\.lender_id === c\.lenderId/.test(route),
    "routing provenance must require the thread to match the sending lender",
  );
  // ...and an unambiguous DEAL. Phase 1 matches business names by substring
  // both ways, first-match-wins — "ABC" matches "ABC Holdings" and vice versa.
  // Loose enough for a pill, not for moving someone's funding.
  assert.ok(
    /appMatchUnambiguous/.test(route),
    "routing must require an exact or unique application match, not a substring hit",
  );
  // The THREAD-STATUS write is sender-gated too, not just routing. Scheduling
  // this route with write=1 every ten minutes turns Phase 1's sole-thread
  // fallback into a standing hazard: an unknown sender would overwrite lender
  // A's status and cursor, and the autoroute switch does not gate that write.
  assert.equal(
    (route.match(/c\.thread\.lender_id === c\.lenderId/g) || []).length,
    2,
    "the thread-status write must be sender-gated as well as the routing decision",
  );
  assert.ok(
    !/\.from\("tenant_records"\)[\s\S]{0,200}\.update\(\{ updated_at/.test(route),
    "a separate claim-then-write does not close the race and must not come back",
  );
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
  // AN OUTAGE IS NOT AN ANSWER. classify-reply returns a real object with
  // category "unknown" and unavailable:true when inference is down — the shape
  // of a verdict without being one. Routing on it would flag the deal and
  // advance the cursor, permanently consuming a reply nothing ever read, and
  // the outage would present as a pile of "needs review" rather than as an
  // outage.
  assert.ok(
    /if \(write && cls && !cls\.unavailable && !c\.already\)/.test(route),
    "the routing block must skip replies the classifier never actually saw",
  );
  // `unknown` must advance the thread cursor, or the same reply is re-fetched
  // and re-classified every ten minutes forever.
  assert.ok(
    /cls\.category === "unknown" && c\.thread/.test(route),
    "an unknown reply must advance the cursor so it is not reclassified forever",
  );
  // `unknown` is the category most in need of a human, so it must reach the
  // flag path rather than being excluded with the write block.
  assert.ok(
    !/if \(write && cls && !c\.already && cls\.category !== "unknown"\) \{[\s\S]{0,4000}planApplicationRoute\(/.test(route),
    "the routing block must NOT sit inside the write block that excludes unknown",
  );
  // A flag that fails to stamp is a review request nobody ever sees, because
  // the IMAP cursor has already moved past the message.
  assert.ok(/flag_failed:/.test(route), "a failed review flag must be reported, not swallowed");
  // ...and must stay RETRYABLE. Step 1 already advanced the cursor, so a
  // failed flag with no rewind is a reply needing a human that is invisible
  // forever.
  // BOTH write paths rewind — the flag path and the routing path. Step 1 has
  // already advanced the cursor by the time either runs, so a transient error
  // in either one permanently consumes the reply while the tick reports it as
  // merely "deferred".
  // THREE paths can fail after step 1 has already advanced the cursor: the
  // pre-decision reads, the flag write, and the routing write. Every one must
  // rewind, or that reply is consumed while the tick reports it as deferred.
  assert.equal(
    (route.match(/last_response_at: c\.thread\.last_response_at/g) || []).length,
    3,
    "the read, flag and routing paths must each rewind the cursor on failure",
  );
  // ...but a LOST RACE must not rewind. An operator moved the deal on purpose;
  // retrying would lose the same race every tick, forever.
  assert.ok(
    /if \(!lostRace && c\.thread\)/.test(route),
    "a lost compare-and-set must NOT be retried — that reply is genuinely done",
  );
  assert.ok(
    /&& flagStamped\)/.test(route),
    "and the unknown-cursor advance must be gated on the flag actually landing",
  );
  // An explicitly stored "" is a real value; `is null` does not match it, so
  // collapsing it would report contention forever and never route the deal.
  assert.ok(
    /statusAtDecision === undefined \|\| statusAtDecision === null\n?\s*\? null/.test(route),
    'only undefined/null may map to a null precondition — "" must be preserved',
  );
  assert.ok(
    !/if \(req\.headers\.get\("x-vercel-cron"\)\)/.test(route),
    "and must NOT be gated behind the x-vercel-cron header — the driver never sends it",
  );
}

// The staged go-live must be OFF in the shipped config. Arming it is a
// deliberate act after a day of `would_route` output has been read, not
// something that rides along with the deploy.
{
  const route = readFileSync("app/api/cron/scan-lender-replies/route.ts", "utf8");
  assert.ok(route.includes("autoRouteLive()"), "the route must consult the master switch");
  assert.ok(route.includes("would_route"), "and report what it WOULD have done while disarmed");
  assert.ok(route.includes("routing:"), "the response must carry the routing counters for health checks");
}

console.log("lender-auto-route.test.ts — one lender is not the deal ✓");
