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
  exec.includes("return skipStep(db, row, steps, reason);"),
  "an unreachable destination is a SKIP that advances the sequence, so the email steps still run",
);

// ── PERMANENT AND TEMPORARY HOLDS ARE RECORDED SEPARATELY ────────────────
// `sms_unreachable` is a landline or a repeatedly-failing number. A number
// simply waiting for its phone lookup is `sms_awaiting_verification` and clears
// on its own. The guard audit counts by reason, so filing hundreds of temporary
// waits as "unreachable" would show the landline gate firing constantly and
// hide the occasions it genuinely fires.
assert.ok(
  exec.includes('`sms_awaiting_verification: ${reach.reason}`'),
  "a number waiting on its lookup must be recorded as a temporary hold",
);
assert.ok(
  exec.includes('`sms_unreachable: ${reach.reason}`'),
  "and a genuinely unreachable one keeps the permanent reason",
);
assert.ok(
  exec.includes('reach.hold === "awaiting_verification"'),
  "the split must come from the discriminator, not from parsing the reason text",
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
    store.includes("return { textable: false, reason: `destination health unreadable"),
    "isTextable must refuse to send when it cannot read the verdict",
  );

  // ── VERIFIED-ONLY MODE ────────────────────────────────────────────────
  // While the lookup backlog drains, send only where there is positive
  // evidence the number reaches a handset. A number with NO row at all is the
  // state the whole 347-lead cohort is in, so it must hold rather than send.
  assert.ok(
    store.includes('reason: "awaiting phone verification (no lookup on file)"'),
    "under verified-only, an unknown number holds instead of being tried",
  );
  assert.ok(
    /export function verifiedOnly\(env: NodeJS\.ProcessEnv = process\.env\)/.test(store),
    "the mode must be read at CALL time, so it can be switched without a deploy",
  );
  assert.ok(
    store.includes('String(env.DRIPS_SMS_VERIFIED_ONLY || "").trim() === "1"'),
    "and gated on an explicit env flag rather than becoming the permanent default",
  );
  // The looser default must survive underneath it: this is a stricter question
  // asked on top, not a reversal of the fail-open rule that lets a genuinely
  // new number be learned about.
  {
    const core = readFileSync(new URL("../lib/sms/destination-health-core.ts", import.meta.url), "utf8");
    assert.ok(
      core.includes('return { last10, textable: true, reason: "no history", delivered, failed };'),
      "destinationVerdict must still fail OPEN on an unknown number",
    );
  }
  assert.ok(
    store.includes("if (res.error) return null;"),
    "untextableNumbers must return null, not an empty set, so a caller cannot read a broken table as 'nobody is benched'",
  );
}

console.log("destination-gate-wired.test.ts — all assertions passed");
