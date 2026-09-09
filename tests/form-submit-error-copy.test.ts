/**
 * form-submit-error-copy.test.ts — a merchant must never be shown an error code.
 *
 * THE DEFECT THIS PINS (2026-09-08). `FormPublicClient` resolved a failed submit
 * as `friendly[code] || data.error || <generic sentence>`, and `friendly` held
 * exactly two entries. For the other eighteen rejections `/api/forms/submit` can
 * return, that middle term rendered the RAW IDENTIFIER into the page. Verified
 * live against production on all four merchant hosts: a street-only address came
 * back `{error:"incomplete_address", field:"business_address", message:"Include
 * the state and ZIP code..."}` and the merchant was shown the literal string
 * "incomplete_address" while the server's own sentence was thrown away.
 *
 * WHY A TEST AND NOT JUST THE FIX. The copy map is only correct on the day it is
 * written. The route grows rejections; a hand-maintained map silently falls
 * behind, and the symptom is invisible to us and only visible to a merchant who
 * then leaves. So this reads the codes OUT OF THE ROUTE SOURCE and fails on any
 * that has no copy. Adding a rejection to the route without copy breaks CI.
 *
 * Proven to fire: deleting any single entry from SUBMIT_ERROR_COPY fails case 2,
 * and restoring the old `|| data.error` fallback fails case 3.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SUBMIT_ERROR_COPY, SUBMIT_ERROR_FALLBACK } from "../components/forms/FormPublicClient";

const ROUTE = resolve(__dirname, "../app/api/forms/submit/route.ts");

/** Every `error: "..."` literal the route can send back to a browser. */
function errorCodesInRoute(): string[] {
  const src = readFileSync(ROUTE, "utf8");
  const found = new Set<string>();
  for (const m of src.matchAll(/\berror:\s*"([a-z_]+)"/g)) found.add(m[1]);
  return [...found].sort();
}

/** The resolution order shipped in FormPublicClient.submit(). */
function whatMerchantSees(data: { error?: string; message?: string } | null): string {
  return (
    data?.message ||
    (data?.error ? SUBMIT_ERROR_COPY[data.error] : undefined) ||
    SUBMIT_ERROR_FALLBACK
  );
}

function run() {
  /* 1. The route still speaks the vocabulary this test thinks it does. If this
   *    ever finds nothing, the regex has drifted and cases 2-3 would pass
   *    vacuously — the exact way a guard rots into decoration. */
  const codes = errorCodesInRoute();
  assert.ok(
    codes.length >= 15,
    `expected to find the route's error codes, found ${codes.length}: ${codes.join(", ")}`,
  );
  assert.ok(codes.includes("incomplete_address"), "sanity: incomplete_address should be in the route");

  /* 2. Every one of them has merchant copy. */
  const unmapped = codes.filter((c) => !(c in SUBMIT_ERROR_COPY));
  assert.deepStrictEqual(
    unmapped,
    [],
    `these rejections would be shown to a merchant as a raw code: ${unmapped.join(", ")}. ` +
      `Add copy to SUBMIT_ERROR_COPY in components/forms/FormPublicClient.tsx.`,
  );

  /* 3. No resolution path can ever produce the code itself. */
  for (const code of codes) {
    const shown = whatMerchantSees({ error: code });
    assert.notStrictEqual(shown, code, `merchant would see the raw code "${code}"`);
    assert.ok(!shown.includes("_"), `copy for "${code}" looks like an identifier: "${shown}"`);
    assert.ok(shown.trim().length > 20, `copy for "${code}" is too terse to help: "${shown}"`);
  }

  /* 4. An unknown code degrades to the sentence, never to itself. */
  const invented = "some_code_that_does_not_exist";
  assert.strictEqual(whatMerchantSees({ error: invented }), SUBMIT_ERROR_FALLBACK);
  assert.strictEqual(whatMerchantSees(null), SUBMIT_ERROR_FALLBACK);

  /* 5. The route's own sentence wins — it can name the field, our copy cannot.
   *    This is the exact payload production returned for a street-only address. */
  assert.strictEqual(
    whatMerchantSees({
      error: "incomplete_address",
      message: "Include the state and ZIP code. For example: 911 Magnolia Dr, Algonquin, IL 60102",
    }),
    "Include the state and ZIP code. For example: 911 Magnolia Dr, Algonquin, IL 60102",
  );

  console.log(`form-submit-error-copy: OK (${codes.length} rejections, all mapped)`);
}

run();
