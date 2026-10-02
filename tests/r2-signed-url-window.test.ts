/**
 * A signed media URL is ONE URL per object for a whole window, and still lives
 * at least as long as the caller asked.
 * Run: node --conditions=react-server --import tsx tests/r2-signed-url-window.test.ts
 *
 * WHY THIS EXISTS
 * lib/r2-storage.ts stamped every presigned URL with the current second, so a
 * server render produced new media URLs every time and the browser cache (keyed
 * by URL) never hit. In the Library every Approve or Archive (router.refresh),
 * the Phone / Grid toggle and each preview toggle re-downloaded every cover on
 * the page and reset a playing video.
 *
 * WHAT IS PINNED
 *  1. Within a window, the same object signs to the same URL (single and batch).
 *  2. The next window signs a new URL.
 *  3. X-Amz-Date is the start of the window and X-Amz-Expires is the lifetime
 *     plus the window, so from any moment it is handed out the URL lives at
 *     least the lifetime asked for and at most twice it.
 *  4. The window scales with the lifetime: a 60-second URL is never good for an
 *     hour. Upload (PUT) URLs and week-long URLs are not windowed.
 *  5. Every URL carries a valid SigV4 signature for the time it claims, checked
 *     by an independent re-implementation of the presign below - a window
 *     stamped in the query but not in the signature would be refused by R2.
 *
 * The R2_* values are test placeholders, not credentials.
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import { r2StorageSurface } from "../lib/r2-storage";

// Read by the adapter at signing time, not at import.
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

const HOUR = 3600 * 1000;
/** 2026-10-01T14:00:00Z, on an hour boundary. */
const T0 = Date.UTC(2026, 9, 1, 14, 0, 0);
const PATH = "tenant-a/asset-1/poster.jpg";
const media = () => r2StorageSurface().from("marketing-media");

/**
 * Run one signing call with the clock at `ms`. The adapter's methods are async
 * but sign before their first await, so the clock is read inside call().
 */
function at<T>(ms: number, call: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return call();
  } finally {
    Date.now = real;
  }
}

async function signedAt(ms: number, expiresIn: number): Promise<string> {
  const r = await at(ms, () => media().createSignedUrl(PATH, expiresIn));
  assert.equal(r.error, null);
  return r.data!.signedUrl;
}

/** X-Amz-Date (20261001T140000Z) as epoch ms. */
function amzMs(amz: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amz);
  assert.ok(m, `X-Amz-Date ${amz}`);
  return Date.UTC(+m![1], +m![2] - 1, +m![3], +m![4], +m![5], +m![6]);
}

function parts(url: string) {
  const u = new URL(url);
  const date = u.searchParams.get("X-Amz-Date")!;
  const expires = Number(u.searchParams.get("X-Amz-Expires"));
  return { u, signedAt: amzMs(date), expires, validUntil: amzMs(date) + expires * 1000 };
}

/** SigV4 query presign, written from the AWS spec rather than copied from the module. */
function expectedSignature(url: string, method: "GET" | "PUT"): string {
  const u = new URL(url);
  const rfc3986 = (s: string) =>
    encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const query = [...u.searchParams.entries()]
    .filter(([k]) => k !== "X-Amz-Signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");
  const amz = u.searchParams.get("X-Amz-Date")!;
  const credential = u.searchParams.get("X-Amz-Credential")!;
  const scope = credential.split("/").slice(1).join("/");
  const day = scope.split("/")[0];
  assert.equal(day, amz.slice(0, 8), "the credential scope is dated the day the URL was signed");
  const canonical = [method, u.pathname, query, `host:${u.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amz, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const h = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d, "utf8").digest();
  const key = h(h(h(h("AWS4test-secret", day), "auto"), "s3"), "aws4_request");
  return createHmac("sha256", key).update(toSign, "utf8").digest("hex");
}

async function main() {
  console.log("r2-signed-url-window");

  await check("one object signs to ONE URL for the whole window (single and batch)", async () => {
    const first = await signedAt(T0 + 5_000, 3600);
    for (const offset of [20 * 60_000, 45 * 60_000 + 7_000, HOUR - 1_000]) {
      assert.equal(await signedAt(T0 + offset, 3600), first, `re-signed ${offset / 1000}s into the window`);
    }
    const batch = await at(T0 + 30 * 60_000, () => media().createSignedUrls([PATH], 3600));
    assert.equal(batch.error, null);
    assert.equal(batch.data![0].signedUrl, first, "the Library's batch signer hands out the same URL");
  });

  await check("the next window signs a new URL", async () => {
    const a = await signedAt(T0 + HOUR - 1_000, 3600);
    const b = await signedAt(T0 + HOUR, 3600);
    assert.notEqual(a, b);
    assert.equal(parts(b).signedAt, T0 + HOUR, "signed at the start of the new window");
  });

  await check("signed at the window's start, alive for the lifetime asked for (at most twice it)", async () => {
    for (let offset = 0; offset < HOUR; offset += 7 * 60_000 + 13_000) {
      const now = T0 + offset;
      const p = parts(await signedAt(now, 3600));
      assert.equal(p.signedAt, T0, `X-Amz-Date at ${offset / 1000}s`);
      assert.equal(p.expires, 7200, "X-Amz-Expires = lifetime + window");
      assert.ok(p.validUntil >= now + 3600 * 1000, `valid for less than an hour from ${offset / 1000}s`);
      assert.ok(p.validUntil <= now + 2 * 3600 * 1000, `valid for more than two hours from ${offset / 1000}s`);
    }
  });

  await check("a short-lived URL stays short-lived: a 60-second link is never good for an hour", async () => {
    const now = T0 + 59_000;
    const p = parts(await signedAt(now, 60));
    assert.equal(p.signedAt, T0, "a 60-second window");
    assert.equal(p.expires, 120);
    assert.ok(p.validUntil >= now + 60_000 && p.validUntil <= now + 120_000);
    assert.equal(await signedAt(T0 + 1_000, 60), await signedAt(T0 + 58_000, 60), "and stable within it");
  });

  await check("upload URLs and week-long URLs are signed for now, exactly", async () => {
    const now = T0 + 1_234_000;
    const up = await at(now, () => media().createSignedUploadUrl(PATH));
    assert.equal(up.error, null);
    const pu = parts(up.data!.signedUrl);
    assert.equal(pu.signedAt, now, "an upload URL is stamped to the second");
    assert.equal(pu.expires, 900, "with exactly its own lifetime");
    const week = parts(await signedAt(now, 7 * 24 * 3600));
    assert.equal(week.signedAt, now, "a week-long URL has no room for a window");
    assert.equal(week.expires, 7 * 24 * 3600, "and never claims more than SigV4 allows");
  });

  await check("every URL carries a valid SigV4 signature for the time it claims", async () => {
    const urls: Array<[string, "GET" | "PUT"]> = [
      [await signedAt(T0 + 17 * 60_000, 3600), "GET"],
      [await signedAt(T0 + 59_000, 60), "GET"],
      [await signedAt(T0 + 3 * HOUR + 5_000, 300), "GET"],
      [(await at(T0 + 42_000, () => media().createSignedUploadUrl(PATH))).data!.signedUrl, "PUT"],
    ];
    for (const [url, method] of urls) {
      const sig = new URL(url).searchParams.get("X-Amz-Signature");
      assert.equal(sig, expectedSignature(url, method), `${method} ${url.slice(0, 120)}`);
    }
  });

  console.log(`\nr2-signed-url-window: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
