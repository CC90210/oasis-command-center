/**
 * demo-application-pdf.ts — generate a DEMO filled SunBiz application PDF from
 * the canonical full-application form, using the new form-driven mapper. Pure
 * (no DB/env) — writes the PDF to the path in argv[2]. Used to (a) eyeball the
 * layout and (b) hand the bytes to the uploader that attaches it to a demo lead.
 *
 * All values are OBVIOUSLY fake (demo-example.com, 000-00-* SSN, 555 phone).
 */
import { writeFileSync, readFileSync } from "node:fs";
import { SUNBIZ_FORM_TEMPLATES } from "../lib/forms/sunbiz-templates";
import { mapApplicationFieldsFromSteps, generateApplicationPdf } from "../lib/forms/application-pdf";
import type { FormField, FormStep } from "../lib/forms/types";

function testValue(f: FormField): unknown {
  // Partner / co-owner is optional — leave blank so the demo shows a realistic
  // single-owner application (empty cells in that section).
  if (f.name.includes("partner")) return "";
  switch (f.type) {
    case "email":
      return "owner@demo-example.com";
    case "phone":
      return "(555) 010-7788";
    case "date":
      return f.name.includes("dob") ? "1984-09-12" : "2021-03-15";
    case "currency":
      return f.name.includes("requested") || f.name.includes("advance") ? 75000 : 180000;
    case "number":
      return f.name.includes("partner") ? 0 : 100;
    case "select":
    case "combobox":
      // Pick a meaningful option where obvious, else the first.
      if (f.name === "entity_type") return "llc";
      if (f.name === "business_state") return "FL";
      if (f.name === "industry") return f.options?.find((o) => o.value === "construction")?.value ?? f.options?.[0]?.value ?? "";
      if (f.options?.some((o) => o.value === "agreed")) return "agreed";
      return f.options?.[0]?.value ?? "";
    case "multiselect":
      return f.options?.[0] ? [f.options[0].value] : [];
    case "address":
      return "1200 Demo Parkway, Suite 400, Fort Lauderdale, FL 33301";
    case "textarea":
      return "Residential and light-commercial construction — framing, remodels, and additions across South Florida.";
    case "text":
      if (f.name === "signature_name") return "Jordan A. Tester";
      if (f.name.includes("dba")) return "Northwind";
      if (f.name.includes("ein") || f.name.includes("tax")) return "47-1234567";
      if (f.name.includes("ssn")) return "000-00-1234";
      if (f.name.includes("legal") || f.name.includes("business")) return "Northwind Builders LLC";
      if (f.name.includes("pct") || f.name.includes("ownership")) return "100";
      if (f.name.includes("name")) return "Jordan A. Tester";
      return "Sample answer";
    default:
      return "";
  }
}

const steps: FormStep[] = SUNBIZ_FORM_TEMPLATES["full-application"].steps;
const merged: Record<string, unknown> = {};
for (const step of steps) {
  for (const f of step.fields) {
    if (
      f.type === "file_upload" ||
      f.type === "file_upload_multi" ||
      f.type === "signature" ||
      f.type === "hidden"
    ) {
      continue;
    }
    merged[f.name] = testValue(f);
  }
}
const lead = {
  business_name: "Northwind Builders LLC",
  email: "owner@demo-example.com",
  phone: "(555) 010-7788",
};

// Optional argv[3]: path to a PNG of the merchant's drawn signature — mirrors
// what the live form submits (applicant_signature data-URI). When provided it is
// embedded at the bottom of the PDF exactly as a real submission would.
const sigPath = process.argv[3];
const signatureDataUri = sigPath
  ? `data:image/png;base64,${readFileSync(sigPath).toString("base64")}`
  : "";

(async () => {
  const { sections, signatureName } = mapApplicationFieldsFromSteps(steps, merged, lead);
  const bytes = await generateApplicationPdf({
    sections,
    signatureName,
    signatureDataUri,
    signedAt: "2026-06-22T15:00:00.000Z",
  });
  const out = process.argv[2] || "demo-application.pdf";
  writeFileSync(out, Buffer.from(bytes));
  console.log(
    JSON.stringify(
      {
        ok: true,
        out,
        bytes: bytes.length,
        sections: sections.map((s) => ({ heading: s.heading, rows: s.rows.length })),
      },
      null,
      2,
    ),
  );
})();
