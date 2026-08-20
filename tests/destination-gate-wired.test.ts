/**
 * tests/destination-gate-wired.test.ts — the landline gate is actually WIRED
 * INTO dispatch, not merely exported.
 *
 * Every silent failure found on 2026-08-20 had the same shape: a rule that
 * existed and was never consulted, or was consulted in a way that could not
 * match. So the assertion has to be about the CALL SITE.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const exec = readFileSync(new URL("../lib/drips/executor.ts", import.meta.url), "utf8");

// ── It is called, at dispatch, on the phone we are about to text ──────────
assert.ok(
  exec.includes("const reach = await isTextable(row.tenant_id, phone);"),
  "dispatch must consult destination health for the number it is about to send to",
);
assert.ok(
  exec.includes('skipStep(db, row, steps, `sms_unreachable: ${reach.reason}`)'),
  "an unreachable destination is a SKIP that advances the sequence, so the email steps still run",
);
assert.ok(
  /import \{ isTextable \} from "@\/lib\/sms\/destination-health";/.test(exec),
  "and the import must exist, or the call site is a reference error waiting to ship",
);

// ── ORDERING IS LOAD-BEARING ──────────────────────────────────────────────
// An opt-out is a legal instruction from a person and must outrank a technical
// fact about a handset. If the landline gate ran first, a merchant who replied
// STOP from a desk phone would be recorded as "unreachable" rather than
// "opted out", and the consent decision would never be taken.
{
  const optOut = exec.indexOf("checkPhoneOptOut(row.tenant_id, phone)");
  const landline = exec.indexOf("const reach = await isTextable(row.tenant_id, phone);");
  const lawful = exec.indexOf("mayTextFor(data, purpose)");
  assert.ok(optOut > 0 && landline > 0 && lawful > 0, "all three gates must be present");
  assert.ok(optOut < landline, "opt-out is checked BEFORE reachability");
  assert.ok(landline < lawful, "reachability is checked before spending a lawful-basis decision");
}

// ── It must not be a FAILURE, which would burn the retry budget ───────────
// A landline will never become textable by retrying, and marking it failed
// would both consume attempts and paint the sequence red for something that is
// working exactly as intended.
{
  const start = exec.indexOf("const reach = await isTextable");
  const window = exec.slice(start, start + 300);
  assert.ok(!/markPermanentFail|markRetryOrFail/.test(window), "must not be recorded as a failure or a retry");
}

// ── The pure rule must FAIL CLOSED when the table cannot be read ──────────
// An unreadable health table is an absence of facts. Sending into it is
// precisely the landline blast this closes.
{
  const store = readFileSync(new URL("../lib/sms/destination-health.ts", import.meta.url), "utf8");
  assert.ok(
    store.includes("if (res.error) return { textable: false, reason: `destination health unreadable"),
    "isTextable must refuse to send when it cannot read the verdict",
  );
  assert.ok(
    store.includes("if (res.error) return null;"),
    "untextableNumbers must return null, not an empty set, so a caller cannot read a broken table as 'nobody is benched'",
  );
}

console.log("destination-gate-wired.test.ts — all assertions passed");
