/**
 * The Library's Download button: which file, under what name, and a signed URL
 * that makes the browser SAVE it.
 * Run: node --conditions=react-server --import tsx tests/library-download.test.ts
 *
 * WHY THIS EXISTS
 * CC, 2026-10-16: "I want to be able to download the actual videos to my computer
 * ... all the videos in the library section in content." Every URL the Library
 * signed was for inline playback, so there was no way to save an original.
 *
 * WHAT IS PINNED
 *  1. lib/r2-storage: a signed URL with no `download` option is byte-for-byte the
 *     URL it always was (lib/r2-storage is a security boundary shared by every
 *     bucket; this change must not move a single existing link).
 *  2. With `download`, the URL carries response-content-disposition=attachment
 *     with a sanitised filename, INSIDE a valid SigV4 signature (checked by an
 *     independent implementation, so a parameter appended after signing fails).
 *  3. pickDownloadMedia: the video beats its poster; a carousel slide follows
 *     media_urls order, not row order; a missing slide is null, not slide 1.
 *  4. downloadFilename: readable, ASCII, keeps the real extension.
 *
 * The R2_* values are test placeholders, not credentials.
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import { downloadDisposition, r2StorageSurface } from "../lib/r2-storage";
import {
  assetDownloadHref,
  downloadFailureHref,
  downloadFailureLine,
  downloadFilename,
  pickDownloadMedia,
  type DownloadMediaRow,
} from "../lib/founders/asset-download";

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

const T0 = Date.UTC(2026, 9, 16, 9, 0, 0);
function at<T>(ms: number, call: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return call();
  } finally {
    Date.now = real;
  }
}
const media = () => r2StorageSurface().from("marketing-media");
const PATH = "tenant-a/asset-1/1786_abc_pillar-fleet.mp4";

/** SigV4 query presign, written from the AWS spec rather than copied from the module. */
function expectedSignature(url: string): string {
  const u = new URL(url);
  const rfc3986 = (s: string) =>
    encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const query = [...u.searchParams.entries()]
    .filter(([k]) => k !== "X-Amz-Signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");
  const amz = u.searchParams.get("X-Amz-Date")!;
  const scope = u.searchParams.get("X-Amz-Credential")!.split("/").slice(1).join("/");
  const day = scope.split("/")[0];
  const canonical = ["GET", u.pathname, query, `host:${u.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amz, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const h = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d, "utf8").digest();
  const key = h(h(h(h("AWS4test-secret", day), "auto"), "s3"), "aws4_request");
  return createHmac("sha256", key).update(toSign, "utf8").digest("hex");
}

const VIDEO: DownloadMediaRow = { kind: "video", storage_bucket: "marketing-media", storage_path: "t/a/1_v.mp4" };
const POSTER: DownloadMediaRow = { kind: "poster", storage_bucket: "marketing-media", storage_path: "t/a/2_p.png" };
const S1: DownloadMediaRow = { kind: "image", storage_bucket: "marketing-media", storage_path: "t/a/9_s1.png" };
const S2: DownloadMediaRow = { kind: "image", storage_bucket: "marketing-media", storage_path: "t/a/3_s2.png" };
const S3: DownloadMediaRow = { kind: "image", storage_bucket: "marketing-media", storage_path: "t/a/5_s3.png" };

async function main() {
  console.log("library-download");

  await check("no download option: the signed URL is unchanged", async () => {
    const plain = await at(T0, () => media().createSignedUrl(PATH, 3600));
    const none = await at(T0, () => media().createSignedUrl(PATH, 3600, {}));
    const falsy = await at(T0, () => media().createSignedUrl(PATH, 3600, { download: false }));
    assert.equal(none.data!.signedUrl, plain.data!.signedUrl);
    assert.equal(falsy.data!.signedUrl, plain.data!.signedUrl);
    assert.ok(!plain.data!.signedUrl.includes("response-content-disposition"));
    assert.equal(new URL(plain.data!.signedUrl).searchParams.get("X-Amz-Signature"), expectedSignature(plain.data!.signedUrl));
  });

  await check("download: attachment with the filename, inside a valid signature", async () => {
    const r = await at(T0, () => media().createSignedUrl(PATH, 300, { download: "OASIS-FLEET-VSL.mp4" }));
    assert.equal(r.error, null);
    const u = new URL(r.data!.signedUrl);
    assert.equal(u.searchParams.get("response-content-disposition"), 'attachment; filename="OASIS-FLEET-VSL.mp4"');
    assert.equal(u.searchParams.get("X-Amz-Signature"), expectedSignature(r.data!.signedUrl));
  });

  await check("download: true saves under the object's own name", async () => {
    assert.deepEqual(downloadDisposition(true), { "response-content-disposition": "attachment" });
    assert.deepEqual(downloadDisposition(undefined), {});
  });

  await check("a filename cannot break out of its quotes", async () => {
    const d = downloadDisposition('evil"; filename=x.exe; (a)*!.mp4')["response-content-disposition"];
    assert.equal(d, 'attachment; filename="evil filenamex.exe a.mp4"');
    const r = await at(T0, () => media().createSignedUrl(PATH, 300, { download: "it's (v2)!.mp4" }));
    assert.equal(new URL(r.data!.signedUrl).searchParams.get("X-Amz-Signature"), expectedSignature(r.data!.signedUrl));
  });

  await check("the video is the download, never its poster", () => {
    assert.equal(pickDownloadMedia([POSTER, VIDEO], ["t/a/1_v.mp4"]), VIDEO);
  });

  await check("carousel slides follow media_urls order, not row order", () => {
    const rows = [S2, S3, S1];
    const order = JSON.stringify([S1.storage_path, S2.storage_path, S3.storage_path]);
    assert.equal(pickDownloadMedia(rows, order), S1, "no slide asked = the cover (slide 1)");
    assert.equal(pickDownloadMedia(rows, order, 2), S2);
    assert.equal(pickDownloadMedia(rows, order, 3), S3);
    assert.equal(pickDownloadMedia(rows, order, 4), null, "a slide that does not exist is not slide 1");
    assert.equal(pickDownloadMedia(rows, order, 0), null);
    assert.equal(pickDownloadMedia(rows, order, 1.5), null);
  });

  await check("nothing attached is null", () => {
    assert.equal(pickDownloadMedia([], null), null);
  });

  await check("filenames are readable ASCII with the real extension", () => {
    assert.equal(
      downloadFilename("OASIS FLEET VSL (16:9, George) - A tool waits", "t/a/1786_x_pillar-fleet.mp4"),
      "OASIS-FLEET-VSL-169-George-A-tool-waits.mp4",
    );
    assert.equal(downloadFilename("Deck", "t/a/9_s1.PNG", 2), "Deck-slide-2.png");
    assert.equal(downloadFilename("", "t/a/x.mp4"), "oasis-asset.mp4");
    assert.equal(downloadFilename(null, "t/a/noext"), "oasis-asset.bin");
  });

  await check("the href is the download route", () => {
    assert.equal(assetDownloadHref("abc"), "/api/founders/marketing/assets/abc/download");
    assert.equal(assetDownloadHref("abc", 3), "/api/founders/marketing/assets/abc/download?slide=3");
  });

  // A failed Download goes back to the Content page it was pressed on (2026-10-26):
  // a plain link that answered JSON replaced the page with {"ok":false,...}.
  await check("a failed download goes back to the Content page it came from, and only to one", () => {
    const route = "https://oasisai.work/api/founders/marketing/assets/abc/download";
    assert.equal(
      downloadFailureHref("https://oasisai.work/founders/marketing/library?group=clients&page=2", route, "sign_failed"),
      "/founders/marketing/library?group=clients&page=2&download=sign_failed",
      "its own path and query, the reason added",
    );
    assert.equal(
      downloadFailureHref("https://oasisai.work/founders/marketing/extracted?download=not_found#video-1", route, "no_media_attached"),
      "/founders/marketing/extracted?download=no_media_attached",
      "an older reason is replaced, and the hash is dropped",
    );
    assert.equal(downloadFailureHref("https://oasisai.work/founders/marketing", route, "read_failed"), "/founders/marketing?download=read_failed");
    assert.equal(downloadFailureHref(null, route, "sign_failed"), null, "no Referer: JSON, as before");
    assert.equal(downloadFailureHref("https://evil.example/founders/marketing/library", route, "sign_failed"), null, "another site: never");
    assert.equal(downloadFailureHref("https://oasisai.work/pipeline", route, "sign_failed"), null, "not a Content page");
    assert.equal(downloadFailureHref("https://oasisai.work/founders/marketingx", route, "sign_failed"), null, "a path boundary, not a prefix");
    assert.equal(downloadFailureHref("not a url", route, "sign_failed"), null);
  });

  await check("each reason reads as a sentence; anything else shows nothing", () => {
    for (const code of ["no_media_attached", "no_such_slide", "sign_failed", "read_failed", "not_found"]) {
      const line = downloadFailureLine(code);
      assert.ok(line && /^[A-Z].*\.$/.test(line) && !line.includes("_"), `${code}: ${line}`);
    }
    for (const junk of [undefined, null, "", "toString", "__proto__", "<script>", 7]) assert.equal(downloadFailureLine(junk), null, String(junk));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
