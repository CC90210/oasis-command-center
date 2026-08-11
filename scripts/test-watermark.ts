/**
 * Runtime test for lib/forms/watermark.ts — proves the PDF flatten path
 * (pdfjs-dist + @napi-rs/canvas + pdf-lib) and the image path (sharp + canvas)
 * produce valid, branded output. Writes a sample PDF for visual inspection.
 *   node --conditions=react-server --import tsx scripts/test-watermark.ts
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { watermarkBankStatement } from "../lib/forms/watermark";

const PDF_MAGIC = Buffer.from("%PDF");
const JPG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const isPdf = (b: Buffer) => b.subarray(0, 4).equals(PDF_MAGIC);
const isJpg = (b: Buffer) => b.subarray(0, 3).equals(JPG_MAGIC);
const isPng = (b: Buffer) => b.subarray(0, 4).equals(PNG_MAGIC);

// Default to the OS temp dir — the previous default was one developer's
// absolute macOS scratchpad, so the sample write silently failed everywhere
// else.
const SAMPLE_OUT =
  process.env.WM_SAMPLE_OUT || join(tmpdir(), "watermarked-sample.pdf");

async function main() {
  let failures = 0;
  const prov = {
    businessName: "Zason Latino Mexican Grill LLC",
    leadId: "31fafb4f-b432-4619-831d-ab12efab9d31",
    date: "2026-06-28",
  };

  // 1) PDF path — synth a 2-page statement-ish PDF, watermark, assert valid +
  //    reloadable + page count preserved.
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const p = src.addPage([612, 792]);
    p.drawText(`FIRST NATIONAL BANK — Statement page ${i + 1}`, { x: 50, y: 740, size: 14, font, color: rgb(0, 0, 0) });
    p.drawText("Beginning balance 4,210.55", { x: 50, y: 705, size: 10, font });
    p.drawText("Total deposits 38,902.14   Total withdrawals 31,884.00   NSF 0", { x: 50, y: 685, size: 10, font });
    p.drawText("Ending balance 11,228.69", { x: 50, y: 665, size: 10, font });
  }
  const srcPdf = Buffer.from(await src.save());
  const wmPdf = await watermarkBankStatement({ bytes: srcPdf, mimeType: "application/pdf", provenance: prov });
  if (wmPdf.ok && isPdf(wmPdf.bytes)) {
    const reload = await PDFDocument.load(wmPdf.bytes);
    const okPages = reload.getPageCount() === 2;
    console.log(`ok PDF -> watermarked PDF ${wmPdf.bytes.length} bytes, ${reload.getPageCount()} pages${okPages ? "" : " (PAGE COUNT MISMATCH!)"}`);
    if (!okPages) failures++;
    try {
      writeFileSync(SAMPLE_OUT, wmPdf.bytes);
      console.log(`   sample written -> ${SAMPLE_OUT}`);
    } catch (e) {
      console.log("   (could not write sample:", e instanceof Error ? e.message : e, ")");
    }
  } else {
    console.error("FAIL PDF:", wmPdf);
    failures++;
  }

  // 2) PNG image stays PNG.
  const sharp = (await import("sharp")).default;
  const png = await sharp({ create: { width: 1200, height: 1600, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  const wmPng = await watermarkBankStatement({ bytes: png, mimeType: "image/png", provenance: prov });
  if (wmPng.ok && isPng(wmPng.bytes) && wmPng.mimeType === "image/png") {
    console.log(`ok IMAGE(png) -> ${wmPng.bytes.length} bytes`);
  } else {
    console.error("FAIL IMAGE png:", wmPng);
    failures++;
  }

  // 3) JPEG image stays JPEG.
  const jpg = await sharp({ create: { width: 1000, height: 1400, channels: 3, background: { r: 255, g: 255, b: 255 } } }).jpeg().toBuffer();
  const wmJpg = await watermarkBankStatement({ bytes: jpg, mimeType: "image/jpeg", provenance: prov });
  if (wmJpg.ok && isJpg(wmJpg.bytes) && wmJpg.mimeType === "image/jpeg") {
    console.log(`ok IMAGE(jpeg) -> ${wmJpg.bytes.length} bytes`);
  } else {
    console.error("FAIL IMAGE jpeg:", wmJpg);
    failures++;
  }

  // 4) Unsupported type is rejected (never throws).
  const bad = await watermarkBankStatement({ bytes: Buffer.from("hello"), mimeType: "text/plain", provenance: prov });
  if (!bad.ok) console.log("ok unsupported type rejected:", bad.error);
  else {
    console.error("FAIL: unsupported type accepted");
    failures++;
  }

  const mkPages = async (n: number) => {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < n; i++) {
      const p = d.addPage([612, 792]);
      p.drawText(`page ${i + 1}`, { x: 50, y: 740, size: 12, font: f });
    }
    return Buffer.from(await d.save());
  };

  // 5) A LONG BUT ORDINARY statement must BRAND, not be refused.
  //
  //    This is the regression that took shop-out down for real deals. The page
  //    cap was ONE constant (50) applied to BOTH render paths, but the paths
  //    cost ~80x different per page: measured 2026-08-07, the pdf-lib overlay
  //    does 400 pages in 858ms, while the pdfjs raster path runs ~165ms/page on
  //    real scanned statements. The cap was sized for raster and silently
  //    imposed on overlay too.
  //
  //    Measured against production (tenant `submissions`, 150 largest
  //    statements): p50 13 pages, p90 30, p99 47, max 59 — the cap sat INSIDE
  //    the live distribution. Two statements (59pp and 53pp) were refused, and
  //    both were unencrypted, i.e. pdf-lib could have branded them in ~200ms.
  //    Because shop-out refuses the WHOLE send when any statement fails, each
  //    one blocked an entire deal on every retry.
  const wm55 = await watermarkBankStatement({
    bytes: await mkPages(55),
    mimeType: "application/pdf",
    provenance: prov,
  });
  if (wm55.ok && wm55.pages === 55 && !wm55.raster && isPdf(wm55.bytes)) {
    console.log(`ok 55-page statement brands losslessly (${wm55.pages} pages, overlay)`);
  } else {
    console.error("FAIL: an ordinary 55-page statement was not branded via the overlay:", wm55);
    failures++;
  }

  // 5b) Genuinely absurd page counts STILL fail closed — never truncate. The
  //     result overwrites the stored object, so emitting only the first N pages
  //     would permanently lose a statement's later pages AND ship a partial
  //     statement to lenders.
  const wmHuge = await watermarkBankStatement({
    bytes: await mkPages(420),
    mimeType: "application/pdf",
    provenance: prov,
  });
  if (!wmHuge.ok && wmHuge.error.includes("pdf_too_many_pages")) {
    console.log("ok over-cap PDF still fails closed:", wmHuge.error);
  } else {
    console.error("FAIL: over-cap PDF did not fail closed:", wmHuge);
    failures++;
  }

  // 5c) A page-cap refusal must surface ONE reason, not a compound
  //     "overlay_failed[...]|raster_failed[...]" string. Falling through to
  //     raster on a limit BOTH paths enforce re-parses the whole document only
  //     to fail identically — it doubles the latency and reads to the operator
  //     like two separate faults ("Overlay failed ... PDF too many pages").
  if (!wmHuge.ok && !wmHuge.error.includes("raster_failed")) {
    console.log("ok page-cap refusal reports a single cause");
  } else if (!wmHuge.ok) {
    console.error("FAIL: page-cap refusal still fell through to raster:", wmHuge.error);
    failures++;
  }

  // 6) ENCRYPTED PDF -> must still produce a branded statement.
  //
  // This is the case that matters most in production and had ZERO coverage:
  // permission-encrypted PDFs are a large share of real bank exports, pdf-lib
  // cannot decrypt them, so the overlay MUST bail and the pdfjs raster fallback
  // MUST take over. Every "it can't watermark it" report runs through this path.
  // The fixture is committed (see scripts/make-encrypted-pdf-fixture.py) so this
  // check never silently degrades to a skip on a machine without qpdf.
  const { readFileSync } = await import("node:fs");
  /*
   * `fileURLToPath(import.meta.url)`, not `import.meta.dirname`.
   *
   * package.json has no `"type": "module"`, so whether this file is ESM depends
   * on HOW it is launched. The documented command (`--import tsx`) makes it ESM
   * and `import.meta.dirname` resolves; `npx tsx scripts/test-watermark.ts`
   * does not, and there `import.meta.dirname` is undefined — `join(undefined,
   * …)` then throws a TypeError from OUTSIDE the try below, so the run dies
   * with a path error instead of reporting on the encrypted PDF. Loud, but it
   * points at the wrong thing. `import.meta.url` is defined in both, and
   * predates the Node 20.11 that `dirname` needs. Flagged by CodeRabbit on
   * PR #119.
   */
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = join(here, "..", "tests", "fixtures", "encrypted-statement.pdf");
  let encBytes: Buffer | null = null;
  try {
    encBytes = readFileSync(fixture);
  } catch (e) {
    console.error("FAIL: encrypted fixture missing —", e instanceof Error ? e.message : e);
    console.error(`      looked in: ${fixture}`);
    console.error("      regenerate with: python scripts/make-encrypted-pdf-fixture.py");
    failures++;
  }
  if (encBytes) {
    const wmEnc = await watermarkBankStatement({
      bytes: encBytes,
      mimeType: "application/pdf",
      provenance: prov,
    });
    if (wmEnc.ok && isPdf(wmEnc.bytes)) {
      const reload = await PDFDocument.load(wmEnc.bytes);
      const okPages = reload.getPageCount() === 2;
      console.log(
        `ok ENCRYPTED PDF -> branded ${wmEnc.bytes.length} bytes, ${reload.getPageCount()} pages, raster=${wmEnc.raster === true}${okPages ? "" : " (PAGE COUNT MISMATCH!)"}`,
      );
      if (!okPages) failures++;
      // The overlay cannot handle an encrypted source, so a healthy run MUST
      // have come from the raster fallback. If this ever reports raster=false,
      // pdf-lib accepted an encrypted PDF and the output is likely a corrupt,
      // mostly-blank statement — the exact bug the encryption guard prevents.
      if (wmEnc.raster !== true) {
        console.error("FAIL: encrypted source did not go through the raster path");
        failures++;
      }
    } else {
      console.error("FAIL ENCRYPTED PDF:", wmEnc);
      failures++;
    }
  }

  // 7) The RASTER page cap must actually fire, and report a single cause.
  //
  // MAX_PAGES_RASTER is only reachable through a source the OVERLAY cannot read,
  // because the overlay's own cap is far higher and refuses first. An
  // unencrypted over-cap PDF (case 5b) therefore never reaches raster — so
  // without this fixture the raster cap would ship as a guard whose timing
  // guarantee nothing proves. Encryption is the realistic way in: pdf-lib cannot
  // decrypt, so the overlay bails and raster is the only path left.
  //
  // The reason must come back CLEAN. The overlay's "I could not read this"
  // (`overlay_encrypted_source`) is not the blocker and is not actionable; the
  // page count is. Pairing them into
  // `overlay_failed[overlay_encrypted_source]|raster_failed[pdf_too_many_pages:121]`
  // reproduces the same two-faults-in-one-string confusion this branch set out
  // to remove. Flagged by CodeRabbit on PR #136.
  const overCapFixture = join(here, "..", "tests", "fixtures", "encrypted-statement-over-cap.pdf");
  let overCapBytes: Buffer | null = null;
  try {
    overCapBytes = readFileSync(overCapFixture);
  } catch (e) {
    console.error("FAIL: over-cap encrypted fixture missing —", e instanceof Error ? e.message : e);
    console.error(`      looked in: ${overCapFixture}`);
    console.error("      regenerate with: python scripts/make-encrypted-pdf-fixture.py");
    failures++;
  }
  if (overCapBytes) {
    const wmOver = await watermarkBankStatement({
      bytes: overCapBytes,
      mimeType: "application/pdf",
      provenance: prov,
    });
    if (wmOver.ok) {
      console.error("FAIL: an over-cap encrypted PDF was branded — the raster cap did not fire:", {
        pages: wmOver.pages,
      });
      failures++;
    } else if (!wmOver.error.includes("pdf_too_many_pages")) {
      console.error("FAIL: over-cap encrypted PDF failed for the wrong reason:", wmOver.error);
      failures++;
    } else if (wmOver.error.includes("overlay_failed") || wmOver.error.includes("raster_failed")) {
      console.error(
        "FAIL: raster page-cap refusal is still a compound error, not one cause:",
        wmOver.error,
      );
      failures++;
    } else {
      console.log("ok raster page cap fires and reports a single cause:", wmOver.error);
    }
  }

  console.log(failures === 0 ? "\nALL WATERMARK TESTS PASSED" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
