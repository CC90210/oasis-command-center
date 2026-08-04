/**
 * watermark-copy-path.test.ts — the watermarked DERIVED copy must be stored
 * under a key whose extension matches the bytes inside it, and pre-existing
 * mismatched copies must be REBUILT rather than re-sent.
 *
 * Background: until 2026-08-03 every shop-out watermark copy was written to
 * `_shopout_wm/{id}_v{n}.pdf` regardless of what the watermarker produced. A
 * photographed statement (merchants send JPEG/HEIC constantly) therefore ended
 * up as a `.pdf` object holding JPEG bytes, and the lender received a "PDF"
 * their reader refused to open.
 *
 * Fixing the write alone is not enough: copies branded before the fix carry no
 * `shopout_wm_mime`, so a reuse check that assumes "no recorded mime means PDF"
 * would keep serving exactly the broken objects the fix exists to repair. The
 * expected mime is inferred from the SOURCE instead, which rebuilds only the
 * broken ones and leaves healthy PDF copies alone.
 */
import assert from "node:assert";
import {
  WATERMARK_VERSION,
  expectedWmMimeForSource,
  retargetFilename,
  wmCopyExtension,
} from "../lib/lead-documents";

const wmDir = `tenant-a/lead-b/_shopout_wm/doc-c_v${WATERMARK_VERSION}`;

/**
 * The reuse predicate from getOrCreateWatermarkedCopy: a recorded copy is
 * reusable only when its key matches the extension its mime implies. Mirrored
 * here so the decision is asserted directly, without a live Supabase.
 */
function isReusable(args: {
  recordedPath: string | null;
  recordedMime: string | null;
  sourceMime: string | null;
  recordedVersion: number;
}): boolean {
  const mime = args.recordedMime ?? expectedWmMimeForSource(args.sourceMime);
  return (
    !!args.recordedPath &&
    args.recordedPath === `${wmDir}.${wmCopyExtension(mime)}` &&
    args.recordedVersion === WATERMARK_VERSION
  );
}

let failures = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}: ${e instanceof Error ? e.message : e}`);
  }
};

// ── Output-mime mapping mirrors lib/forms/watermark.ts's format policy.
check("PDF source stays PDF", () =>
  assert.equal(expectedWmMimeForSource("application/pdf"), "application/pdf"),
);
check("PNG is preserved", () => assert.equal(expectedWmMimeForSource("image/png"), "image/png"));
check("WebP is preserved", () => assert.equal(expectedWmMimeForSource("image/webp"), "image/webp"));
check("JPEG stays JPEG", () => assert.equal(expectedWmMimeForSource("image/jpeg"), "image/jpeg"));
check("HEIC flattens to JPEG", () =>
  assert.equal(expectedWmMimeForSource("image/heic"), "image/jpeg"),
);
check("GIF flattens to JPEG", () => assert.equal(expectedWmMimeForSource("image/gif"), "image/jpeg"));
check("a charset parameter does not defeat the match", () =>
  assert.equal(expectedWmMimeForSource("image/png; charset=binary"), "image/png"),
);
check("unknown/missing source falls back to PDF", () => {
  assert.equal(expectedWmMimeForSource(null), "application/pdf");
  assert.equal(expectedWmMimeForSource("application/octet-stream"), "application/pdf");
});

// ── Extensions.
check("extensions follow the produced mime", () => {
  assert.equal(wmCopyExtension("application/pdf"), "pdf");
  assert.equal(wmCopyExtension("image/jpeg"), "jpg");
  assert.equal(wmCopyExtension("image/jpg"), "jpg");
  assert.equal(wmCopyExtension("image/png"), "png");
  assert.equal(wmCopyExtension("image/webp"), "webp");
});

// ── LEGACY REPAIR — the case the fix exists for.
check("legacy PDF copy (no recorded mime) is reused, not needlessly rebuilt", () =>
  assert.equal(
    isReusable({
      recordedPath: `${wmDir}.pdf`,
      recordedMime: null,
      sourceMime: "application/pdf",
      recordedVersion: WATERMARK_VERSION,
    }),
    true,
  ),
);

check("legacy JPEG copy stored as .pdf IS REBUILT", () =>
  assert.equal(
    isReusable({
      recordedPath: `${wmDir}.pdf`, // written by the pre-fix code
      recordedMime: null, // shopout_wm_mime did not exist yet
      sourceMime: "image/jpeg",
      recordedVersion: WATERMARK_VERSION,
    }),
    false,
  ),
);

check("legacy HEIC copy stored as .pdf IS REBUILT", () =>
  assert.equal(
    isReusable({
      recordedPath: `${wmDir}.pdf`,
      recordedMime: null,
      sourceMime: "image/heic",
      recordedVersion: WATERMARK_VERSION,
    }),
    false,
  ),
);

check("legacy PNG copy stored as .pdf IS REBUILT", () =>
  assert.equal(
    isReusable({
      recordedPath: `${wmDir}.pdf`,
      recordedMime: null,
      sourceMime: "image/png",
      recordedVersion: WATERMARK_VERSION,
    }),
    false,
  ),
);

// ── Post-fix copies round-trip.
check("a correctly-keyed image copy is reused", () =>
  assert.equal(
    isReusable({
      recordedPath: `${wmDir}.jpg`,
      recordedMime: "image/jpeg",
      sourceMime: "image/heic",
      recordedVersion: WATERMARK_VERSION,
    }),
    true,
  ),
);

check("a stale watermark VERSION is still rebuilt", () =>
  assert.equal(
    isReusable({
      recordedPath: `${wmDir}.pdf`,
      recordedMime: "application/pdf",
      sourceMime: "application/pdf",
      recordedVersion: WATERMARK_VERSION - 1,
    }),
    false,
  ),
);

check("no recorded copy is never reusable", () =>
  assert.equal(
    isReusable({
      recordedPath: null,
      recordedMime: null,
      sourceMime: "application/pdf",
      recordedVersion: WATERMARK_VERSION,
    }),
    false,
  ),
);

// ── Outbound filename tracks the branded copy.
check("filenames are retargeted to the branded extension", () => {
  assert.equal(retargetFilename("March Statement.heic", "jpg"), "March Statement.jpg");
  assert.equal(retargetFilename("statement.pdf", "pdf"), "statement.pdf");
  // No extension to replace — one is appended rather than mangling the name.
  assert.equal(retargetFilename("statement", "jpg"), "statement.jpg");
  // A dotted business name must not be mistaken for an extension boundary.
  assert.equal(retargetFilename("Acme Inc. Jan.png", "png"), "Acme Inc. Jan.png");
});

console.log(failures === 0 ? "\nALL WATERMARK COPY-PATH TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
