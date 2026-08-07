/**
 * tests/sms-carrier-status.test.ts — the rules that decide whether we believe
 * an SMS actually arrived.
 *
 * THE FAILURE. From 2026-07-27 to 2026-08-07 every API-sent SMS was rejected by
 * the carrier. 51 consecutive sends, zero delivered, and not one alert. The
 * send returned HTTP 201, the row was written 'sent', the merchant got nothing.
 * The verdict was available the whole time on the message's `api_send_status`,
 * a field nothing in the codebase read.
 *
 * These assertions pin the three ways that failure could return: reading the
 * status too literally, matching the wrong message, and a breaker that trusts
 * silence.
 */

import assert from "node:assert/strict";
import {
  normalizeCarrierStatus,
  isTerminal,
  parseTtTimestamp,
  matchThreadMessage,
  hashBody,
  readReceiptFacts,
  breakerVerdict,
  deliveryRate,
  type ReceiptSample,
} from "../lib/sms/carrier-status";

// ── Casing is not cosmetic ────────────────────────────────────────────────
// TextTorrent returns BOTH casings for the same outcome, in the same account on
// the same day: we observed {"delivered":420,"DELIVERED":9,"failed":3,"Failed":95}.
// A `=== "failed"` comparison would have scored 95 real failures as healthy.
for (const raw of ["failed", "Failed", "FAILED", " failed "]) {
  assert.equal(normalizeCarrierStatus(raw), "failed", `"${raw}" must read as failed`);
}
for (const raw of ["delivered", "DELIVERED", "Delivered"]) {
  assert.equal(normalizeCarrierStatus(raw), "delivered", `"${raw}" must read as delivered`);
}
for (const raw of ["pending", "Pending", "queued"]) {
  assert.equal(normalizeCarrierStatus(raw), "pending");
}

// "success" appears on INBOUND rows and describes receipt, not delivery. Reading
// it as a delivery confirmation would mark every inbound-bearing thread healthy.
assert.equal(normalizeCarrierStatus("success"), "unknown");
assert.equal(normalizeCarrierStatus(null), "unknown");
assert.equal(normalizeCarrierStatus(undefined), "unknown");
assert.equal(normalizeCarrierStatus(""), "unknown");

// Only a real verdict closes a receipt. Leaving pending/unknown open is what
// makes the reconciler come back for them.
assert.equal(isTerminal("delivered"), true);
assert.equal(isTerminal("failed"), true);
assert.equal(isTerminal("pending"), false);
assert.equal(isTerminal("unknown"), false);

// ── Timestamps are UTC, and JS will not assume that ───────────────────────
// "2026-08-07 13:04:12" through `new Date(...)` parses as LOCAL time. On any
// machine west of UTC that shifts every message hours into the future and the
// send/receipt match silently finds nothing.
assert.equal(parseTtTimestamp("2026-08-07 13:04:12"), Date.parse("2026-08-07T13:04:12Z"));
assert.equal(parseTtTimestamp("2026-08-07T13:04:12Z"), Date.parse("2026-08-07T13:04:12Z"));
assert.equal(parseTtTimestamp(""), null);
assert.equal(parseTtTimestamp("not a date"), null);

// ── Matching our message, not the rep's ───────────────────────────────────
const sentAt = Date.parse("2026-08-07T13:04:12Z");
const thread = [
  // A rep typing in the TT web UI at the same moment. Must never be matched:
  // it delivers fine, and crediting it to the drip would report a dead channel
  // as healthy.
  { direction: "outbound", platform: "web", message: "Quick question for you", api_send_status: "delivered", msg_sid: "sid-web", created_at: "2026-08-07 13:04:20" },
  { direction: "inbound", platform: "api", message: "Our drip copy", api_send_status: "success", msg_sid: "sid-in", created_at: "2026-08-07 13:04:15" },
  { direction: "outbound", platform: "api", message: "Our drip copy", api_send_status: "Failed", msg_sid: null, segment: 2, credit: 6, id: 42, created_at: "2026-08-07 13:04:12" },
];
const ourCopy = hashBody("Our drip copy");
const hit = matchThreadMessage(thread, { bodyHash: ourCopy, sentAtMs: sentAt });
assert.ok(hit, "must find our outbound message");
assert.equal(hit?.id, 42);

// The fingerprint is whitespace-insensitive at the edges but nothing else, so
// two different renderings of a template can never collide.
assert.equal(hashBody("  Our drip copy  "), ourCopy);
assert.notEqual(hashBody("Our drip copy."), ourCopy);
const facts = readReceiptFacts(hit!);
assert.equal(facts.status, "failed");
// Recorded, but NOT a delivery signal. Refused messages were observed both with
// and without a sid on 2026-08-07, so only api_send_status may decide.
assert.equal(facts.msgSid, null);
assert.equal(
  readReceiptFacts({ api_send_status: "failed", msg_sid: "6a76100c8479f998d605d3ab" }).status,
  "failed",
  "a present sid must never override a failed status",
);
assert.equal(facts.segments, 2);
assert.equal(facts.credits, 6, "we are billed for failures, so credits must be recorded");
assert.equal(facts.messageId, "42");

// Body match wins over proximity: an identical-copy retry an hour later must not
// steal the older send's receipt.
assert.equal(matchThreadMessage(thread, { bodyHash: hashBody("Different copy"), sentAtMs: sentAt }), null);
assert.equal(
  matchThreadMessage(thread, { bodyHash: ourCopy, sentAtMs: sentAt + 4 * 3_600_000 }),
  null,
  "outside the window there is no match",
);
// ── A rep pasting our template must never close our receipt ───────────────
// This is the subtlest way the whole subsystem could fail. Reps work the same
// threads and sometimes paste the same copy. Their sends go out on platform
// "web" and DELIVER (0 failures in 530); ours go on "api" and do not (98 in
// 113). Matching theirs would close our receipt as delivered and report a dead
// route as healthy — the exact false green this exists to prevent.
const sameCopyBothPlatforms = [
  { direction: "outbound", platform: "web", message: "Our drip copy", api_send_status: "delivered", msg_sid: "sid-rep", id: 99, created_at: "2026-08-07 13:04:13" },
  { direction: "outbound", platform: "api", message: "Our drip copy", api_send_status: "Failed", msg_sid: null, id: 42, created_at: "2026-08-07 13:04:12" },
];
const picked = matchThreadMessage(sameCopyBothPlatforms, { bodyHash: ourCopy, sentAtMs: sentAt });
assert.equal(picked?.id, 42, "must pick the api send, not the rep's web send");
assert.equal(readReceiptFacts(picked!).status, "failed");

// And with ONLY the rep's message present, there is no match at all — better to
// leave the receipt open than to close it on someone else's delivery.
assert.equal(
  matchThreadMessage([sameCopyBothPlatforms[0]], { bodyHash: ourCopy, sentAtMs: sentAt }),
  null,
  "a web-only thread yields no match, never a false delivered",
);

// ── The breaker ───────────────────────────────────────────────────────────
const at = (n: number) => sentAt - n * 60_000;
const fails = (n: number): ReceiptSample[] =>
  Array.from({ length: n }, (_, i) => ({ status: "failed" as const, at: at(i) }));

// Unreadable history fails CLOSED. A breaker that cannot see is not a breaker,
// and a halted step reschedules rather than failing, so the cost is only time.
const blind = breakerVerdict(null);
assert.equal(blind.halt, true);
assert.match(blind.reason, /unreadable/);

// Empty is NOT unreadable. A fresh deploy has no receipts and must still be
// allowed to send, or the channel could never start.
assert.equal(breakerVerdict([]).halt, false, "no history yet must not halt");

// The real outage shape: consecutive failures, nothing else.
assert.equal(breakerVerdict(fails(9)).halt, false, "9 consecutive is under the limit");
const tripped = breakerVerdict(fails(10));
assert.equal(tripped.halt, true);
assert.equal(tripped.consecutiveFailures, 10);
assert.match(tripped.reason, /consecutive/);

// A recent delivery breaks the streak — the route is alive again.
const recovered = breakerVerdict([{ status: "delivered", at: at(0) }, ...fails(30).map((f, i) => ({ ...f, at: at(i + 1) }))]);
assert.equal(recovered.consecutiveFailures, 0, "newest is a delivery, so the streak is zero");
assert.equal(recovered.halt, true, "but a 97% failure ratio still halts");

// Ratio rule needs a sample. A 3-of-3 bad patch is noise, not an outage.
const tiny: ReceiptSample[] = [
  { status: "failed", at: at(1) }, { status: "delivered", at: at(0) }, { status: "failed", at: at(2) },
];
assert.equal(breakerVerdict(tiny).halt, false, "below minSample the ratio is not trusted");

// ── The breaker must be able to discover it was wrong ─────────────────────
// A tripped breaker stops sending, so no new receipts arrive, so the ratio
// cannot fall and the streak cannot break. Without a probe it holds the channel
// down long after the route recovers — the shape that wedged TPS on this repo
// in August 2026. These assertions are the release valve.
const streak = fails(12); // newest at at(0)
const justTripped = breakerVerdict(streak, { nowMs: at(0) + 60_000 });
assert.equal(justTripped.halt, true);
assert.equal(justTripped.halfOpen, false, "no probe one minute after the last verdict");

const stale = breakerVerdict(streak, { nowMs: at(0) + 31 * 60_000 });
assert.equal(stale.halt, true, "still halted - the probe does not clear the verdict");
assert.equal(stale.halfOpen, true, "after 30 quiet minutes, one probe is due");
assert.match(stale.reason, /probe/);

// A probe already in flight means WAIT. Otherwise every row in a dispatch batch
// reads "due for a probe" and the single careful test becomes a full resumption
// of sending into a dead route.
const inFlight = breakerVerdict(streak, { nowMs: at(0) + 31 * 60_000, newestOpenAt: at(0) + 20 * 60_000 });
assert.equal(inFlight.halfOpen, false, "an unresolved send newer than the last verdict is the outstanding probe");

// An OLD unresolved receipt is not an in-flight probe and must not block one.
const staleOpen = breakerVerdict(streak, { nowMs: at(0) + 31 * 60_000, newestOpenAt: at(5) });
assert.equal(staleOpen.halfOpen, true, "an open receipt older than the last verdict is not a probe");

// Recovery: once the probe delivers, the streak breaks and the ratio falls
// below the limit, so the breaker releases on its own.
const afterGoodProbe = breakerVerdict(
  [{ status: "delivered", at: at(0) }, ...Array.from({ length: 5 }, (_, i) => ({ status: "failed" as const, at: at(i + 1) }))],
  { nowMs: at(0) + 60_000 },
);
assert.equal(afterGoodProbe.halt, false, "a delivered probe with a small sample releases the breaker");
assert.equal(afterGoodProbe.consecutiveFailures, 0);

// Healthy traffic passes.
const healthy: ReceiptSample[] = Array.from({ length: 30 }, (_, i) => ({
  status: i % 10 === 0 ? ("failed" as const) : ("delivered" as const),
  at: at(i),
}));
assert.equal(breakerVerdict(healthy).halt, false);
assert.equal(deliveryRate(healthy), 27 / 30);

// Pending receipts are not evidence either way and must not dilute the rate.
assert.equal(deliveryRate([{ status: "pending", at: at(0) }]), null);
assert.equal(
  deliveryRate([{ status: "pending", at: at(0) }, { status: "delivered", at: at(1) }]),
  1,
  "pending is excluded, not counted as a failure",
);

console.log("sms-carrier-status.test.ts: all assertions passed");
