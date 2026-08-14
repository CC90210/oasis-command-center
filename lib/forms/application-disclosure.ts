/**
 * APPLICATION DISCLOSURE REGISTRY — the single declaration of what a lender may
 * see on the generated merchant application.
 *
 * WHY
 * The application PDF is lender-facing. Shop-out attaches every document on the
 * deal by default, and the watermark guard brands only bank statements, so this
 * PDF reaches funders exactly as rendered. Merchant contact details on it let a
 * funder go around the broker. Ezra, 2026-06-24, on the phone number:
 *
 *   "never expose the merchant's phone on the generated application PDF"
 *
 * and again on 2026-08-13, on the email, relayed by Adon:
 *
 *   "There's no phone number in the actual application PDF so I want the same
 *    thing for email address. It used to be like that."
 *
 * WHAT THIS IS NOT
 * This is NOT deletion. Adon, same conversation: "the emails need to stay."
 * The email and phone remain on the lead and application records and everywhere
 * in the CRM — an operator can still see and use them. This registry governs
 * one thing: what gets PRINTED on the generated document. Redaction happens at
 * render time only.
 *
 * WHY A REGISTRY AND NOT ANOTHER `value: ""`
 * The phone rule was implemented in June as a hardcoded blank at four call
 * sites plus one type check — six places, no single source of truth. Hiding the
 * email then meant finding all six again, and a sibling renderer
 * (fundmate-pdf.ts) had grown its own separate copy of the same intent. Every
 * new field repeated that hunt, and a missed site is a silent leak of exactly
 * the data we promised to withhold. Declared once here, enforced on every
 * renderer by tests/application-disclosure.test.ts, the next field is one line.
 *
 * HOW TO ADD A FIELD
 *   1. Add an entry to REDACTED_FIELD_TYPES (by form field type) or
 *      REDACTED_ROW_LABELS (by printed label), with a real reason, who asked,
 *      and when.
 *   2. Run `npm run test:sunbiz`. The disclosure test picks it up automatically
 *      and proves every renderer honours it.
 *   3. Nothing else. Do not add a `value: ""` anywhere.
 *
 * HOW TO UNHIDE A FIELD
 *   Delete its entry. That is the whole change.
 */

/** A minimal printed row. Structurally compatible with PdfFieldRow, declared
 *  locally so this module stays dependency-free and cheap to test. */
export type DisclosableRow = { label: string; value: string };

export type DisclosureRule = {
  /** Why this never prints. Written for whoever reads it in a year. */
  reason: string;
  /** Who asked for it. */
  requestedBy: string;
  /** YYYY-MM-DD. */
  since: string;
};

/**
 * Form field TYPES whose value never prints on the application.
 *
 * Type is the primary rule because the live PDF renders from the tenant's
 * stored form definition, where every contact field carries a real type.
 * Verified against production: the live `full-application` form has exactly one
 * `email` field and two `phone` fields, so these rules hit precisely the owner
 * and partner contact details and nothing else.
 */
export const REDACTED_FIELD_TYPES: Record<string, DisclosureRule> = {
  phone: {
    reason:
      "A funder who can call the merchant directly can go around the broker. "
      + "Covers phone / owner_cell / partner_cell.",
    requestedBy: "Ezra",
    since: "2026-06-24",
  },
  email: {
    reason:
      "Same reason as phone — the application is lender-facing once shopped "
      + "out. The address stays on the lead record; it just stops printing.",
    requestedBy: "Ezra",
    since: "2026-08-13",
  },
};

/**
 * Printed row LABELS whose value never prints.
 *
 * Needed because the legacy fallback mapper builds rows from hardcoded labels
 * and has no field types at all. Also applied to the live path as defence in
 * depth: a contact field mistyped as plain text would slip past the type rule
 * but is still caught by its label.
 *
 * Matching is case- and punctuation-insensitive (see `normalizeLabel`).
 */
export const REDACTED_ROW_LABELS: Record<string, DisclosureRule> = {
  "email": REDACTED_FIELD_TYPES.email,
  "email address": REDACTED_FIELD_TYPES.email,
  "phone": REDACTED_FIELD_TYPES.phone,
  "cell phone": REDACTED_FIELD_TYPES.phone,
  "home phone": REDACTED_FIELD_TYPES.phone,
  "business phone": REDACTED_FIELD_TYPES.phone,
  "fax": {
    reason: "A contact channel like any other; withheld for the same reason.",
    requestedBy: "Ezra",
    since: "2026-06-24",
  },
};

/** Lowercase, collapse whitespace, drop punctuation — so "Cell Phone:" and
 *  "cell  phone" both match the declared "cell phone". */
export function normalizeLabel(label: string): string {
  return (label || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Is this form field type redacted on the application? */
export function isRedactedType(type: string | null | undefined): boolean {
  return Boolean(type) && Object.prototype.hasOwnProperty.call(REDACTED_FIELD_TYPES, String(type));
}

/** Is this printed label redacted on the application? */
export function isRedactedLabel(label: string | null | undefined): boolean {
  return Object.prototype.hasOwnProperty.call(REDACTED_ROW_LABELS, normalizeLabel(String(label ?? "")));
}

/**
 * Should this field's value be withheld? Checks type first, then label.
 * Renderers call this instead of testing a field type inline.
 */
export function isRedactedField(
  field: { type?: string | null; label?: string | null } | null | undefined,
): boolean {
  if (!field) return false;
  return isRedactedType(field.type) || isRedactedLabel(field.label);
}

/**
 * Apply the registry to an already-built row.
 *
 * The label is deliberately KEPT and only the value is cleared, so the printed
 * form keeps its shape — a lender sees the field exists and is blank, rather
 * than the layout shifting and the document looking truncated. This is exactly
 * what the June phone change did by hand.
 */
export function applyDisclosure(row: DisclosableRow): DisclosableRow {
  return isRedactedLabel(row.label) ? { ...row, value: "" } : row;
}

/** Apply the registry to every row of every section. */
export function applyDisclosureToSections<
  S extends { heading: string; rows: DisclosableRow[] },
>(sections: S[]): S[] {
  return sections.map((s) => ({ ...s, rows: s.rows.map(applyDisclosure) }));
}

/** Every declared rule, for the contract test and for docs generation. */
export function allDisclosureRules(): Array<{ kind: "type" | "label"; key: string; rule: DisclosureRule }> {
  return [
    ...Object.entries(REDACTED_FIELD_TYPES).map(([key, rule]) => ({ kind: "type" as const, key, rule })),
    ...Object.entries(REDACTED_ROW_LABELS).map(([key, rule]) => ({ kind: "label" as const, key, rule })),
  ];
}
