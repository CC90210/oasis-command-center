/**
 * video-picker-upload-safety.test.ts - three CodeRabbit findings on PR #597's
 * VideoPicker upload flow (components/offer-pages/builder/VideoPicker.tsx):
 *
 *   1. The size-limit error message DERIVES from MAX_UPLOAD_BYTES through the
 *      one shared formatBytes(), so it can never disagree with the real cap -
 *      the ad hoc `Math.round(cap / 1MB) || 1` this replaced silently rounded
 *      any cap under 0.5 MB up to a lying "1 MB".
 *   2. clientUploadError's type check is Object.hasOwn-based
 *      (isAllowedUploadMime), never a bare `mime in UPLOAD_MIME[kind]`: a
 *      crafted file.type of "constructor" or "__proto__" is refused, not
 *      waved through via the prototype chain.
 *   3. A stale in-flight upload/confirm must never land after Cancel or
 *      after choosing a different video: pickUpload stamps every attempt
 *      with a number and wraps its request in an AbortController, both
 *      checked/fired by invalidatePendingUpload() - called from the X
 *      (Cancel), Replace, and the "paste a link" / "choose from Library"
 *      buttons. This file drives (1) and (2) directly, by importing and
 *      calling the real functions with a real File; (3) requires real
 *      interactive timing (two overlapping async attempts, a click in
 *      between) this repo's render-child-process harness cannot drive, so it
 *      is pinned at the source level instead, the same way
 *      tests/video-picker-ids.test.ts already pins its own fix - every
 *      mechanism the behaviour depends on must be present, by name, in the
 *      real file.
 *
 * Run: node --conditions=react-server --import tsx tests/video-picker-upload-safety.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const SRC_PATH = join(ROOT, "components", "offer-pages", "builder", "VideoPicker.tsx");

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
  }
}

async function main() {
  console.log("video-picker-upload-safety:");
  const { clientUploadError, formatBytes } = await import("../components/offer-pages/builder/VideoPicker");
  const { MAX_UPLOAD_BYTES } = await import("../lib/offer-pages/types");

  check("formatBytes derives the size-limit message, never a fixed-point rounding that can disagree with the real cap", () => {
    assert.equal(formatBytes(MAX_UPLOAD_BYTES.video), "500.0 MB");
    assert.equal(formatBytes(MAX_UPLOAD_BYTES.caption), "512 KB", "the caption cap (0.5 MB) must read as 512 KB, never a rounded-up '1 MB'");
    assert.equal(formatBytes(100 * 1024), "100 KB", "a cap under 0.5 MB must never be rounded up to '1 MB'");
  });

  check("a video file over the cap names the SAME number formatBytes(MAX_UPLOAD_BYTES.video) gives - the message cannot drift from the real cap", () => {
    const tooBig = new File([new Uint8Array(10)], "big.mp4", { type: "video/mp4" });
    Object.defineProperty(tooBig, "size", { value: MAX_UPLOAD_BYTES.video + 1 });
    const message = clientUploadError("video", tooBig);
    assert.ok(message, "a file over the cap was not refused");
    assert.equal(message, `That file is larger than ${formatBytes(MAX_UPLOAD_BYTES.video)}.`);
  });

  check("a within-cap, allowed-type file is accepted (the happy path the size/type checks must not also break)", () => {
    const ok = new File([new Uint8Array(10)], "ok.mp4", { type: "video/mp4" });
    assert.equal(clientUploadError("video", ok), null);
  });

  check("a crafted file.type of 'constructor' or '__proto__' is refused, not waved through via the prototype chain (CodeRabbit, PR #597)", () => {
    for (const type of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const crafted = new File([new Uint8Array(10)], "x", { type });
      assert.equal(clientUploadError("video", crafted), "Only MP4, WebM or MOV.", `file.type ${type}`);
    }
  });

  // -- source-level pins for the stale-upload fix (no real browser here) --
  const src = readFileSync(SRC_PATH, "utf8");

  check("every pickUpload attempt is stamped with a per-attempt number AND wrapped in an AbortController", () => {
    assert.match(src, /const uploadAttempt = useRef\(0\)/, "no per-attempt counter");
    assert.match(src, /const uploadAbort = useRef<AbortController \| null>\(null\)/, "no AbortController ref");
    assert.match(src, /uploadAttempt\.current \+= 1;\s*\n\s*const myAttempt = uploadAttempt\.current;/, "pickUpload does not stamp its own attempt number");
    assert.match(src, /const controller = new AbortController\(\);/, "pickUpload does not create a fresh AbortController per attempt");
    assert.match(src, /uploadOne\(formId, kind, file, kind === "video" \? setUploadPct : \(\) => undefined, controller\.signal\)/, "pickUpload does not pass the controller's signal into uploadOne");
  });

  check("a settled result is discarded, never applied, once superseded", () => {
    assert.match(src, /if \(myAttempt !== uploadAttempt\.current\) return; \/\/ superseded while this was in flight: discard, never apply/, "the resolved branch does not check staleness before onDone");
    assert.match(src, /if \(myAttempt !== uploadAttempt\.current\) return; \/\/ a superseded attempt's own failure/, "the rejected branch does not check staleness before setError");
  });

  check("invalidatePendingUpload() bumps the attempt counter AND aborts the in-flight request", () => {
    assert.match(src, /function invalidatePendingUpload\(\)\s*\{\s*uploadAttempt\.current \+= 1;\s*uploadAbort\.current\?\.abort\(\);/, "invalidatePendingUpload does not both bump and abort");
  });

  check("Cancel (the X), Replace, and the other two source buttons all invalidate a pending upload before switching away", () => {
    assert.match(src, /setMode\("idle"\); setCandidate\(null\); setError\(null\); resetUpload\(\);/, "the X button no longer resets upload state");
    assert.match(src, /function resetUpload\(\)\s*\{\s*invalidatePendingUpload\(\);/, "resetUpload (called by the X) does not invalidate");
    assert.match(src, /invalidatePendingUpload\(\); setVideoUpload\(null\); \}\}>Replace/, "Replace does not invalidate before clearing the video");
    assert.match(src, /invalidatePendingUpload\(\); setMode\("link"\); \}\}/, "'Paste a link' does not invalidate before switching away from upload mode");
    assert.match(src, /invalidatePendingUpload\(\); void openLibrary\(\); \}\}/, "'Choose from Library' does not invalidate before switching away from upload mode");
  });

  check("putWithProgress and uploadOne both take a signal and actually use it (fetch's own signal option, plus a manual XHR abort wire-up)", () => {
    assert.match(src, /function putWithProgress\(url: string, file: File, contentType: string, onProgress: \(pct: number\) => void, signal: AbortSignal\)/, "putWithProgress does not accept a signal");
    assert.match(src, /signal\.addEventListener\("abort", onAbort/, "putWithProgress does not wire the signal into an XHR abort");
    assert.match(src, /async function uploadOne\(formId: string, kind: UploadKind, file: File, onProgress: \(pct: number\) => void, signal: AbortSignal\)/, "uploadOne does not accept a signal");
    assert.equal((src.match(/,\s*\n\s*signal,\s*\n\s*\}\);/g) ?? []).length, 2, "uploadOne's two fetch() calls do not both pass {signal}");
  });

  if (failures) {
    console.log(`video-picker-upload-safety: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("video-picker-upload-safety: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
