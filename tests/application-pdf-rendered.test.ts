/**
 * application-pdf-rendered.test.ts — the proof on RENDERED BYTES.
 *
 * Every other test in this area asserts on the mapped row objects. That is one
 * step short of the truth: it proves what we intended to draw, not what a
 * lender actually opens. Nothing in the suite has ever inspected the text
 * inside a generated application, which is precisely how an email could be
 * visible on the document while the tests stayed green.
 *
 * So this renders a real PDF through the same generateApplicationPdf() the
 * product calls, extracts the text with pdfjs (already a dependency — the
 * watermark raster path uses it), and asserts on what is actually on the page:
 *
 *   - the merchant's email address does NOT appear anywhere in the document
 *   - the "Email address" LABEL still does (the row survives, only the value goes)
 *   - a complete address appears in full, with nothing ellipsized away
 *
 * Ten-check acceptance, check 6 (user-visible rendering is correct).
 */
import assert from "node:assert/strict";
import { generateApplicationPdf, mapApplicationFieldsFromSteps } from "../lib/forms/application-pdf";
import { SUNBIZ_FORM_TEMPLATES } from "../lib/forms/sunbiz-templates";
import { parseFormSteps } from "../lib/forms/types";

const MERCHANT_EMAIL = "jaguartrans7-fixture@example.com";
const FULL_BUSINESS_ADDRESS = "911 Magnolia Dr, Algonquin, IL 60102";
const FULL_HOME_ADDRESS = "1600 Pennsylvania Avenue Northwest, Washington, DC 20500";

/** Extract every text run from a PDF's pages, concatenated. */
async function extractPdfText(bytes: Uint8Array): Promise<string> {
  // pdfjs' legacy build touches DOM globals on import; set them first or it
  // throws "DOMMatrix is not defined" (same dance as lib/forms/watermark.ts).
  const g = globalThis as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined") {
    const { DOMMatrix } = await import("@napi-rs/canvas");
    g.DOMMatrix = DOMMatrix;
  }
  const { join } = await import("node:path");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: false,
    // The document uses pdf-lib StandardFonts (Helvetica), which pdfjs resolves
    // from its own bundled font data; without this it warns and can drop glyphs.
    standardFontDataUrl: join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts") + "/",
  });
  const doc = await loadingTask.promise;

  let out = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items as Array<{ str?: string }>) {
      if (typeof item.str === "string") out += item.str + " ";
    }
  }
  await loadingTask.destroy();
  return out;
}

async function run() {
  const steps = parseFormSteps(SUNBIZ_FORM_TEMPLATES["full-application"].steps);
  const merged: Record<string, unknown> = {
    business_legal_name: "Rendered Fixture LLC",
    business_address: FULL_BUSINESS_ADDRESS,
    business_state: "IL",
    entity_type: "llc",
    industry: "transportation",
    monthly_revenue: 175000,
    requested_advance: 60000,
    owner_full_name: "Fixture Owner",
    owner_ssn: "000-00-0000",
    owner_dob: "1985-06-15",
    owner_cell: "555-555-0100",
    email: MERCHANT_EMAIL,
    owner_ownership_pct: 100,
    owner_home_address: FULL_HOME_ADDRESS,
  };

  const mapped = mapApplicationFieldsFromSteps(steps, merged, { email: MERCHANT_EMAIL });
  const bytes = await generateApplicationPdf({
    ...mapped,
    signatureDataUri: null,
    signedAt: "2026-08-14T12:00:00.000Z",
  });

  assert.ok(bytes.length > 800, "produced a real PDF");
  const text = await extractPdfText(bytes);
  assert.ok(text.length > 200, "extracted text from the rendered document");

  // THE assertion this file exists for.
  assert.ok(
    !text.includes(MERCHANT_EMAIL),
    `the merchant's email address must not appear anywhere in the rendered PDF (found it in: ...${
      text.slice(Math.max(0, text.indexOf(MERCHANT_EMAIL) - 60), text.indexOf(MERCHANT_EMAIL) + 60)
    })`,
  );
  // Not even the local-part on its own, in case a renderer ever wraps the value.
  assert.ok(!text.includes("jaguartrans7-fixture"), "no fragment of the email survives either");

  // The labelled row must still be there — Ezra asked for the value to go, not
  // the field. A missing label would mean the grid reflowed.
  assert.ok(
    /EMAIL ADDRESS/i.test(text),
    "the EMAIL ADDRESS label still renders (value blank, layout unchanged)",
  );

  // The phone rule, still holding, on rendered bytes for the first time.
  assert.ok(!text.includes("555-555-0100"), "the merchant's cell phone is not on the document");

  // Addresses must survive IN FULL — this is the other half of the request.
  // wrapClip ellipsizes long values, so assert the tail (the ZIP) is present:
  // the ZIP is the first thing lost to truncation.
  assert.ok(text.includes("60102"), "business address ZIP survives the render");
  assert.ok(text.includes("Algonquin"), "business address city survives the render");
  assert.ok(text.includes("20500"), "a long home address keeps its ZIP (not ellipsized)");
  assert.ok(!/…/.test(text), "nothing on the document was ellipsis-truncated");

  // Non-redacted data still prints, so the guard is not blanking everything.
  assert.ok(text.includes("Rendered Fixture LLC"), "business name still renders");

  console.log("application-pdf-rendered tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
