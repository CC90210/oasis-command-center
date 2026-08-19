/**
 * tests/ai-wire.test.ts — the AI Follow-Up wire routes Live Subs, and only
 * Live Subs.
 *
 * Adon, 2026-08-14: "There should be a sub-account called AI Follow-Up Account.
 * That's gonna be the sub-account that we use for the Live Subs follow-ups."
 *
 * WHY THE SCOPE IS THE THING UNDER TEST. On 2026-08-13 he was emphatic in the
 * other direction: "there are three separate wires for three separate
 * TextTorrent accounts... we need to have each of them using their own numbers
 * not all of them using one number. That defeats the entire purpose." So a bug
 * that widens this wire past Live Subs does not look like a bug — it looks like
 * texts going out, from a working number, with replies landing in an inbox the
 * rep cannot see. Exactly the failure the three-wire rule exists to prevent.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  usesAiWire, aiWireStages, aiWireNumbers, smsOnlyStages, isSmsOnly,
  AI_WIRE_ACT_AS, AI_WIRE_REP_KEY, AI_WIRE_SERVICE,
} from "../lib/drips/ai-wire-core";
import { repKeyForOwner, actAsEmailForRep } from "../lib/drips/rep-keys";

const NO_ENV: Record<string, string | undefined> = {};

// ── Live Subs go on the wire; nothing else does ───────────────────────────
for (const stage of ["uw_sheet", "live_sub", "live_subs", "UW_Sheet"]) {
  assert.equal(usesAiWire({ stage }, NO_ENV), true, `${stage} is Live Subs`);
}
for (const stage of ["follow_up", "signed_application", "declined", "viewed_application", "funded", ""]) {
  assert.equal(usesAiWire({ stage }, NO_ENV), false, `${stage} must stay on its rep's wire`);
}
assert.equal(usesAiWire({}, NO_ENV), false, "a lead with no stage is not a Live Sub");

// ── The identity halves must travel together ──────────────────────────────
// The act-as is a sub-account of the LEGACY parent. Sent against the main
// SunBiz SID it 401s (verified live 2026-08-14), so a change that keeps one
// half and drops the other silently kills every Live Sub text.
assert.equal(AI_WIRE_ACT_AS, "submissions@sunbizfunding.com");
assert.equal(AI_WIRE_SERVICE, "texttorrent_followup", "must authenticate against the Legacy parent");
assert.equal(actAsEmailForRep(AI_WIRE_REP_KEY), AI_WIRE_ACT_AS, "rep-keys and the wire must agree");

// ── The sync must not file AI numbers under admin ─────────────────────────
// TextTorrent reports them as purchased_by "AI Follow-Up". Falling through to
// admin would put them in Matt's pool, and Matt's leads would then be texted
// from the Legacy account under an act-as the main SID does not know: 401 on
// every send, from a pool that reads perfectly healthy.
for (const owner of ["AI Follow-Up", "ai follow-up", "AI FOLLOW-UP", "AIFollowUp"]) {
  assert.equal(repKeyForOwner(owner), AI_WIRE_REP_KEY, `"${owner}" must map to the AI wire`);
}
// And it must not steal anyone else's numbers.
assert.equal(repKeyForOwner("Legacy Funding"), "admin");
assert.equal(repKeyForOwner("Alex Johnson"), "alex");
assert.equal(repKeyForOwner("Jordan"), "jordan");
assert.equal(repKeyForOwner("Matt"), "admin");
assert.equal(repKeyForOwner(null), "admin");

// ── Verified defaults ─────────────────────────────────────────────────────
// Both confirmed live 2026-08-14 as user_id 1522 / "AI Follow-Up".
assert.deepEqual(aiWireNumbers(NO_ENV), ["+19703237557", "+16505977482"]);

// ── Env overrides, and their fail-closed behaviour ────────────────────────
// Numbers rotate roughly weekly, so an override exists. A BROKEN override must
// not empty the pool: an empty pool blocks every Live Sub text with
// rep_has_no_line, which turns a fat-fingered env var into a silent outage on
// the one wire the carrier is not refusing.
assert.deepEqual(
  aiWireNumbers({ DRIP_AI_WIRE_NUMBERS: "+15551234567, +15557654321" }),
  ["+15551234567", "+15557654321"],
);
for (const bad of ["", "   ", "not-a-number", "5551234567", ",,,"]) {
  assert.deepEqual(
    aiWireNumbers({ DRIP_AI_WIRE_NUMBERS: bad }),
    ["+19703237557", "+16505977482"],
    `"${bad}" must fall back to the verified pair, never to nothing`,
  );
}

// Same rule for the stage list.
assert.deepEqual(aiWireStages({ DRIP_AI_WIRE_STAGES: "uw_sheet,follow_up" }), ["uw_sheet", "follow_up"]);
assert.deepEqual(aiWireStages({ DRIP_AI_WIRE_STAGES: "  " }), ["uw_sheet", "live_sub", "live_subs"]);
assert.deepEqual(aiWireStages({ DRIP_AI_WIRE_STAGES: ",,," }), ["uw_sheet", "live_sub", "live_subs"]);

// ── The deferred option: widen to everything without a deploy ─────────────
// Adon deferred "all drips on this account" rather than rejecting it, so the
// switch has to exist and has to be exercised — an untested escape hatch is
// not an escape hatch.
{
  const all = { DRIP_AI_WIRE_STAGES: "*" };
  assert.deepEqual(aiWireStages(all), ["*"]);
  for (const stage of ["follow_up", "declined", "uw_sheet", "anything"]) {
    assert.equal(usesAiWire({ stage }, all), true);
  }
  assert.equal(usesAiWire({}, all), true, "even a stageless lead, when the wire is set to everything");
}

// ── THE COUPLING: setting one of these without the other is a trap ───────
// smsOnlyStages() DEFAULTS to aiWireStages(). So adding a stage to the AI wire
// silently makes that stage SMS-ONLY as well.
//
// Found live 2026-08-19. The phone-only follow-up SMS sequence targets
// follow_up, which was NOT on the AI wire, so its 25 enrolled texts were routed
// by classifyRep onto Alex's, Jordan's and Matt's numbers — the carrier-dead
// main account. The obvious fix (add follow_up to DRIP_AI_WIRE_STAGES) would
// have fixed the wire and BROKEN the Bluerise email sequence on the same stage
// in the same move, because follow_up would have become un-emailable.
//
// Both must be set together. This pins that, so the next person who adds a
// stage sees the pair rather than discovering it in production.
{
  const wireOnly = { DRIP_AI_WIRE_STAGES: "uw_sheet,live_sub,live_subs,follow_up" };
  assert.equal(usesAiWire({ stage: "follow_up" }, wireOnly), true);
  assert.equal(
    smsOnlyStages(wireOnly).includes("follow_up"),
    true,
    "THE TRAP: the AI-wire list alone also makes the stage SMS-only",
  );

  // Production is set to this pair.
  const live = {
    DRIP_AI_WIRE_STAGES: "uw_sheet,live_sub,live_subs,follow_up",
    DRIP_SMS_ONLY_STAGES: "uw_sheet,live_sub,live_subs",
  };
  assert.equal(usesAiWire({ stage: "follow_up" }, live), true, "follow_up texts go out on the AI wire");
  assert.equal(isSmsOnly({ stage: "follow_up" }, live), false, "and follow_up EMAIL still sends");
  assert.equal(usesAiWire({ stage: "uw_sheet" }, live), true, "Live Subs unchanged");
  assert.equal(isSmsOnly({ stage: "uw_sheet" }, live), true, "and still SMS-only");
}

// ── A narrowed override really does narrow it ─────────────────────────────
{
  const onlyFollowUp = { DRIP_AI_WIRE_STAGES: "follow_up" };
  assert.equal(usesAiWire({ stage: "follow_up" }, onlyFollowUp), true);
  assert.equal(usesAiWire({ stage: "uw_sheet" }, onlyFollowUp), false, "an override replaces the defaults, not adds to them");
}

// ── The breaker must be PER WIRE, or the wire is pointless ────────────────
// Codex, reviewing the first cut: the SMS circuit breaker read receipts by
// tenant only. So the main SunBiz SID's 19 consecutive carrier failures would
// halt the brand-new Legacy/AI account too, and every Live Sub would fall back
// to email without either unburned number ever being tried — the outage this
// wire exists to escape, escaping with it.
//
// Asserted at the source level: this is I/O-shaped and there is no way to
// observe it from a pure unit test, and "we fixed it once" is not a guarantee.
{
  const exec = readFileSync(new URL("../lib/drips/executor.ts", import.meta.url), "utf8");
  assert.ok(
    !/smsSendAllowed\(\s*row\.tenant_id\s*\)/.test(exec),
    "a tenant-only breaker call halts the AI wire for the main account's failures",
  );
  assert.ok(
    exec.includes("smsSendAllowed(row.tenant_id, { wire, onlyLines: wireLines })"),
    "the verdict is keyed per wire and scoped to that wire's own lines",
  );
  // The probe lease too, or whichever wire dispatch reaches first takes the
  // only probe every interval and the other route never tests recovery.
  assert.ok(
    /claimBreakerProbe\(row\.tenant_id,\s*Date\.now\(\),\s*wire\)/.test(exec),
    "the half-open probe lease must be per wire",
  );

  const breaker = readFileSync(new URL("../lib/sms/send-breaker.ts", import.meta.url), "utf8");
  assert.ok(breaker.includes("`${tenantId}::${opts.wire}`"), "the cache key must include the wire");
  assert.ok(/for \(const k of cache\.keys\(\)\)/.test(breaker),
    "resetBreakerCache must clear every wire for the tenant, or a recovered wire stays halted");
  assert.ok(
    breaker.includes("newestOpenReceiptAt(tenantId, { onlyLines: opts.onlyLines })"),
    "an unresolved probe on one wire must not suppress the other wire's probe",
  );

  // THE DANGEROUS ONE. Scoping in memory AFTER a LIMIT silently truncates: a
  // busy wire's newer receipts fill the page, the quiet wire comes back empty,
  // and the breaker reads "no failures" for a route that is dead. The filter
  // has to be in the query.
  const receipts = readFileSync(new URL("../lib/sms/delivery-receipts.ts", import.meta.url), "utf8");
  assert.ok(receipts.includes('q.in("from_number", opts.onlyLines)'), "scope in the query, not after the limit");
  assert.ok(!receipts.includes("excludeLines"), "an allow-list only — exclusion cannot be expressed in the query");
  assert.ok(
    receipts.includes("if (opts.onlyLines && opts.onlyLines.length === 0) return [];"),
    "an empty scope is a real empty sample, not an instruction to read every line",
  );
}

// ── A missing second account must not freeze the FIRST one's cleanup ──────
// Also Codex. The first cut set a global "do not deactivate" whenever the
// follow-up account could not be read — and no tenant except SunBiz has one.
// Every other tenant would then keep rotated-away numbers active forever, which
// is the original 1,070-sends-from-dead-numbers outage let back in sideways.
{
  const sync = readFileSync(new URL("../lib/drips/sender-sync.ts", import.meta.url), "utf8");
  assert.ok(!sync.includes("canDeactivate ? stored : []"), "the sweep must not be skipped wholesale");
  assert.ok(sync.includes("canDeactivateAiWire"), "suppression is scoped to the wire that could not be read");
  assert.ok(
    sync.includes("row.rep_key === AI_WIRE_REP_KEY"),
    "only AI-wire rows are spared; every other wire is swept as normal",
  );
  assert.ok(
    /notConfigured/.test(sync),
    "'this tenant has no follow-up account' is a normal state, not a reason to suppress anything",
  );
}

console.log("ai-wire.test.ts — all assertions passed");
