import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { watermarkBankStatement } from "../lib/forms/watermark";

async function main() {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  for (let pageNumber = 1; pageNumber <= 53; pageNumber += 1) {
    const page = source.addPage([612, 792]);
    page.drawText(`Statement page ${pageNumber}`, { x: 48, y: 740, size: 12, font });
  }

  const result = await watermarkBankStatement({
    bytes: Buffer.from(await source.save()),
    mimeType: "application/pdf",
    provenance: {
      leadId: "large-pdf-regression",
      businessName: "Regression Test Merchant",
      date: "2026-08-10",
    },
  });

  assert.equal(result.ok, true, result.ok ? undefined : result.error);
  if (result.ok) {
    assert.equal(result.pages, 53);
    assert.equal(result.mimeType, "application/pdf");
    assert.equal(result.bytes.subarray(0, 4).toString("ascii"), "%PDF");
  }

  console.log("53-page watermark regression ok");
}

void main();
