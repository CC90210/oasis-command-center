/**
 * tests/drip-deal-state.test.ts — the drip audience must be the deals that are
 * still open, and the mailbox must be the desk that is speaking.
 *
 * Both rules exist because of one report (Adon, 2026-08-11): "a lot of the email
 * drips that are live right now aren't actually associated with the CRM stages
 * ... I don't know who it's sending it to right now, sending it to funded deals.
 * We fund them in the past."
 *
 * He was right. Production, same day: of the 311 leads sitting in
 * `signed_application` — the entire audience of the bank-statement nag — 177 had
 * a DECLINED application, 49 a dead file, 41 in follow-ups, 12 approved, 10
 * FUNDED and 2 docs-out. 291 of 311 were deals that had already left the funnel,
 * and the drip had reached them: 148 emails to 117 declined merchants, 18 to 16
 * dead files, and 4 emails to 3 funded merchants.
 *
 * These are pure unit tests over the two rules that decide what a real person
 * receives, which is why they are worth having as tests rather than as comments.
 */

import assert from "node:assert/strict";
import { dealGateFor, openDealStatuses, type DealRow } from "../lib/drips/deal-state";
import { brandForStage } from "../lib/drips/brand-routing";

function app(status: string | null, created_at: string, stage?: string): DealRow {
  return { lead_id: "lead-1", status, stage, created_at };
}

// ---------------------------------------------------------------------------
// The gate. Every closed status below was measured on a real lead that was
// still receiving the bank-statement nag on 2026-08-11.
// ---------------------------------------------------------------------------

// No application at all — the entire top of the funnel. Must never be gated.
assert.deepEqual(dealGateFor([]), { open: true, reason: "no_application" });

// The one status that keeps a stage drip alive: the deal landed, nobody has
// worked it yet, and chasing the merchant is exactly right.
assert.equal(dealGateFor([app("application_in", "2026-08-01T00:00:00Z")]).open, true);

// A lead parked in the FUNNEL whose deal has left it. This is the reported bug.
for (const closed of ["funded", "declined", "dead_file", "approved", "docs_out", "follow_ups", "default"]) {
  const gate = dealGateFor([app(closed, "2026-08-01T00:00:00Z")], "signed_application");
  assert.equal(gate.open, false, `${closed} deals must not receive the bank-statement nag`);
  assert.equal(gate.open === false && gate.status, closed, "the reason is recorded for the cancel row");
}

// ---------------------------------------------------------------------------
// THE RE-ENGAGEMENT DRIPS MUST SURVIVE. "Declined — 1-month check-back" exists
// precisely to talk to declined deals and had 61 runs pending on 2026-08-11. A
// naive "closed status => never send" gate would have cancelled every one of
// them — deleting a whole programme while claiming to fix over-sending.
//
// The gate asks whether the deal CONTRADICTS the lead's stage, not whether the
// deal is closed.
// ---------------------------------------------------------------------------
assert.deepEqual(
  dealGateFor([app("declined", "2026-08-01T00:00:00Z")], "declined"),
  { open: true, reason: "stage_agrees" },
  "the declined check-back must keep reaching declined deals",
);
assert.equal(dealGateFor([app("dead_file", "2026-08-01T00:00:00Z")], "dead_file").open, true);
assert.equal(dealGateFor([app("default", "2026-08-01T00:00:00Z")], "default").open, true);

// THE BOARDS SPELL SHARED STATES DIFFERENTLY. Applications says `follow_ups`,
// Leads says `follow_up`. Missing that letter would have had the gate call
// every follow-up lead a closed deal — silencing the exact programme this
// change routes to Bluerise (Codex review 2026-08-11, P1). No lead sat in that
// intersection the day it was found, so only a test can hold it.
assert.equal(
  dealGateFor([app("follow_ups", "2026-08-01T00:00:00Z")], "follow_up").open,
  true,
  "follow_ups (application) and follow_up (lead) are the same state",
);
// Same name on both boards, and a live sequence aimed at it.
assert.equal(dealGateFor([app("missing_info", "2026-08-01T00:00:00Z")], "missing_info").open, true);
// The bridge must not leak: a follow-ups deal on a FUNNEL stage is still stale.
assert.equal(dealGateFor([app("follow_ups", "2026-08-01T00:00:00Z")], "signed_application").open, false);

// ...but agreement is the ONLY thing that reopens it. A funded deal has no
// Leads-board equivalent, so no stage can agree with it.
assert.equal(
  dealGateFor([app("funded", "2026-08-01T00:00:00Z")], "declined").open,
  false,
  "funded is never a drip audience, whatever the lead's stage says",
);
assert.equal(dealGateFor([app("declined", "2026-08-01T00:00:00Z")], "dead_file").open, false);
// The lead is still in the funnel; the deal is not. The reported bug, again,
// stated against the stage that actually carried it.
assert.equal(dealGateFor([app("declined", "2026-08-01T00:00:00Z")], "signed_application").open, false);
assert.equal(dealGateFor([app("declined", "2026-08-01T00:00:00Z")], undefined).open, false);

// THE HEADLINE CASE, stated on its own so a future edit that reopens it fails
// here by name rather than as one entry in a loop.
assert.equal(
  dealGateFor([app("funded", "2026-06-28T02:08:08Z")]).open,
  false,
  "a funded merchant must never be asked for bank statements again",
);

// Case and whitespace are hand-entered on this board.
assert.equal(dealGateFor([app("  FUNDED  ", "2026-08-01T00:00:00Z")]).open, false);

// An UNRECOGNISED status closes the gate rather than opening it. The two error
// directions are not symmetric: a drip wrongly silenced leaves a lead an
// operator still sees on the board; a drip wrongly sent emails a funded
// merchant.
assert.equal(dealGateFor([app("some_new_column", "2026-08-01T00:00:00Z")]).open, false);

// A blank status is NOT evidence of closure — every application this app creates
// leaves `status` unset until a human moves it, so reading blank as closed would
// mute the whole funnel. Measured 2026-08-11: 590 applications carried no stage.
assert.deepEqual(dealGateFor([app(null, "2026-08-01T00:00:00Z")]), {
  open: true,
  reason: "no_application",
});

// The 2026-05 Monday.com import carried its state in `stage`, not `status`.
assert.equal(dealGateFor([app(null, "2026-08-01T00:00:00Z", "funded")]).open, false);

// ---------------------------------------------------------------------------
// Re-applications. THE MOST RECENT application decides, not "any closed
// application anywhere" — a merchant declined in March and re-applying in August
// is ordinary, and letting the March decline mute the August deal would silence
// exactly the leads worth chasing.
// ---------------------------------------------------------------------------
assert.equal(
  dealGateFor([app("declined", "2026-03-01T00:00:00Z"), app("application_in", "2026-08-01T00:00:00Z")]).open,
  true,
  "an old decline must not mute a live re-application",
);
// Order in the array must not change the answer — the caller's query order is
// not guaranteed.
assert.equal(
  dealGateFor([app("application_in", "2026-08-01T00:00:00Z"), app("declined", "2026-03-01T00:00:00Z")]).open,
  true,
);
// ...and the reverse: a live deal that has since funded is closed, however many
// open rows preceded it.
assert.equal(
  dealGateFor([app("application_in", "2026-03-01T00:00:00Z"), app("funded", "2026-08-01T00:00:00Z")]).open,
  false,
);

// ---------------------------------------------------------------------------
// Operator override, so a newly added "still open" column on the Applications
// board does not need a deploy to stop muting the funnel.
// ---------------------------------------------------------------------------
{
  const prev = process.env.DRIP_OPEN_DEAL_STATUSES;
  process.env.DRIP_OPEN_DEAL_STATUSES = "missing_info, requested_docs";
  assert.ok(openDealStatuses().has("missing_info"));
  assert.equal(dealGateFor([app("requested_docs", "2026-08-01T00:00:00Z")]).open, true);
  // The override ADDS; it must not drop the built-in.
  assert.equal(dealGateFor([app("application_in", "2026-08-01T00:00:00Z")]).open, true);
  // And it must not reopen a funded deal.
  assert.equal(dealGateFor([app("funded", "2026-08-01T00:00:00Z")]).open, false);
  if (prev === undefined) delete process.env.DRIP_OPEN_DEAL_STATUSES;
  else process.env.DRIP_OPEN_DEAL_STATUSES = prev;
}

// ---------------------------------------------------------------------------
// Stage -> mailbox (Adon, 2026-08-11): "For the submissions email you will be
// sending out the viewed AND signed. The Bluerise email will be used for the
// follow-ups tab."
// ---------------------------------------------------------------------------
assert.equal(brandForStage("viewed_application"), "sunbiz");
assert.equal(brandForStage("signed_application"), "sunbiz");
assert.equal(brandForStage("sent_application"), "sunbiz", "the application funnel is one continuous transaction");
assert.equal(brandForStage("follow_up"), "bluerise");

// A stage with no rule returns null, NOT a default: "no opinion" and "SunBiz"
// are different answers, and collapsing them would silently override the brand
// stamped on the lead for every unlisted stage.
assert.equal(brandForStage("uw_sheet"), null);
assert.equal(brandForStage("missing_info"), null);
assert.equal(brandForStage(""), null);
assert.equal(brandForStage(undefined), null);
assert.equal(brandForStage(null), null);

// Hand-entered casing must not silently drop a lead back to the fallback brand.
assert.equal(brandForStage("  Follow_Up "), "bluerise");

// Operator override MOVES a stage between mailboxes, not just adds one.
{
  const prev = process.env.DRIP_SUNBIZ_STAGES;
  process.env.DRIP_SUNBIZ_STAGES = "follow_up";
  assert.equal(brandForStage("follow_up"), "sunbiz", "an override must be able to pull a stage back");
  if (prev === undefined) delete process.env.DRIP_SUNBIZ_STAGES;
  else process.env.DRIP_SUNBIZ_STAGES = prev;
}
{
  const prev = process.env.DRIP_BLUERISE_STAGES;
  process.env.DRIP_BLUERISE_STAGES = "viewed_application";
  assert.equal(brandForStage("viewed_application"), "bluerise");
  if (prev === undefined) delete process.env.DRIP_BLUERISE_STAGES;
  else process.env.DRIP_BLUERISE_STAGES = prev;
}

console.log("drip-deal-state.test.ts OK");
