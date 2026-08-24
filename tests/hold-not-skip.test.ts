/**
 * tests/hold-not-skip.test.ts — "waiting on a lookup" must never be recorded as
 * "no phone".
 *
 * THE OUTAGE THIS PINS (measured 2026-08-23, two full days of it).
 *
 * resolveSendNumber returned a bare `null` for two completely different
 * situations: a lead with no number at all, and a lead whose numbers simply are
 * not verified yet. The caller tested truthiness and called skipStep — and
 * skipStep calls advanceRow, which moves the row permanently past its SMS step.
 *
 *   2026-08-22    72 rows burned as "no_phone_for_sms_step"
 *   2026-08-23   118 rows burned
 *   of those 190 leads, ALL had a phone, NONE had a lookup yet
 *   texts sent in that window: 0, against a target of 40/day
 *
 * It is the same defect Codex flagged two days earlier for the isTextable gate,
 * re-introduced one line earlier by the code that resolves which number to
 * text. The lesson is not "add another check" — it is that a function whose
 * caller must branch on the REASON cannot express that reason as null.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const store = readFileSync(new URL("../lib/sms/destination-health.ts", import.meta.url), "utf8");
const exec = readFileSync(new URL("../lib/drips/executor.ts", import.meta.url), "utf8");

// ── The reason is part of the RETURN TYPE, not inferred by the caller ────
assert.ok(store.includes("export type SendNumber ="), "the result must be a discriminated type");
for (const variant of ['hold: "no_phone"', 'hold: "awaiting_verification"', "hold: null"]) {
  assert.ok(store.includes(variant), `SendNumber must carry ${variant}`);
}
assert.ok(
  !/export async function resolveSendNumber[\s\S]{0,400}?\| null>/.test(store),
  "resolveSendNumber must not be able to return a bare null again",
);

// ── Each exit says WHICH kind it is ──────────────────────────────────────
{
  const fn = store.slice(store.indexOf("export async function resolveSendNumber"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(!/\breturn null;/.test(body), "no bare null returns may remain inside resolveSendNumber");

  // Numbers exist but cannot be vetted right now -> HOLD, not skip. Burning a
  // row over a transient database problem is the more expensive mistake.
  assert.ok(
    /if \(res\.error\) return \{ phone: null, source: null, hold: "awaiting_verification" \};/.test(body),
    "an unreadable health table must hold, because the lead does have numbers",
  );
  // Nothing on the lead at all -> permanent, skip is correct.
  assert.ok(
    /if \(candidates\.length === 0\) return \{ phone: null, source: null, hold: "no_phone" \};/.test(body),
    "a lead with no number at all is a permanent skip",
  );
  // Verified-only filtered everything out -> a lookup may still land.
  assert.ok(
    /if \(pool\.length === 0\) return \{ phone: null, source: null, hold: "awaiting_verification" \};/.test(body),
    "nothing verified YET must hold, not skip",
  );
}

// ── The caller branches on the discriminator ─────────────────────────────
{
  assert.ok(
    exec.includes('if (resolved.hold === "awaiting_verification")'),
    "dispatch must branch on the reason, not on truthiness",
  );
  const holdIdx = exec.indexOf('if (resolved.hold === "awaiting_verification")');
  const branch = exec.slice(holdIdx, holdIdx + 400);
  assert.ok(/holdOrEmailInstead\(/.test(branch), "awaiting a lookup must HOLD and retry");
  assert.ok(!/skipStep\(/.test(branch), "and must never skip, which advances past the step");

  // The permanent case still skips, so email steps still run.
  assert.ok(
    exec.includes('if (!resolved.phone) return skipStep(db, row, steps, "no_phone_for_sms_step");'),
    "a genuine no-phone still skips and advances",
  );
  // Ordering: the hold must be checked BEFORE the skip, or the skip catches
  // everything again.
  assert.ok(holdIdx < exec.indexOf('return skipStep(db, row, steps, "no_phone_for_sms_step");'),
    "the hold branch must come first");

  // And the old collapsing read must be gone for good.
  assert.ok(
    !/const phone = resolved\?\.phone \?\? "";/.test(exec),
    "the truthiness collapse that caused the outage must not return",
  );
}

console.log("hold-not-skip.test.ts — all assertions passed");
