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
// (The skip/hold split is asserted precisely further down, under CODEX P1 #1 —
// a permanent block skips and advances, a temporary one holds and retries.)

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
  /import \{[^}]*\bisTextable\b[^}]*\} from "@\/lib\/sms\/destination-health";/.test(exec),
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

// ── CODEX P1 #1: a TEMPORARY hold must not permanently skip the message ──
// skipStep calls advanceRow. The first cut used it for
// `awaiting_verification` too, so the SMS step was stepped past for good and
// the lookup completing later could never deliver it — while the comment
// claimed the hold "clears when the queue drains". It did not.
{
  const start = exec.indexOf('if (reach.hold === "awaiting_verification")');
  assert.ok(start > 0, "the temporary hold must be handled separately from the permanent one");
  const branch = exec.slice(start, start + 400);
  assert.ok(/holdOrEmailInstead\(/.test(branch), "a number awaiting its lookup must be HELD and retried");
  assert.ok(!/skipStep\(/.test(branch), "it must NOT be skipped, which would advance past the step");
  // Long enough that the answer can actually have arrived: the lookup queue
  // drains against a daily cap.
  assert.ok(/\n\s*24, `sms_awaiting_verification/.test(exec), "held for 24h, not minutes");
}
// The PERMANENT one still skips, so the sequence's email steps run.
{
  assert.ok(
    exec.includes('return skipStep(db, row, steps, `sms_unreachable: ${reach.reason}`);'),
    "a genuinely unreachable number still skips and advances",
  );
}

// ── CODEX P1 #2: a bench outranks verification ──────────────────────────
// The flags answer different questions and can disagree: a lookup-tagged
// Wireless number is verified=1, and after repeated carrier failures becomes
// textable=0. Returning early on `verified` made the strict mode a way AROUND
// the failure bench.
{
  const store = readFileSync(new URL("../lib/sms/destination-health.ts", import.meta.url), "utf8");
  const benchIdx = store.indexOf("if (benched) {");
  const verifiedIdx = store.indexOf("if (!verified) {");
  assert.ok(benchIdx > 0 && verifiedIdx > 0, "both checks must exist");
  assert.ok(benchIdx < verifiedIdx, "the bench must be checked BEFORE verification is accepted");
  assert.ok(
    store.includes('return { textable: false, reason: row.reason || "benched", hold: "unreachable" };'),
    "a benched number is unreachable regardless of how it was classified",
  );
}

console.log("destination-gate-wired.test.ts — all assertions passed");
