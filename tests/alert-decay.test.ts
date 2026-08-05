import assert from "node:assert/strict";
import { shouldAlert, DECAY_LADDER_H, FORGET_H } from "../lib/notify/alert-decay";

// The incident: the OASIS group got the TPS backlog alert every 6h for ten days.
// True every time, read by nobody after day three.

const T0 = new Date("2026-08-03T00:00:00Z");
const hoursAfter = (h: number) => new Date(T0.getTime() + h * 3_600_000);

// ── first observation always sends ───────────────────────────────────────────
// This is the property the 2026-07-24 Codex decision protects: NO edge detection.
// A backlog already stale when the watchdog deploys, or on the run after a skip,
// must still alert. shouldAlert is asked about the condition, never a transition.

assert.equal(
  shouldAlert("tps_backlog", null, T0).send,
  true,
  "a standing condition with no history must alert immediately",
);
assert.equal(
  shouldAlert("tps_backlog", { lastAlertedAt: null, repeatN: 0 }, T0).reason,
  "first",
  "an empty state row is still a first observation, not a suppression",
);

// ── the ladder ───────────────────────────────────────────────────────────────

assert.equal(
  shouldAlert("tps_backlog", { lastSignature: "tps_backlog", lastAlertedAt: T0.toISOString(), repeatN: 1 }, hoursAfter(5)).send,
  false,
  "5h after the first alert is inside the 6h window",
);
assert.equal(
  shouldAlert("tps_backlog", { lastSignature: "tps_backlog", lastAlertedAt: T0.toISOString(), repeatN: 1 }, hoursAfter(6)).send,
  true,
  "6h opens the first repeat",
);
assert.equal(
  shouldAlert("tps_backlog", { lastSignature: "tps_backlog", lastAlertedAt: T0.toISOString(), repeatN: 1 }, hoursAfter(6)).nextRepeatN,
  2,
  "sending advances the ladder",
);
assert.equal(
  shouldAlert("tps_backlog", { lastSignature: "tps_backlog", lastAlertedAt: T0.toISOString(), repeatN: 2 }, hoursAfter(11)).send,
  false,
  "second repeat waits 12h, not 6h",
);
assert.equal(
  shouldAlert("tps_backlog", { lastSignature: "tps_backlog", lastAlertedAt: T0.toISOString(), repeatN: 2 }, hoursAfter(12)).send,
  true,
  "12h opens the second repeat",
);
assert.equal(
  shouldAlert("tps_backlog", { lastSignature: "tps_backlog", lastAlertedAt: T0.toISOString(), repeatN: 3 }, hoursAfter(23)).send,
  false,
  "third repeat waits 24h",
);
assert.equal(
  shouldAlert("tps_backlog", { lastSignature: "tps_backlog", lastAlertedAt: T0.toISOString(), repeatN: 9 }, hoursAfter(25)).windowH,
  DECAY_LADDER_H[DECAY_LADDER_H.length - 1],
  "the ladder caps — escalation must not run away to weeks",
);

// The whole point, stated as a count: ten days of outage under the old fixed
// 6-hourly cadence = 40 messages. Under the ladder it is far fewer, and the
// gaps grow.
{
  let state = { lastSignature: "tps_backlog", lastAlertedAt: null as string | null, repeatN: 0 };
  let sends = 0;
  for (let h = 0; h <= 240; h += 6) {
    const d = shouldAlert("tps_backlog", state, hoursAfter(h));
    if (d.send) {
      sends += 1;
      state = { lastSignature: "tps_backlog", lastAlertedAt: hoursAfter(h).toISOString(), repeatN: d.nextRepeatN };
    }
  }
  assert.ok(sends <= 12, `ten days of outage should not be 40 pages, got ${sends}`);
  assert.ok(sends >= 8, `must still re-remind during a sustained outage, got ${sends}`);
}

// ── decay must never swallow news ────────────────────────────────────────────

assert.equal(
  shouldAlert("tps_backlog:critical", { lastSignature: "tps_backlog", lastAlertedAt: T0.toISOString(), repeatN: 3 }, hoursAfter(1)).send,
  true,
  "a changed signature is a different problem and alerts immediately",
);
assert.equal(
  shouldAlert("tps_backlog", { lastSignature: "tps_backlog", lastAlertedAt: T0.toISOString(), repeatN: 3 }, hoursAfter(FORGET_H)).reason,
  "forgotten",
  "a long quiet period starts a NEW episode rather than inheriting a 24h window",
);
assert.equal(
  shouldAlert("tps_backlog", { lastSignature: "tps_backlog", lastAlertedAt: T0.toISOString(), repeatN: 3 }, hoursAfter(FORGET_H)).nextRepeatN,
  1,
  "the forgotten episode restarts the ladder at 6h",
);

// ── junk state must fail OPEN ────────────────────────────────────────────────
// Suppression is never worth swallowing a real alert.

assert.equal(
  shouldAlert("tps_backlog", { lastSignature: "tps_backlog", lastAlertedAt: "not-a-date", repeatN: 2 }, T0).send,
  true,
  "an unparseable timestamp must send, not silence",
);

console.log("alert-decay: all assertions passed");
