/**
 * tests/infer-result-text.test.ts — regression for the 2026-08-09→16 classifier
 * outage.
 *
 * The Turso shim's row decoder (turso-postgrest fromSql) JSON.parses any TEXT
 * value that starts with '{' or '['. inference_jobs.result_text holds the
 * classifier's JSON document, so after the 8/09 cutover it came back as an
 * OBJECT, and queueInfer's `(p.result_text || "").trim()` threw TypeError on
 * every completed job. classify-reply caught the throw as CLASSIFIER_UNAVAILABLE,
 * the scan reported classifier_down on every tick, the offers-scanner paged
 * BLOCKED for 10 days, and every lender reply since the cutover (including a
 * $200K approval) was classified successfully and then thrown away — re-queued
 * every 30 minutes forever.
 *
 * Reproduced live 2026-08-16: typeof result_text === "object",
 * `trim is not a function`, job 8bd500f6 (category "approved") never collected.
 *
 * The rule under test: queue result text must be usable whether the data layer
 * returns the column as a raw string (Postgres/PostgREST), a parsed object
 * (Turso shim), null, or garbage. Never assume the backend's decode.
 */
import assert from "node:assert/strict";
import { coerceInferResultText } from "../lib/infer-result-text";

// The exact shape stored by the classifier and returned parsed by the shim.
const PROD_OBJECT = {
  category: "approved",
  confidence: 0.9,
  amount: 200000,
  term_months: 8.3,
  factor_rate: 1.49,
};

// 1. The outage case: an object must round-trip to its JSON string, not throw.
{
  const text = coerceInferResultText(PROD_OBJECT);
  assert.equal(typeof text, "string", "object input must come back as a string");
  const parsed = JSON.parse(text);
  assert.equal(parsed.category, "approved", "the JSON string must re-parse to the same document");
  assert.equal(parsed.amount, 200000);
}

// 2. The pre-cutover case: a plain string passes through untouched.
assert.equal(coerceInferResultText('{"category":"declined"}'), '{"category":"declined"}');
assert.equal(coerceInferResultText("  plain text  "), "  plain text  ", "no trimming here — callers trim");

// 3. Null / undefined / empty become the empty string, which callers treat as
// "no result yet" — NOT a crash and NOT a fake result.
assert.equal(coerceInferResultText(null), "");
assert.equal(coerceInferResultText(undefined), "");
assert.equal(coerceInferResultText(""), "");

// 4. Arrays (the other '['-prefixed parse the shim performs) also round-trip.
assert.equal(coerceInferResultText([1, 2]), "[1,2]");

// 5. Numbers/booleans (defensive): stringified, never thrown.
assert.equal(coerceInferResultText(0), "0");
assert.equal(coerceInferResultText(false), "false");

// 6. THE REGRESSION, exactly as deployed: prove the OLD expression throws on
// what the shim now returns, so this test cannot silently pass against a
// backend that never triggers the bug. If this stops throwing, the shim's
// decode changed and this whole coercion layer should be revisited.
assert.throws(
  () => ((PROD_OBJECT as unknown as string) || "").trim(),
  /trim is not a function/,
  "the un-coerced expression must throw on shim output — if not, revisit the coercion",
);

console.log("infer-result-text.test.ts: all assertions passed");
