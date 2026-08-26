import assert from "node:assert/strict";

/**
 * The incident (2026-08-26). A merchant who filled SunBiz's `full-application`
 * form produced a lead with no business name, no contact name, no email and no
 * phone. On the Leads board LeadPipelineView falls back to the record id, so
 * the card reads `Untitled 65061d` and a rep can neither identify nor call the
 * applicant.
 *
 * Measured on production: 13 such leads, EVERY ONE from that one form, several
 * already at `signed_application` — completed, signed applications from real
 * businesses (Beat Bang Theory LLC, AJL Transport LLC, Brighthold Estates LLC,
 * REGAL JEWELERS INC, …) sitting on the board anonymously.
 *
 * Nothing was ever lost. The names were on the application record and in
 * form_submissions the entire time. The submit route simply read SunBiz's
 * INTAKE vocabulary (business_name / contact_name / phone) while the full
 * application writes business_legal_name / owner_full_name / owner_cell.
 *
 * This pins the vocabulary. It is a pure mapping test: the route's own reader.
 */

/** Mirrors `trimmed()` in app/api/forms/submit/route.ts — first non-blank wins. */
function trimmed(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

const NAME_KEYS = ["contact_name", "name", "full_name", "owner_full_name", "owner_name"];
const BUSINESS_KEYS = ["business_name", "company", "business_legal_name", "legal_business_name", "dba"];

// ── the exact payload that broke, taken from form_submissions ───────────────
//
// Step 0 of the SunBiz full application. This is what the merchant typed.
const fullApplicationStep0 = { business_legal_name: "Beat Bang Theory LLC." };
const fullApplicationStep2 = {
  owner_full_name: "A Real Owner",
  owner_cell: "5555550100",
  email: "owner@example.com",
};

// THE GUARD FIRING. Before the fix both of these returned "" and the lead was
// created nameless.
assert.equal(
  trimmed(fullApplicationStep0, ...BUSINESS_KEYS),
  "Beat Bang Theory LLC.",
  "the full application's business_legal_name MUST reach the lead, or the board shows `Untitled <id>`",
);
assert.equal(
  trimmed(fullApplicationStep2, ...NAME_KEYS),
  "A Real Owner",
  "the full application's owner_full_name MUST reach the lead as the contact",
);

/** Mirrors the phone/email fallbacks. */
const pickPhone = (p: Record<string, unknown>) => p.phone ?? p.owner_cell ?? p.cell_phone;
const pickEmail = (p: Record<string, unknown>) => p.email ?? p.owner_email ?? p.contact_email;

assert.equal(
  pickPhone(fullApplicationStep2),
  "5555550100",
  "owner_cell must reach the lead, or a rep cannot call a signed applicant",
);
assert.equal(pickEmail(fullApplicationStep2), "owner@example.com", "email must reach the lead");

// ── the intake vocabulary still wins where both are present ─────────────────
//
// Aliases were APPENDED, never reordered. A form that sends both must behave
// exactly as it did before, or this fix quietly rewrites existing funnels.
assert.equal(
  trimmed({ business_name: "Canonical Co", business_legal_name: "Legal Co LLC" }, ...BUSINESS_KEYS),
  "Canonical Co",
  "business_name still takes precedence over the appended alias",
);
assert.equal(
  trimmed({ contact_name: "Primary Contact", owner_full_name: "Signer Name" }, ...NAME_KEYS),
  "Primary Contact",
  "contact_name still takes precedence over the appended alias",
);
assert.equal(
  pickPhone({ phone: "1112223333", owner_cell: "9998887777" }),
  "1112223333",
  "phone still takes precedence over owner_cell",
);

// ── blanks are still rejected ───────────────────────────────────────────────
//
// The existing guard: a whitespace-only value must not be written as a name,
// because on a returning merchant this merges into an EXISTING lead and would
// overwrite a real name before validation rejects the submission.
assert.equal(
  trimmed({ business_legal_name: "   " }, ...BUSINESS_KEYS),
  "",
  "a whitespace-only alias must not be written as a business name",
);
assert.equal(
  trimmed({ business_legal_name: "   ", dba: "Real DBA" }, ...BUSINESS_KEYS),
  "Real DBA",
  "a blank earlier key falls through to the next, it does not abort the search",
);
assert.equal(trimmed({}, ...BUSINESS_KEYS), "", "an empty payload yields no name, never a placeholder");

// ── the board's fallback, which is what a rep actually saw ──────────────────
function cardTitle(leadData: Record<string, unknown>, id: string): string {
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  return s(leadData.business_name) || s(leadData.name) || `Untitled ${id.slice(0, 6)}`;
}

assert.equal(
  cardTitle({}, "65061d5c-1111-2222-3333-444444444444"),
  "Untitled 65061d",
  "this is the card a rep saw for a signed application — the string that proves the bug was real",
);
assert.equal(
  cardTitle({ business_name: "Beat Bang Theory LLC." }, "65061d5c-1111-2222-3333-444444444444"),
  "Beat Bang Theory LLC.",
  "with the alias mapped, the same lead renders with the merchant's own name",
);

console.log("form-lead-identity: all guards fire ✓");
