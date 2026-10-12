/**
 * A presigned PUT whose Content-Length and Content-Type are part of the
 * SIGNATURE actually binds them: a request with a different real body size
 * or a different declared type produces a canonical request R2's own
 * independent SigV4 check would never accept.
 * Run: node --conditions=react-server --import tsx tests/r2-signed-url-constrained.test.ts
 *
 * WHY THIS EXISTS (Codex security review 2026-10-12, resource-cap-bypass)
 * Offer-page video uploads mint a presigned PUT for a declared size and type,
 * then trust R2 itself to refuse any OTHER body - a server-side check after
 * the fact is not enough if the client can simply send more bytes than it
 * said it would. lib/r2-storage.ts's presign() gained an additive
 * `extraSignedHeaders` parameter (createSignedUploadUrlConstrained) so
 * Content-Length and Content-Type are SIGNED, not just stated: R2 answers
 * SignatureDoesNotMatch unless the real request's headers are byte-identical
 * to what was minted. There is no live R2 in this environment, so this test
 * proves the claim the way r2-signed-url-window.test.ts proves window
 * stability: an INDEPENDENT re-implementation of SigV4 (not copied from the
 * module under test) that R2 would run the same check with.
 *
 * WHAT IS PINNED
 *  1. The unconstrained presign (every existing caller) is BYTE-IDENTICAL to
 *     before: SignedHeaders stays "host", no regression from the additive change.
 *  2. A constrained PUT's SignedHeaders lists content-length, content-type and
 *     host (sorted), and its signature matches only when a verifier is given
 *     EXACTLY those header values - the real binding R2 would enforce.
 *  3. A verifier given a DIFFERENT Content-Length (a client claiming a
 *     smaller or larger body than what it will actually send) computes a
 *     DIFFERENT signature than the one in the URL: that request is refused.
 *  4. The same for a different Content-Type.
 *  5. The upload window is short (minutes), as the review asked.
 *
 * The R2_* values are test placeholders, not credentials.
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import { r2StorageSurface } from "../lib/r2-storage";
import { OFFER_UPLOAD_PUT_TTL_SEC } from "../lib/offer-pages/upload";

process.env.R2_ACCOUNT_ID = "test-account";
process.env.R2_ACCESS_KEY_ID = "test-key-id";
process.env.R2_SECRET_ACCESS_KEY = "test-secret";
process.env.R2_BUCKET = "test-bucket";

let failed = 0;
let passed = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${(e as Error).message.split("\n").join("\n       ")}`);
  }
}

const bucket = () => r2StorageSurface().from("offer-page-uploads");
const PATH = "tenant-a/offer-pages/_staging/video/aaaaaaaa-0000-4000-8000-000000000000.mp4";

/**
 * SigV4 query presign, written from the AWS spec rather than copied from
 * lib/r2-storage.ts - with the canonical headers block built from whatever
 * header VALUES the caller supplies, so a wrong value is provably a wrong
 * signature rather than something this helper silently corrects.
 */
function expectedSignature(url: string, method: "GET" | "PUT", headerValues: Record<string, string>): string {
  const u = new URL(url);
  const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const query = [...u.searchParams.entries()]
    .filter(([k]) => k !== "X-Amz-Signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");
  const amz = u.searchParams.get("X-Amz-Date")!;
  const credential = u.searchParams.get("X-Amz-Credential")!;
  const scope = credential.split("/").slice(1).join("/");
  const signedHeaders = u.searchParams.get("X-Amz-SignedHeaders")!;
  const headerNames = signedHeaders.split(";");
  const values: Record<string, string> = { host: u.host, ...headerValues };
  const canonicalHeaders = headerNames.map((h) => `${h}:${values[h]}\n`).join("");
  const canonical = [method, u.pathname, query, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amz, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const h = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d, "utf8").digest();
  const day = scope.split("/")[0];
  const key = h(h(h(h("AWS4test-secret", day), "auto"), "s3"), "aws4_request");
  return createHmac("sha256", key).update(toSign, "utf8").digest("hex");
}

async function main() {
  console.log("r2-signed-url-constrained");

  await check("the unconstrained presign is unaffected: SignedHeaders stays 'host' (no regression for every existing caller)", async () => {
    const up = await bucket().createSignedUploadUrl(PATH);
    assert.equal(up.error, null);
    const u = new URL(up.data!.signedUrl);
    assert.equal(u.searchParams.get("X-Amz-SignedHeaders"), "host");
    assert.equal(u.searchParams.get("X-Amz-Signature"), expectedSignature(up.data!.signedUrl, "PUT", {}));
  });

  const CONTENT_LENGTH = "52428800"; // 50 MiB, well inside the 500 MB cap
  const CONTENT_TYPE = "video/mp4";

  await check("a constrained PUT signs content-length, content-type AND host (sorted), for the short upload window", async () => {
    const r = await bucket().createSignedUploadUrlConstrained(PATH, { contentLength: 52428800, contentType: CONTENT_TYPE, ttlSec: OFFER_UPLOAD_PUT_TTL_SEC });
    assert.equal(r.error, null, JSON.stringify(r.error));
    const u = new URL(r.data!.signedUrl);
    assert.equal(u.searchParams.get("X-Amz-SignedHeaders"), "content-length;content-type;host", "sorted alphabetically");
    assert.equal(u.searchParams.get("X-Amz-Expires"), String(OFFER_UPLOAD_PUT_TTL_SEC), "the short window the review asked for, not the shared default");
    assert.ok(OFFER_UPLOAD_PUT_TTL_SEC <= 10 * 60, "minutes, not the old 15-minute shared default");
  });

  await check("the signature matches ONLY when a verifier is given the exact Content-Length and Content-Type that were signed", async () => {
    const r = await bucket().createSignedUploadUrlConstrained(PATH, { contentLength: 52428800, contentType: CONTENT_TYPE, ttlSec: OFFER_UPLOAD_PUT_TTL_SEC });
    const url = r.data!.signedUrl;
    const sig = new URL(url).searchParams.get("X-Amz-Signature");
    assert.equal(sig, expectedSignature(url, "PUT", { "content-length": CONTENT_LENGTH, "content-type": CONTENT_TYPE }), "the real values verify");
  });

  await check("a DIFFERENT real body length (a client sending more bytes than it declared) does not verify - R2 would refuse the PUT", async () => {
    const r = await bucket().createSignedUploadUrlConstrained(PATH, { contentLength: 52428800, contentType: CONTENT_TYPE, ttlSec: OFFER_UPLOAD_PUT_TTL_SEC });
    const url = r.data!.signedUrl;
    const sig = new URL(url).searchParams.get("X-Amz-Signature");
    const biggerBody = String(600 * 1024 * 1024); // over the 500 MB cap
    assert.notEqual(
      sig,
      expectedSignature(url, "PUT", { "content-length": biggerBody, "content-type": CONTENT_TYPE }),
      "an oversize body's own Content-Length produces a different, non-matching signature",
    );
  });

  await check("a DIFFERENT declared Content-Type does not verify either", async () => {
    const r = await bucket().createSignedUploadUrlConstrained(PATH, { contentLength: 52428800, contentType: CONTENT_TYPE, ttlSec: OFFER_UPLOAD_PUT_TTL_SEC });
    const url = r.data!.signedUrl;
    const sig = new URL(url).searchParams.get("X-Amz-Signature");
    assert.notEqual(sig, expectedSignature(url, "PUT", { "content-length": CONTENT_LENGTH, "content-type": "application/x-sh" }));
  });

  console.log(`\nr2-signed-url-constrained: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
