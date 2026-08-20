/**
 * tests/thread-match-platform.test.ts — an absent `platform` must not exclude
 * every candidate message.
 *
 * THE SILENT REGRESSION (measured 2026-08-20). matchThreadMessage required
 * `String(m.platform ?? "") !== "api"` to skip, so a message object WITHOUT the
 * field was rejected. TextTorrent stopped returning `platform` on
 * GET /inbox/{chatId}, and SMS delivery verification stopped dead:
 *
 *   47 receipts reached a real carrier verdict between 2026-08-07 and 08-16.
 *   From 08-16 onward: not one. Every receipt sat at carrier_status 'unknown'
 *   until it exhausted its attempts and was retired.
 *
 * The message had `direction: "outbound"`, an exactly-matching body hash, and
 * `api_send_status: "Failed"` sitting right there. The only thing missing was a
 * field we were using as a gate.
 *
 * This is the same shape as the other two failures found the same day: a filter
 * that excludes 100% of its input does not look like a broken filter, it looks
 * like a quiet provider. Verify CONTRIBUTION, not presence.
 */

import assert from "node:assert/strict";
import { matchThreadMessage, hashBody, readReceiptFacts } from "../lib/sms/carrier-status";

const BODY = "Hi James Alberts - saw you opened the application. Anything I can clarify?";
const HASH = hashBody(BODY);

// ── The exact shape TextTorrent returns TODAY (no `platform` key at all) ───
// Captured live from chat 1312584 on 2026-08-20.
{
  const live = {
    id: 9001, chat_id: 1312584, direction: "outbound", from: "+19703237557", to: "+15555550123",
    message: BODY, file: null, seen: 0, api_send_status: "Failed", segment: 1,
    msg_type: "sms", created_at: "2026-08-19 18:01:30", updated_at: "2026-08-19 18:01:35",
  };
  const hit = matchThreadMessage([live], { bodyHash: HASH });
  assert.ok(hit, "a message with no `platform` key must still match — this is the regression");
  assert.equal(readReceiptFacts(hit).status, "failed", "and its carrier verdict must be readable");
}

// Explicit null / empty string are the same case.
for (const platform of [null, undefined, ""]) {
  const hit = matchThreadMessage(
    [{ direction: "outbound", message: BODY, api_send_status: "Delivered", platform } as never],
    { bodyHash: HASH },
  );
  assert.ok(hit, `platform=${JSON.stringify(platform)} must not exclude the message`);
}

// ── Where the field IS present, the original intent still applies ──────────
// The gate existed to avoid matching something a rep typed by hand in the
// TextTorrent UI. That protection is kept wherever the provider gives us the
// field to enforce it with.
{
  const typedByAHuman = { direction: "outbound", message: BODY, api_send_status: "Delivered", platform: "web" };
  assert.equal(
    matchThreadMessage([typedByAHuman as never], { bodyHash: HASH }),
    null,
    "a hand-typed message must still be excluded when the platform says so",
  );
  const viaApi = { direction: "outbound", message: BODY, api_send_status: "Delivered", platform: "api" };
  assert.ok(matchThreadMessage([viaApi as never], { bodyHash: HASH }));
}

// ── The other discriminators must keep discriminating ─────────────────────
assert.equal(
  matchThreadMessage([{ direction: "inbound", message: BODY, api_send_status: "Delivered" } as never], { bodyHash: HASH }),
  null,
  "an inbound reply is never our send",
);
assert.equal(
  matchThreadMessage([{ direction: "outbound", message: "different copy", api_send_status: "Delivered" } as never], { bodyHash: HASH }),
  null,
  "the body hash is what identifies the message; a mismatch must not match",
);

// ── Oldest-first pairing survives ─────────────────────────────────────────
// Two receipts in one chat can share a body hash (a retried step re-sends the
// same rendered text). Each carrier message may resolve only ONE receipt, and
// the pairing has to be stable across runs.
{
  const older = { id: 1, direction: "outbound", message: BODY, api_send_status: "Failed", created_at: "2026-08-19 18:01:30" };
  const newer = { id: 2, direction: "outbound", message: BODY, api_send_status: "Delivered", created_at: "2026-08-19 19:30:00" };
  const hit = matchThreadMessage([newer, older] as never[], { bodyHash: HASH });
  assert.equal(hit?.id, 1, "the earliest matching message is claimed first, regardless of input order");
}

console.log("thread-match-platform.test.ts — all assertions passed");
