/**
 * Runtime test for lib/forms/signature-crop.ts — proves the native crop paths
 * (sharp for photos, pdfjs-dist + @napi-rs/canvas for PDFs) actually produce
 * valid PNGs. tsx scripts/test-signature-crop.ts
 */
import { cropSignatureFromDocument } from "../lib/forms/signature-crop";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG
function isPng(b64: string): boolean {
  return Buffer.from(b64, "base64").subarray(0, 4).equals(PNG_MAGIC);
}

async function main() {
  let failures = 0;

  // 1) PHOTO path (sharp): synth a 1000x700 white image, crop the lower-right.
  const sharp = (await import("sharp")).default;
  const testImg = await sharp({
    create: { width: 1000, height: 700, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();
  const imgCrop = await cropSignatureFromDocument({
    bytes: testImg,
    mimeType: "image/png",
    bbox: { x: 0.5, y: 0.7, width: 0.3, height: 0.12 },
  });
  if (imgCrop.ok && isPng(imgCrop.pngBase64) && imgCrop.width > 0 && imgCrop.height > 0) {
    console.log(`ok PHOTO crop -> PNG ${imgCrop.width}x${imgCrop.height}`);
  } else {
    console.error("FAIL PHOTO crop:", imgCrop);
    failures++;
  }

  // 2) PDF path (pdfjs + napi canvas): synth a letter page with a signature line.
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Applicant Signature: John Q. Merchant", { x: 60, y: 130, size: 14, font });
  page.drawLine({ start: { x: 60, y: 120 }, end: { x: 320, y: 120 }, thickness: 1 });
  const pdfBytes = Buffer.from(await pdf.save());
  const pdfCrop = await cropSignatureFromDocument({
    bytes: pdfBytes,
    mimeType: "application/pdf",
    bbox: { x: 0.09, y: 0.81, width: 0.45, height: 0.06 },
    page: 1,
  });
  if (pdfCrop.ok && isPng(pdfCrop.pngBase64) && pdfCrop.width > 0 && pdfCrop.height > 0) {
    console.log(`ok PDF crop -> PNG ${pdfCrop.width}x${pdfCrop.height}`);
  } else {
    console.error("FAIL PDF crop:", pdfCrop);
    failures++;
  }

  // 3) Guard: invalid bbox is rejected, not crashed.
  const bad = await cropSignatureFromDocument({
    bytes: testImg, mimeType: "image/png", bbox: { x: 2, y: 2, width: 1, height: 1 },
  });
  if (!bad.ok && bad.error === "invalid_bbox") console.log("ok invalid-bbox rejected");
  else { console.error("FAIL invalid-bbox guard:", bad); failures++; }

  if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
  console.log("\nok signature-crop (photo + pdf + guard)");
}

main().catch((e) => { console.error("THREW:", e); process.exit(1); });
