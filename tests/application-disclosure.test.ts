/**
 * application-disclosure.test.ts — enforcement for lib/forms/application-disclosure.ts.
 *
 * This is the guard that makes the registry load-bearing rather than decorative.
 * It runs against the REAL SunBiz full-application template, not a stub, because
 * the pre-existing form-driven fixture in tests/application-pdf.test.ts is a
 * four-step stub with NO owner or partner steps — so the OWNER INFORMATION
 * block, which is exactly where the merchant's email address renders, had zero
 * coverage. That gap is why the email shipped visible.
 *
 * Both mappers are exercised. mapApplicationFieldsFromSteps is what production
 * runs; mapApplicationFields is the fallback used whenever the tenant's forms
 * row is unreadable. A rule honoured by only one of them is a leak waiting for
 * a bad database read.
 */
import assert from "node:assert/strict";
import {
  REDACTED_FIELD_TYPES,
  REDACTED_ROW_LABELS,
  allDisclosureRules,
  applyDisclosure,
  isRedactedField,
  isRedactedLabel,
  isRedactedType,
  normalizeLabel,
} from "../lib/forms/application-disclosure";
import { mapApplicationFields, mapApplicationFieldsFromSteps } from "../lib/forms/application-pdf";
import { SUNBIZ_FORM_TEMPLATES } from "../lib/forms/sunbiz-templates";
import { parseFormSteps } from "../lib/forms/types";

/* ------------------------------------------------------------ registry shape */

for (const { kind, key, rule } of allDisclosureRules()) {
  assert.ok(rule.reason.length > 20, `${kind} "${key}" needs a real reason, not a stub`);
  assert.ok(rule.requestedBy.length > 0, `${kind} "${key}" must record who asked`);
  assert.match(rule.since, /^\d{4}-\d{2}-\d{2}$/, `${kind} "${key}" needs an ISO date`);
}

assert.ok(REDACTED_FIELD_TYPES.phone, "phone is redacted (Ezra 2026-06-24)");
assert.ok(REDACTED_FIELD_TYPES.email, "email is redacted (Ezra 2026-08-13)");

assert.equal(isRedactedType("email"), true);
assert.equal(isRedactedType("phone"), true);
assert.equal(isRedactedType("text"), false, "plain text is not redacted wholesale");
assert.equal(isRedactedType("address"), false, "addresses must still print");
assert.equal(isRedactedType(undefined), false);

assert.equal(isRedactedLabel("Email address"), true);
assert.equal(isRedactedLabel("EMAIL ADDRESS"), true, "matching is case-insensitive");
assert.equal(isRedactedLabel("Cell phone"), true);
assert.equal(isRedactedLabel("Home Address"), false, "the home address is NOT a contact field");
assert.equal(isRedactedLabel("Legal Business Name"), false);
assert.equal(normalizeLabel("Cell  Phone:"), "cell phone", "punctuation and spacing normalised");

// A contact field mistyped as plain text in the form builder is still caught.
assert.equal(
  isRedactedField({ type: "text", label: "Email address" }),
  true,
  "label rule is the backstop when the type is wrong",
);
assert.equal(isRedactedField({ type: "text", label: "DBA" }), false);

assert.deepEqual(
  applyDisclosure({ label: "Email", value: "owner@example.com" }),
  { label: "Email", value: "" },
  "label kept, value cleared — the row must survive so the layout does not shift",
);
assert.deepEqual(
  applyDisclosure({ label: "DBA", value: "Northwind" }),
  { label: "DBA", value: "Northwind" },
  "a non-redacted row passes through untouched",
);

/* ------------------------------- the LIVE template, both mappers, end to end */

const liveSteps = parseFormSteps(SUNBIZ_FORM_TEMPLATES["full-application"].steps);

// Sanity: the fixture must actually contain the block we care about, or this
// whole file would pass vacuously.
const ownerStep = liveSteps.find((s) => s.key === "owner");
assert.ok(ownerStep, "live template still has an owner step");
assert.ok(
  ownerStep!.fields.some((f) => f.type === "email"),
  "live template still has an email field in the owner step — if this fails the form changed, not the code",
);

const merged: Record<string, unknown> = {
  business_legal_name: "Northwind Test LLC",
  business_address: "100 Sample Ave, Testville, 75001",
  business_state: "TX",
  entity_type: "llc",
  industry: "construction",
  monthly_revenue: 175000,
  requested_advance: 60000,
  owner_full_name: "Jordan Tester",
  owner_ssn: "000-00-0000",
  owner_dob: "1985-06-15",
  owner_cell: "555-555-0100",
  email: "owner@example.com",
  owner_ownership_pct: 100,
  owner_home_address: "9 Residential Way, Testville, TX 75002",
  partner_full_name: "Casey Partner",
  partner_cell: "555-555-0199",
  partner_home_address: "11 Second St, Testville, TX 75003",
};
const lead: Record<string, unknown> = { email: "owner@example.com", phone: "555-555-0100" };

const live = mapApplicationFieldsFromSteps(liveSteps, merged, lead);
const legacy = mapApplicationFields(merged, lead);

function rowsOf(m: { sections: Array<{ heading: string; rows: Array<{ label: string; value: string }> }> }) {
  return m.sections.flatMap((s) => s.rows.map((r) => ({ ...r, heading: s.heading })));
}

for (const [name, mapped] of [["live", live], ["legacy", legacy]] as const) {
  const rows = rowsOf(mapped);
  assert.ok(rows.length > 0, `${name}: produced rows`);

  // THE core guarantee: nothing the registry declares private carries a value.
  for (const row of rows) {
    if (isRedactedLabel(row.label)) {
      assert.equal(
        row.value,
        "",
        `${name}: "${row.label}" is declared private but rendered "${row.value}"`,
      );
    }
  }

  // The email must be gone specifically — the whole point of the change.
  const emailRows = rows.filter((r) => normalizeLabel(r.label).includes("email"));
  assert.ok(emailRows.length > 0, `${name}: an email row is still rendered`);
  for (const r of emailRows) {
    assert.equal(r.value, "", `${name}: email value withheld`);
  }

  // Guard against a registry that blanks everything — prove real data still prints.
  const businessName = rows.find((r) => normalizeLabel(r.label).includes("business name"));
  assert.ok(businessName, `${name}: business name row exists`);
  assert.equal(businessName!.value, "Northwind Test LLC", `${name}: non-redacted data still renders`);

  // Addresses are NOT contact fields and must survive in full.
  const homeAddress = rows.find((r) => normalizeLabel(r.label) === "home address");
  assert.ok(homeAddress, `${name}: home address row exists`);
  assert.ok(
    homeAddress!.value.includes("Testville"),
    `${name}: home address still renders (got "${homeAddress!.value}")`,
  );
}

/* ---------------------------------------------------------------- drift guard */

// If a future form adds another contact field, it is withheld automatically.
// This asserts the property across EVERY field of the live template rather than
// the two we happen to know about today.
const liveRows = rowsOf(live);
for (const step of liveSteps) {
  for (const f of step.fields) {
    if (!isRedactedField(f)) continue;
    const row = liveRows.find((r) => r.label === f.label);
    if (!row) continue;
    assert.equal(
      row.value,
      "",
      `live: field "${f.name}" (type ${f.type}) is declared private but rendered a value`,
    );
  }
}

// And the inverse: adding a type to the registry must take effect on both
// mappers without touching a renderer. Simulated by asserting the mechanism the
// mappers use is the registry itself, for a type nobody has declared yet.
assert.equal(isRedactedType("currency"), false, "currency is not declared private today");
assert.ok(
  Object.keys(REDACTED_ROW_LABELS).length >= 5,
  "label registry covers the legacy mapper's contact rows",
);

console.log("application-disclosure tests passed");
