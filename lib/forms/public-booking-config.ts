import {
  AI_AUDIT_SLUG,
  AI_AUDIT_TENANT_ID,
  AI_AUDIT_TENANT_SLUG,
} from "@/lib/forms/oasis-ai-audit-seed";

/**
 * OASIS forms that end on the founder calendar.
 *
 * AI-AUDIT, COMMAND and FLEET promise a founder call: the calendar IS their
 * next step. BOOK is the one-step "Book a call" form behind oasisai.work/book
 * (CC, 2026-10-16): name, email, phone, company, then the calendar.
 *
 * PROTOCOL and COMMUNITY offer the calendar as an OPTION (CC, 2026-10-16:
 * every offer page has a place to submit and to book a call). Their offer copy
 * says no call is required, so their own next step (the checkout email, the
 * community link) stays first and the calendar sits under it, never in its
 * place (PUBLIC_BOOKING_OPTIONAL_FORM_SLUGS).
 *
 * The VSL router is absent: it collects routing answers, not contact details,
 * and sends the visitor on to an offer page that has its own calendar.
 */
export const BOOK_FORM_SLUG = "book";

export const PUBLIC_BOOKING_FORM_SLUGS = [AI_AUDIT_SLUG, "command", "fleet", BOOK_FORM_SLUG, "protocol", "community"] as const;

/** Forms whose call is optional: the calendar follows their own thanks, never replaces it. */
export const PUBLIC_BOOKING_OPTIONAL_FORM_SLUGS = ["protocol", "community"] as const;

const PUBLIC_BOOKING_DURATION_BY_FORM: Readonly<Record<(typeof PUBLIC_BOOKING_FORM_SLUGS)[number], number>> = {
  [AI_AUDIT_SLUG]: 15,
  command: 45,
  fleet: 45,
  [BOOK_FORM_SLUG]: 30,
  protocol: 15,
  community: 15,
};

const PUBLIC_BOOKING_OFFER_LABEL_BY_FORM: Readonly<Record<(typeof PUBLIC_BOOKING_FORM_SLUGS)[number], string>> = {
  [AI_AUDIT_SLUG]: "AI automation audit",
  command: "COMMAND discovery call",
  fleet: "FLEET discovery call",
  [BOOK_FORM_SLUG]: "discovery call",
  protocol: "PROTOCOL questions call",
  community: "community intro call",
};

/**
 * The form a lead finished, as a founder reads it on the Sales desk and the
 * lead page ("finished the PROTOCOL form"). The finished-form stage is shared
 * by every form here, so without the form's name a PROTOCOL buyer read as an
 * audit (review of #655).
 */
const PUBLIC_BOOKING_FORM_NAME_BY_FORM: Readonly<Record<(typeof PUBLIC_BOOKING_FORM_SLUGS)[number], string>> = {
  [AI_AUDIT_SLUG]: "AI audit",
  command: "COMMAND",
  fleet: "FLEET",
  [BOOK_FORM_SLUG]: "Book a call",
  protocol: "PROTOCOL",
  community: "community",
};

const publicBookingForms = new Set<string>(PUBLIC_BOOKING_FORM_SLUGS);
const optionalBookingForms = new Set<string>(PUBLIC_BOOKING_OPTIONAL_FORM_SLUGS);

export function isPublicBookingFormSlug(formSlug: string): boolean {
  return publicBookingForms.has(formSlug.trim().toLowerCase());
}

/** The calendar is offered after this form's own next step, not as it. */
export function isOptionalPublicBookingFormSlug(formSlug: string): boolean {
  return optionalBookingForms.has(formSlug.trim().toLowerCase());
}

// Own keys only: never an inherited Object member for a slug like "constructor".
const ownKey = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);

export function publicBookingDurationMinutes(formSlug: string): number {
  const normalized = formSlug.trim().toLowerCase() as (typeof PUBLIC_BOOKING_FORM_SLUGS)[number];
  return ownKey(PUBLIC_BOOKING_DURATION_BY_FORM, normalized)
    ? PUBLIC_BOOKING_DURATION_BY_FORM[normalized]
    : PUBLIC_BOOKING_DURATION_BY_FORM[AI_AUDIT_SLUG];
}

/** The finished form's name ("PROTOCOL"), or null for a slug that is not a booking form. */
export function publicBookingFormName(formSlug: unknown): string | null {
  const normalized = (typeof formSlug === "string" ? formSlug : "").trim().toLowerCase();
  return ownKey(PUBLIC_BOOKING_FORM_NAME_BY_FORM, normalized)
    ? PUBLIC_BOOKING_FORM_NAME_BY_FORM[normalized as (typeof PUBLIC_BOOKING_FORM_SLUGS)[number]]
    : null;
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
