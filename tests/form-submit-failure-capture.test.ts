/**
 * tests/form-submit-failure-capture.test.ts — a blocked application must be
 * captured, paged, and impossible to forget.
 *
 * Born from the or() parser crash (#224): nine days of public-form submissions
 * destroyed pre-insert, no alert, no copy, unrecoverable. These assertions pin
 * the three guarantees Adon asked for on 2026-08-18:
 *   1. the merchant's data is dead-lettered (recoverable),
 *   2. sunbiz-ops is paged immediately on the ONE decay ladder,
 *   3. Fleet Health stays red until every row is recovered.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripFiles, redactForAlert, cappedJson } from "../lib/forms/submit-failure-capture";
import { FORM_CHECKS } from "../lib/health/form-checks";
import { evaluate } from "../lib/health/checks-core";

// ── stripFiles: a recovery record, not a document store ────────────────────
{
  const out = stripFiles({
    payload: {
      email: "a.b@c.com",
      statement: { inline_base64: "x".repeat(1000), filename: "jan.pdf", mime_type: "application/pdf", size_bytes: 12345 },
      nested: [{ inline_base64: "y", filename: "feb.pdf" }],
    },
  }) as Record<string, any>;
  assert.equal(out.payload.email, "a.b@c.com", "answers survive");
  assert.equal(out.payload.statement.stripped_file, true, "file bytes do not");
  assert.equal(out.payload.statement.filename, "jan.pdf", "file identity survives");
  assert.equal(out.payload.statement.inline_base64, undefined);
  assert.equal(out.payload.nested[0].stripped_file, true, "arrays are walked too");
}

// ── cappedJson: the snapshot column must stay parseable at ANY size ────────
// A raw slice of serialized JSON cuts mid-token on exactly the largest
// submissions — the ones most worth recovering (Codex P2, 2026-08-18).
{
  const small = cappedJson({ email: "a.b@c.com" });
  assert.deepEqual(JSON.parse(small!), { email: "a.b@c.com" }, "small payloads stay plain JSON");
  const big = cappedJson({ email: "a.b@c.com", note: "x".repeat(200_000) });
  const parsed = JSON.parse(big!) as { truncated: boolean; head: string };
  assert.equal(parsed.truncated, true, "oversized payloads carry a truncation marker");
  assert.ok(parsed.head.includes("a.b@c.com"), "contact fields near the front survive truncation");
  assert.equal(cappedJson(null), null);
}

// ── redactForAlert: the page must not leak merchant identifiers ────────────
// The or() crash message itself embedded an email fragment; the full text
// belongs in the DB row, never in Telegram.
{
  const r = redactForAlert("unsupported operator: first — from first.last@gmail.com, call +1 (514) 555-0188");
  assert.ok(!r.includes("first.last@gmail.com"), "emails are crushed in alert text");
  assert.ok(!r.includes("555-0188"), "phone numbers are crushed in alert text");
  assert.ok(r.includes("unsupported operator"), "the diagnostic core survives");
}

// ── forms.submit_failures_open: open rows keep the system red ──────────────
function fakeDb(result: { error: unknown; count: number | null }) {
  const chain: any = {
    select: () => chain,
    is: () => chain,
    gte: () => chain,
    lt: () => chain,
    then: (res: (v: unknown) => unknown) => Promise.resolve(result).then(res),
  };
  return { from: () => chain } as any;
}

const check = FORM_CHECKS.find((c) => c.id === "forms.submit_failures_open");
assert.ok(check, "the dead-letter check must exist");
assert.equal(check!.severity, "critical");
assert.equal(check!.rule.kind, "must_be_zero", "one blocked application is one too many");

// tsx compiles tests as CJS, so the async observe assertions run in an IIFE
// that fails the process loudly — a rejected promise must never read as green.
const asyncChecks = (async () => {
  {
    const observed = await check!.observe(fakeDb({ error: null, count: 3 }), "tenant", Date.now());
    assert.equal(observed, 3);
    const r = evaluate(check!.id, check!.rule, observed, []);
    assert.equal(r.verdict, "failing", "open dead-letter rows MUST page");
    assert.match(check!.describe(r), /recovered_at/, "the alert tells the operator how to close the loop");
  }
  {
    const observed = await check!.observe(fakeDb({ error: null, count: 0 }), "tenant", Date.now());
    const r = evaluate(check!.id, check!.rule, observed, []);
    assert.equal(r.verdict, "ok", "no open rows is healthy");
  }
  {
    // A broken query is NOT a pass — the single most important health property.
    const observed = await check!.observe(fakeDb({ error: new Error("nope"), count: null }), "tenant", Date.now());
    assert.equal(observed, null);
    assert.equal(evaluate(check!.id, check!.rule, observed, []).verdict, "check_broken");
  }
})();

// ── source contracts — the wiring review cannot see at runtime ─────────────
const CAPTURE = readFileSync("lib/forms/submit-failure-capture.ts", "utf8");
const ROUTE = readFileSync("app/api/forms/submit/route.ts", "utf8");
const BEACON = readFileSync("app/api/forms/submit-failure/route.ts", "utf8");
const MIDDLEWARE = readFileSync("middleware.ts", "utf8");
const RUNNER = readFileSync("lib/health/runner.ts", "utf8");
const CLIENT = readFileSync("components/forms/FormPublicClient.tsx", "utf8");
const SUITE = readFileSync("tests/_suite.mjs", "utf8");

// The submit catch dead-letters WITH the merchant's body and WITHOUT the token
// credential.
assert.ok(/captureSubmitFailure\(\{\s*source: "server_catch"/.test(ROUTE), "submit catch must capture");
assert.ok(/token: body\?\.token \? "<redacted>"/.test(ROUTE), "the signed token is a credential, not an answer");

// The alert fires even when the dead-letter insert failed — a broken table
// must not also silence the page.
assert.ok(
  CAPTURE.includes("dead-letter insert ALSO failed"),
  "insert failure must be reported in the page, never swallowed",
);
// Ladder state persists BEFORE the send (crash mid-send loses one page; the
// reverse storms on a crash-loop).
{
  const upsertAt = CAPTURE.indexOf('from("health_alert_state").upsert');
  const sendAt = CAPTURE.indexOf("await sendTelegram(text");
  assert.ok(upsertAt > 0 && sendAt > 0 && upsertAt < sendAt, "persist the ladder state before sending");
}
// Suppression keys on the CONDITION (tenant/form/source), never the message.
assert.ok(/`submitfail:\$\{tenantSlug \?\? "unknown"\}\/\$\{formSlug \?\? "unknown"\}\/\$\{input\.source\}`/.test(CAPTURE),
  "the ladder key must be coarse and message-free");

// The beacon endpoint is public (its own middleware entry — the /submit prefix
// cannot cover the -failure suffix), rate-limited, and size-capped.
assert.ok(MIDDLEWARE.includes('"/api/forms/submit-failure"'), "beacon must be reachable without a session");
assert.ok(/rateLimit\(\{ key: `submit-failure:\$\{ip\}`/.test(BEACON), "beacon must be IP rate-limited");
assert.ok(/BODY_CAP_BYTES/.test(BEACON), "beacon must cap its body");

// The client beacons real losses only — never validation or rate-limit
// responses, which are the system working.
assert.ok(/data\.error === "server_error"/.test(CLIENT), "beacon on server_error");
assert.ok(/non_json_http_/.test(CLIENT), "beacon on a non-JSON (platform) response");
assert.ok(!/rate_limited[\s\S]{0,200}reportSubmitFailure/.test(CLIENT), "no beacon on rate-limit");

// The check actually runs: wired into allChecks(), and this file into the suite.
assert.ok(/\.\.\.FORM_CHECKS/.test(RUNNER), "FORM_CHECKS must be in allChecks()");
assert.ok(SUITE.includes("form-submit-failure-capture.test.ts"), "this test must be in the suite");

asyncChecks.then(
  () => console.log("form-submit-failure-capture: all assertions passed"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
