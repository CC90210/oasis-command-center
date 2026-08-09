/**
 * tests/outbound-routing.test.ts — the allocation of outbound work to mailboxes
 * and carriers.
 *
 * The rules pinned here are business decisions, not implementation details, so
 * a future refactor that "simplifies" one of them is a regression against
 * something Adon decided, not a code-style choice:
 *
 *   - lender shop-out is ALWAYS SunBiz, whatever brand owns the merchant
 *   - a Bluerise merchant is never texted from a SunBiz number
 *   - an unavailable provider HOLDS, it does not fail and does not fall back
 */

import assert from "node:assert/strict";
import {
  routeOutbound,
  reachableChannels,
  describeAllocation,
  type ProviderAvailability,
} from "../lib/routing/outbound-routing";

const live = { configured: true, enabled: true };
const off = { configured: true, enabled: false };
const missing = { configured: false, enabled: false };

/** Production as of 2026-08-09: both mailboxes present, TT live, Twilio absent. */
const TODAY: ProviderAvailability = {
  gws: live,
  gws_bluerise: live,
  texttorrent: live,
  twilio: missing,
};

// ── Email follows the brand ───────────────────────────────────────────────
{
  const d = routeOutbound({ channel: "email", purpose: "drip", brand: "sunbiz", available: TODAY });
  assert.equal(d.send && d.provider, "gws");
  const b = routeOutbound({ channel: "email", purpose: "drip", brand: "bluerise", available: TODAY });
  assert.equal(b.send && b.provider, "gws_bluerise");
}

// ── Lender shop-out is ALWAYS SunBiz ──────────────────────────────────────
// Funders only ever see SunBiz paper. A Bluerise-owned merchant's submission
// still goes out as SunBiz, so brand must NOT win here.
for (const brand of ["sunbiz", "bluerise"] as const) {
  const d = routeOutbound({ channel: "email", purpose: "lender_shopout", brand, available: TODAY });
  assert.ok(d.send, `shop-out must send for a ${brand} lead`);
  assert.equal(d.send && d.provider, "gws", `shop-out from a ${brand} lead must still use SunBiz`);
  assert.equal(d.send && d.brand, "sunbiz");
}
// And it must never silently become a text.
{
  const d = routeOutbound({ channel: "sms", purpose: "lender_shopout", brand: "sunbiz", available: TODAY });
  assert.equal(d.send, false);
}
// If the SunBiz mailbox is down, shop-out HOLDS. It must never fail over to
// Bluerise: that would put a second company's name on funder-facing paperwork.
{
  const d = routeOutbound({
    channel: "email", purpose: "lender_shopout", brand: "bluerise",
    available: { ...TODAY, gws: missing },
  });
  assert.equal(d.send, false);
  assert.equal(d.send === false && d.blockedBy, "gws");
}

// ── SunBiz SMS goes to TextTorrent ────────────────────────────────────────
{
  const d = routeOutbound({ channel: "sms", purpose: "drip", brand: "sunbiz", available: TODAY });
  assert.equal(d.send && d.provider, "texttorrent");
}

// ── A Bluerise merchant is NEVER texted from a SunBiz number ──────────────
// The whole point of the split: one company name per conversation. Falling back
// to TextTorrent here would also push Bluerise copy through a carrier campaign
// registered to SunBiz, which is how a brand gets filtered.
for (const purpose of ["drip", "transactional", "rep_manual"] as const) {
  const d = routeOutbound({ channel: "sms", purpose, brand: "bluerise", available: TODAY });
  assert.equal(d.send, false, `bluerise ${purpose} SMS must not send today`);
  assert.equal(d.send === false && d.blockedBy, "twilio");
  assert.match(d.send === false ? d.reason : "", /no SMS numbers yet/);
}

// A HOLD is not a failure. The shape must carry hold:true so callers reschedule
// instead of marking the merchant undeliverable or dropping the sequence step.
{
  const d = routeOutbound({ channel: "sms", purpose: "drip", brand: "bluerise", available: TODAY });
  assert.equal(d.send === false && d.hold, true);
}

// ── Turning Bluerise SMS on is provisioning, not a code change ────────────
{
  const withTwilio: ProviderAvailability = { ...TODAY, twilio: live };
  const d = routeOutbound({ channel: "sms", purpose: "drip", brand: "bluerise", available: withTwilio });
  assert.equal(d.send && d.provider, "twilio");
  assert.equal(d.send && d.brand, "bluerise");
}

// Configured-but-switched-off must behave exactly like absent. A half-enabled
// provider that sends anyway is how an unregistered number starts burning money
// on carrier-blocked traffic.
{
  const d = routeOutbound({ channel: "sms", purpose: "drip", brand: "bluerise", available: { ...TODAY, twilio: off } });
  assert.equal(d.send, false);
}

// ── What can each brand actually reach today ──────────────────────────────
assert.deepEqual(reachableChannels("sunbiz", TODAY), ["email", "sms"]);
assert.deepEqual(reachableChannels("bluerise", TODAY), ["email"], "bluerise is email-only until it has numbers");

// The real-world case we are living in right now: SunBiz's mailbox password is
// dead, so SunBiz is SMS-only while Bluerise is email-only. The two brands have
// disjoint reachable channels, and the planner has to be able to see that.
{
  const passwordDead: ProviderAvailability = { ...TODAY, gws: missing };
  assert.deepEqual(reachableChannels("sunbiz", passwordDead), ["sms"]);
  assert.deepEqual(reachableChannels("bluerise", passwordDead), ["email"]);
}

// Nothing reachable at all must be an empty list, never a crash or a default.
assert.deepEqual(
  reachableChannels("bluerise", { gws: missing, gws_bluerise: missing, texttorrent: missing, twilio: missing }),
  [],
);

// ── The description is operator-facing, so it must reflect real status ────
{
  const lines = describeAllocation(TODAY);
  assert.equal(lines.length, 4);
  assert.match(lines.join("\n"), /Twilio.*not provisioned/s);
  assert.match(lines.join("\n"), /lender shop-out/i);
}

console.log("outbound-routing.test.ts — all assertions passed");
