import {
  AI_AUDIT_SLUG,
  AI_AUDIT_TENANT_ID,
  AI_AUDIT_TENANT_SLUG,
} from "@/lib/forms/oasis-ai-audit-seed";

/**
 * OASIS forms whose promised next step is a founder call.
 *
 * PROTOCOL and COMMUNITY are intentionally absent: their published offer copy
 * says no call is required. The VSL router is also absent because it collects
 * routing answers, not contact details. COMMAND and FLEET are drafts today,
 * but wiring them here means their existing publish gate can turn them on
 * without creating a second booking implementation later.
 *
 * BOOK is the one-step "Book a call" form behind oasisai.work/book (CC,
 * 2026-10-16): name, email, phone, company, then the calendar. It is the
 * link every form, offer page and follow-up points to when the goal is simply
 * a meeting on the Schedule.
 */
export const BOOK_FORM_SLUG = "book";

export const PUBLIC_BOOKING_FORM_SLUGS = [AI_AUDIT_SLUG, "command", "fleet", BOOK_FORM_SLUG] as const;

const PUBLIC_BOOKING_DURATION_BY_FORM: Readonly<Record<(typeof PUBLIC_BOOKING_FORM_SLUGS)[number], number>> = {
  [AI_AUDIT_SLUG]: 15,
  command: 45,
  fleet: 45,
  [BOOK_FORM_SLUG]: 30,
};

const PUBLIC_BOOKING_OFFER_LABEL_BY_FORM: Readonly<Record<(typeof PUBLIC_BOOKING_FORM_SLUGS)[number], string>> = {
  [AI_AUDIT_SLUG]: "AI automation audit",
  command: "COMMAND discovery call",
  fleet: "FLEET discovery call",
  [BOOK_FORM_SLUG]: "discovery call",
};

const publicBookingForms = new Set<string>(PUBLIC_BOOKING_FORM_SLUGS);

export function isPublicBookingFormSlug(formSlug: string): boolean {
  return publicBookingForms.has(formSlug.trim().toLowerCase());
}

// Own keys only: never an inherited Object member for a slug like "constructor".
const ownKey = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);

export function publicBookingDurationMinutes(formSlug: string): number {
  const normalized = formSlug.trim().toLowerCase() as (typeof PUBLIC_BOOKING_FORM_SLUGS)[number];
  return ownKey(PUBLIC_BOOKING_DURATION_BY_FORM, normalized)
    ? PUBLIC_BOOKING_DURATION_BY_FORM[normalized]
    : PUBLIC_BOOKING_DURATION_BY_FORM[AI_AUDIT_SLUG];
}

export function publicBookingOfferLabel(formSlug: string): string {
  const normalized = formSlug.trim().toLowerCase() as (typeof PUBLIC_BOOKING_FORM_SLUGS)[number];
  return ownKey(PUBLIC_BOOKING_OFFER_LABEL_BY_FORM, normalized)
    ? PUBLIC_BOOKING_OFFER_LABEL_BY_FORM[normalized]
    : PUBLIC_BOOKING_OFFER_LABEL_BY_FORM[AI_AUDIT_SLUG];
}

export function isPublicBookingForm(input: { tenantId: string; formSlug: string }): boolean {
  return input.tenantId === AI_AUDIT_TENANT_ID && isPublicBookingFormSlug(input.formSlug);
}

export function isPublicBookingSurface(input: { tenantSlug: string; formSlug: string }): boolean {
  return input.tenantSlug === AI_AUDIT_TENANT_SLUG && isPublicBookingFormSlug(input.formSlug);
}
