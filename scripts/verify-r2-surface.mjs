/**
 * Verify the R2 storage adapter's SHAPE and SIGNING without needing credentials.
 *
 * The adapter stands in for `supabase.storage` behind a proxy, so 23 call sites
 * will use it without knowing. If a method is missing or returns a different
 * shape, the failure surfaces as a TypeError deep inside a document upload —
 * not at build time. These checks are what makes the substitution safe to ship
 * before anyone can test against a real bucket.
 *
 * Run:  node scripts/verify-r2-surface.mjs
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

let failures = 0;
const check = (name, ok, detail = "") => {
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const src = readFileSync(new URL("../lib/r2-storage.ts", import.meta.url), "utf8");

console.log("surface parity with supabase.storage");
for (const m of ["upload", "download", "createSignedUrl", "createSignedUrls",
                 "getPublicUrl", "remove", "list"]) {
    check(`bucket API implements ${m}()`, new RegExp(`\\b${m}\\s*[(:]`).test(src));
}
check("storage.from(bucket) entry point exists", /from:\s*\(bucket/.test(src));

console.log("\nbehaviours callers depend on");
check("upsert:false maps to If-None-Match (S3 collision)",
      src.includes('"if-none-match": "*"'));
check('412 is reported as "Duplicate" (callers branch on that word)',
      /Duplicate: object already exists/.test(src));
check("download() returns a Blob, as supabase-js does",
      /new Blob\(\[buf\]\)/.test(src));
check("remove() treats 404 as success (already gone)",
      /status === 404/.test(src));
check("list() is IMPLEMENTED (lead-documents uses it as an anti-spoof size check)",
      /list-type.*2/.test(src) && /<Contents>/.test(src));
check("list() is non-recursive, matching supabase-js",
      /name\.includes\("\/"\)/.test(src));
check("list() honours the search filter",
      /opts\?\.search/.test(src));
check("errors are returned, never thrown ({data,error} shape)",
      /const fail = \(message/.test(src) && /data: null/.test(src));

console.log("\nSigV4 — AWS published 'get-vanilla' vector");
const sha256Hex = (d) => createHash("sha256").update(d).digest("hex");
const hmac = (k, d) => createHmac("sha256", k).update(d, "utf8").digest();
const signingKey = (secret, date, region, service) =>
    hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request");

const AMZ = "20150830T123600Z", DATE = "20150830";
const canonicalRequest = [
    "GET", "/", "", `host:example.amazonaws.com\nx-amz-date:${AMZ}\n`,
    "host;x-amz-date", sha256Hex(""),
].join("\n");
const stringToSign = [
    "AWS4-HMAC-SHA256", AMZ, `${DATE}/us-east-1/service/aws4_request`,
    sha256Hex(canonicalRequest),
].join("\n");
const signature = createHmac(
    "sha256",
    signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", DATE, "us-east-1", "service"),
).update(stringToSign, "utf8").digest("hex");
check("signature matches AWS's published value",
      signature === "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");

// The test re-implements the primitives (the module is TS + "server-only"), so
// assert the real file still uses the same construction — otherwise a passing
// test would prove nothing about the code that actually runs.
console.log("\nimplementation has not drifted from what this test verifies");
for (const frag of [
    'hmac(hmac(hmac(hmac(`AWS4${secret}`, date), REGION), SERVICE), "aws4_request")',
    '"UNSIGNED-PAYLOAD"',
    '"X-Amz-Algorithm": "AWS4-HMAC-SHA256"',
    'createHash("sha256").update(d).digest("hex")',
]) {
    check(`r2-storage.ts contains: ${frag.slice(0, 46)}`, src.includes(frag));
}

console.log("\nkey convention matches the migration uploader");
check("bucket name becomes the R2 key prefix",
      /return `\$\{bucket\}\/\$\{path\.replace/.test(src));

// This exact adapter is copied into nostalgic-requests and realestate-App —
// separate repos with no shared package. Copying is defensible; silently
// diverging is not, and it already happened once: list() was implemented here
// only, leaving those two REFUSING a call that lead-documents makes as an
// anti-spoof size check. Fail loudly on drift.
console.log("\ncopies in sibling repos are byte-identical");
const mine = createHash("sha256").update(src).digest("hex");
for (const other of [
    "C:/Users/User/APPS/nostalgic-requests/lib/r2-storage.ts",
    "C:/Users/User/realestate-App/src/lib/supabase/r2-storage.ts",
]) {
    const label = other.split("/").slice(-3).join("/");
    let theirs = null;
    try {
        theirs = createHash("sha256").update(readFileSync(other, "utf8")).digest("hex");
    } catch {
        check(`present: ${label}`, false, "file missing");
        continue;
    }
    check(`byte-identical: ${label}`, theirs === mine,
          theirs === mine ? "" : `${theirs.slice(0, 12)} vs ${mine.slice(0, 12)}`);
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
