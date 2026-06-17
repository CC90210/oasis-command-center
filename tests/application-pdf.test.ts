/**
 * application-pdf.test.ts — the field-mapping + PDF-generation layer for the
 * signed SunBiz application (lib/forms/application-pdf.ts).
 *
 * Tests the pure mapping (form payload + lead → labeled section rows, with
 * blanks for uncollected fields + correct currency/date/pct/entity/state
 * formatting) and that generateApplicationPdf returns real PDF bytes and
 * survives emoji / non-Latin free-text (WinAnsi sanitize).
 */
import { mapApplicationFields, generateApplicationPdf } from "../lib/forms/application-pdf";

let failures = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failures += 1;
  }
}

// Synthetic merchant — OBVIOUSLY-FAKE values (000-00-0000 SSN, 555 phone,
// example.com email) that preserve the real field FORMATS so the mapping /
// formatting assertions stay meaningful. No live PII in the repo (Codex audit
// 2026-06-17 [P2]).
const merged: Record<string, unknown> = {
  business_legal_name: "Northwind Test LLC",
  dba: "Northwind",
  business_address: "100 Sample Ave, Testville TX 75001",
  tax_id_ein: "12-3456789",
  business_start_date: "2020-12-20",
  entity_type: "llc",
  product_service_description: "Residential construction",
  business_state: "tx",
  industry: "residential_construction",
  owner_full_name: "Jordan Tester",
  owner_ssn: "000-00-0000",
  owner_dob: "1985-06-15",
  owner_cell: "(555) 010-1234",
  owner_ownership_pct: 100,
  owner_home_address: "100 Sample Ave, Testville TX 75001",
  monthly_revenue: 175000,
  requested_advance: 60000,
  signature_name: "Jordan Tester",
  applicant_signature: "data:image/png;base64,AAAA",
};
const lead: Record<string, unknown> = {
  business_name: "Northwind Test LLC",
  email: "owner@example.com",
  phone: "(555) 010-1234",
};

const { sections, signatureName } = mapApplicationFields(merged, lead);
const val = (heading: string, label: string) =>
  sections.find((s) => s.heading === heading)?.rows.find((r) => r.label === label)?.value;

// Sections present + ordered.
check(sections.map((s) => s.heading).join("|") ===
  "BUSINESS INFORMATION|MERCHANT / OWNER INFORMATION|PARTNER INFORMATION|FINANCIAL INFORMATION",
  "four sections in order");

// Business mapping + formatting.
check(signatureName === "Jordan Tester", "signature name carried");
check(val("BUSINESS INFORMATION", "Legal Business Name") === "Northwind Test LLC", "legal name mapped");
check(val("BUSINESS INFORMATION", "Federal Tax ID / EIN") === "12-3456789", "ein mapped");
check(val("BUSINESS INFORMATION", "Date Started") === "12/20/2020", "ISO date → US format");
check(val("BUSINESS INFORMATION", "Type of Entity") === "LLC", "entity value → label");
check(val("BUSINESS INFORMATION", "State") === "TX", "state uppercased");
check(val("BUSINESS INFORMATION", "Industry") === "Residential Construction", "industry slug title-cased");
check(val("BUSINESS INFORMATION", "Email") === "owner@example.com", "email from lead record");
check(val("BUSINESS INFORMATION", "Phone") === "(555) 010-1234", "phone from lead record");
check(val("BUSINESS INFORMATION", "Product / Service") === "Residential construction", "product/service mapped");

// Uncollected fields render blank (CC: keep form as-is).
check(val("BUSINESS INFORMATION", "Fax") === "", "fax blank (uncollected)");
check(val("BUSINESS INFORMATION", "Website") === "", "website blank (uncollected)");
check(val("BUSINESS INFORMATION", "Business Type") === "", "business type blank (uncollected)");
check(val("BUSINESS INFORMATION", "Length of Ownership") === "", "length of ownership blank");

// Owner mapping.
check(val("MERCHANT / OWNER INFORMATION", "Name") === "Jordan Tester", "owner name mapped");
check(val("MERCHANT / OWNER INFORMATION", "Ownership %") === "100%", "ownership pct gets % suffix");
check(val("MERCHANT / OWNER INFORMATION", "Date of Birth") === "06/15/1985", "owner dob → US format");
check(val("MERCHANT / OWNER INFORMATION", "Cell Phone") === "(555) 010-1234", "owner cell mapped");
check(val("MERCHANT / OWNER INFORMATION", "Title") === "", "owner title blank (uncollected)");
check(val("MERCHANT / OWNER INFORMATION", "Home Phone") === "", "owner home phone blank (uncollected)");

// Partner absent → blank rows.
check(val("PARTNER INFORMATION", "Name") === "", "partner blank when not provided");

// Financial — collected numbers formatted as currency; rest blank.
check(val("FINANCIAL INFORMATION", "Average Monthly Revenue") === "$175,000", "monthly revenue currency");
check(val("FINANCIAL INFORMATION", "Requested Advance") === "$60,000", "requested advance currency");
check(val("FINANCIAL INFORMATION", "Use of Funds") === "", "use of funds blank (uncollected)");
check(val("FINANCIAL INFORMATION", "Monthly CC Processing Revenue") === "", "cc processing blank (uncollected)");

// Lead-fallback: business name from lead when the form field is empty.
{
  const m2 = { ...merged, business_legal_name: "" };
  const r2 = mapApplicationFields(m2, lead);
  const legal = r2.sections[0].rows.find((r) => r.label === "Legal Business Name")?.value;
  check(legal === "Northwind Test LLC", "legal name falls back to lead.business_name");
}

(async () => {
  // generateApplicationPdf returns real PDF bytes (no signature image here — a
  // valid PNG isn't needed to prove the layout renders).
  const bytes = await generateApplicationPdf({
    sections,
    signatureName,
    signatureDataUri: "",
    signedAt: "2026-06-12T15:45:00.000Z",
  });
  check(Buffer.from(bytes.slice(0, 5)).toString("latin1") === "%PDF-", "generateApplicationPdf returns a PDF");
  check(bytes.length > 800, "PDF has real content");

  // Emoji / non-Latin free-text must NOT crash generation (WinAnsi sanitize).
  const m3 = { ...merged, product_service_description: "Construcción 🏗️ café — déjà vu" };
  const { sections: s3 } = mapApplicationFields(m3, lead);
  const b3 = await generateApplicationPdf({
    sections: s3,
    signatureName: "José 😀",
    signatureDataUri: "",
    signedAt: "2026-06-12T15:45:00.000Z",
  });
  check(Buffer.from(b3.slice(0, 5)).toString("latin1") === "%PDF-", "emoji/non-Latin text does not crash PDF");

  // Malformed signature data-URI is swallowed (ruled line fallback), still a PDF.
  const b4 = await generateApplicationPdf({
    sections,
    signatureName,
    signatureDataUri: "data:image/png;base64,not-real-base64!!!",
    signedAt: "2026-06-12T15:45:00.000Z",
  });
  check(Buffer.from(b4.slice(0, 5)).toString("latin1") === "%PDF-", "malformed signature → still a PDF");

  if (failures > 0) {
    console.error(`application-pdf: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("application-pdf ok");
})();
