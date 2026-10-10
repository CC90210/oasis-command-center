/**
 * tests/bridge-online-copy.test.ts
 *
 * Unit tests for lib/bridge-online-copy.ts:bridgeConnectionHeadline — the
 * wording fix for BUG 2 (2026-10-10): the Automations and /sequences
 * banners said "Your computer is connected" whenever ANY non-revoked
 * bridge_pairings row for the tenant pinged within the freshness window.
 * In the shared OASIS workspace that pairing is always CC's PC, so Adon
 * was told HIS computer was connected when it was not.
 *
 * Matrix: 0 online, 1 online (named + unnamed), 2+ online (named + mixed),
 * and unknown (the heartbeat read itself failed). The null and zero cases
 * keep their existing, separately-pinned wording on purpose — see
 * tests/queries-fail-loud-callers.test.ts ("Couldn't check your computer" /
 * "Computer not connected yet"); only the ONLINE sentence was the lie.
 *
 * Run: node --conditions=react-server --import tsx tests/bridge-online-copy.test.ts
 */
import assert from "node:assert/strict";
import { bridgeConnectionHeadline } from "../lib/bridge-online-copy";

// Unknown — the heartbeat read itself failed. Never claims online or offline.
assert.equal(bridgeConnectionHeadline(null), "Couldn't check your computer.");

// 0 online.
assert.equal(bridgeConnectionHeadline([]), "Computer not connected yet.");

// 1 online, named.
assert.equal(bridgeConnectionHeadline(["CCPC"]), "CCPC is connected.");
assert.equal(bridgeConnectionHeadline(["  CCPC  "]), "CCPC is connected.", "a label is trimmed");

// 1 online, empty/blank label — neutral fallback, never an invented name.
assert.equal(bridgeConnectionHeadline([""]), "A paired computer is connected.");
assert.equal(bridgeConnectionHeadline(["   "]), "A paired computer is connected.");
assert.equal(bridgeConnectionHeadline([null as unknown as string]), "A paired computer is connected.");

// 2+ online, named.
assert.equal(bridgeConnectionHeadline(["CCPC", "Mac"]), "2 computers are connected: CCPC, Mac.");
assert.equal(
  bridgeConnectionHeadline(["CCPC", "Mac", "Linux box"]),
  "3 computers are connected: CCPC, Mac, Linux box.",
);

// 2+ online, one label empty — the fallback is inline and lowercase mid-sentence.
assert.equal(
  bridgeConnectionHeadline(["CCPC", ""]),
  "2 computers are connected: CCPC, a paired computer.",
);
assert.equal(
  bridgeConnectionHeadline(["", ""]),
  "2 computers are connected: a paired computer, a paired computer.",
);

// The lie this fixes: an online claim must never be phrased as ownership of
// "your" computer, in any of the online shapes.
for (const labels of [["CCPC"], ["CCPC", "Mac"], [""], ["", ""]]) {
  assert.ok(
    !/your computer/i.test(bridgeConnectionHeadline(labels)),
    `online headline must not say "your computer" for ${JSON.stringify(labels)}`,
  );
}

console.log("bridge-online-copy.test.ts: OK");
