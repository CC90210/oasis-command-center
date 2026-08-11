/**
 * tests/sms-sender-sync.test.ts — the rep-key mapping that decides which number
 * a text goes out from.
 *
 * THE FAILURE. lib/drips/rep-sms-identity.ts carried a hardcoded number list,
 * "VERIFIED live 2026-07-09". TextTorrent rotates numbers. By 2026-07-13 the
 * list had rotted: jordan's only configured number was gone, joe's sub-account
 * had vanished, 3 of admin's 5 were dead. Every send from a dead number returned
 * 422 — 1,070 of them over three weeks, every one recorded as 'sent'.
 *
 * The fix syncs numbers from the live API. This file pins the one thing that
 * silently breaks the sync: the rep keys on both sides must agree.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repKeyForOwner, classifyRep } from "../lib/drips/rep-keys";

// ── The two sides MUST agree ───────────────────────────────────────────────
// The sync stores numbers under repKeyForOwner(ownerName).
// The send path looks them up under classifyRep(lead).
// A mismatch leaves a pool empty and every send for that rep fails.
const cases: Array<{ ttOwner: string; leadRepName: string }> = [
  { ttOwner: "Alex Johnson", leadRepName: "Alex" },
  { ttOwner: "Jordan Colleson", leadRepName: "Jordan" },
  { ttOwner: "Matt Bernard", leadRepName: "Matt" },
];
for (const c of cases) {
  assert.equal(
    repKeyForOwner(c.ttOwner),
    classifyRep({ rep_name: c.leadRepName }),
    `sync stores "${c.ttOwner}" under a different key than the send path looks up for "${c.leadRepName}"`,
  );
}

// Matt is the owner/parent account and routes to admin on BOTH sides. This is
// the widest possible gap if it ever drifts: admin is the fallback for every
// lead we cannot confidently attribute.
assert.equal(repKeyForOwner("Matt Bernard"), "admin");
assert.equal(classifyRep({ rep_name: "Matt" }), "admin");

// Unknown owners land on admin rather than creating an orphan pool.
assert.equal(repKeyForOwner("Someone New"), "admin");
assert.equal(repKeyForOwner(null), "admin");
assert.equal(repKeyForOwner(""), "admin");

// Case and surrounding text must not change the answer — these strings come
// from TextTorrent's UI and are typed by humans.
assert.equal(repKeyForOwner("ALEX JOHNSON"), "alex");
assert.equal(repKeyForOwner("  jordan colleson  "), "jordan");

// ── The send path must prefer LIVE numbers over the static snapshot ────────
{
  const src = readFileSync("lib/drips/rep-sms-identity.ts", "utf8");
  const liveAt = src.indexOf("liveNumbersFor");
  const staticAt = src.indexOf("entry.numbers.length > 0");
  assert.ok(liveAt > 0, "the resolver must consult the synced live numbers");
  assert.ok(
    liveAt < staticAt,
    "live numbers must be checked BEFORE the static registry — the static list is a snapshot of a moving target",
  );
}

// ── The sync must fail CLOSED on an unreadable API ─────────────────────────
// Marking every number dead because TextTorrent had a bad minute would take the
// whole SMS channel down, which is worse than one stale row.
{
  const src = readFileSync("lib/drips/sender-sync.ts", "utf8");
  assert.ok(
    /fail closed — deactivate nothing/.test(src),
    "an enumeration failure must not deactivate numbers",
  );
  assert.ok(
    /refusing to deactivate anything/.test(src),
    "an empty active list must be treated as suspicious, not as proof there are no numbers",
  );
  assert.ok(
    /String\(rows\[i\]\.status\) === "1"/.test(src),
    "only status-1 numbers are sendable; anything else must be excluded",
  );
}

console.log("sms-sender-sync.test.ts — all assertions passed ✓");
