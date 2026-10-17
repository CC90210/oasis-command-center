/**
 * lib/forms/contact-gate.ts - a public form's lead starts at its contact step.
 *
 * CC, 2026-10-16: "only leads that input their information into these forms
 * are getting logged into the pipeline. If they don't input their email or
 * phone number, then we do not need to store them or log them." Two forms
 * asked something before contact (COMMUNITY's two questions, the VSL router's
 * path) and every first click made a pipeline lead named "Lead 5550691e" with
 * no way to reach anyone.
 *
 * Pure (no server-only import): the form in the browser and the submit route
 * ask the same questions, so they can never disagree about what counts.
 */
import { normalizePhoneE164 } from "@/lib/conversation-threading";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Where the submit route reads a lead's email and phone (initAnonymousLead reads the same keys). */
const EMAIL_KEYS = ["email", "owner_email", "contact_email"];
const PHONE_KEYS = ["phone", "owner_cell", "cell_phone"];

/**
 * The details a contact step hands to the first step, so the lead is created
 * with them: the person, the company, the email and the phone, under every
 * name initAnonymousLead reads them by.
 */
const HANDOFF_KEYS = new Set([
  ...EMAIL_KEYS,
  ...PHONE_KEYS,
  "contact_name", "name", "full_name", "owner_full_name", "owner_name",
  "business_name", "company", "business_legal_name", "legal_business_name", "dba",
]);
const HANDOFF_MAX_CHARS = 320;

/** A field that asks for an email address or a phone number. */
export function isContactField(field: { name: string; type: string }): boolean {
  return field.type === "email" || field.type === "phone" ||
    EMAIL_KEYS.includes(field.name) || PHONE_KEYS.includes(field.name);
}

/** The first step that asks for an email or phone, or -1 when the form never does. */
export function firstContactStepIndex(steps: ReadonlyArray<{ fields: ReadonlyArray<{ name: string; type: string }> }>): number {
  return steps.findIndex((step) => step.fields.some(isContactField));
}

/** Do these answers hold an email or a phone we could actually reach? */
export function hasReachableContact(values: Record<string, unknown>): boolean {
  const text = (key: string) => (typeof values[key] === "string" ? (values[key] as string).trim() : "");
  return EMAIL_KEYS.some((key) => EMAIL_RE.test(text(key))) ||
    PHONE_KEYS.some((key) => normalizePhoneE164(text(key)) !== null);
}

/**
 * What the form in the browser does with a validated step.
 *
 *   hold         anonymous, before the contact step: keep the answers here
 *   route        anonymous, the last step of a form with no contact step (the
 *                VSL router): ask where next, store nothing
 *   send-held    anonymous, the contact step after held steps: send those
 *                first (the first creates the lead with this step's contact),
 *                then this step
 *   send         everything else: the request it always was
 */
export type ContactGateAction = "hold" | "route" | "send-held" | "send";

export function contactGateAction(input: {
  /** No lead token yet, and the form is the anonymous kind. */
  anonymous: boolean;
  /** firstContactStepIndex for the form. */
  contactStep: number;
  currentStep: number;
  stepCount: number;
}): ContactGateAction {
  const { anonymous, contactStep, currentStep, stepCount } = input;
  if (!anonymous) return "send";
  if (contactStep === -1) return currentStep >= stepCount - 1 ? "route" : "hold";
  if (currentStep < contactStep) return "hold";
  return currentStep === contactStep && contactStep > 0 ? "send-held" : "send";
}

/**
 * The contact details from a later step, as the first step carries them: only
 * the handoff keys, only non-blank strings, each capped. Anything else in the
 * value is dropped, so the handoff can never smuggle an answer the step does
 * not declare. Null when nothing usable remains.
 */
export function contactHandoff(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!HANDOFF_KEYS.has(key) || typeof raw !== "string") continue;
    const text = raw.trim().slice(0, HANDOFF_MAX_CHARS);
    if (text) out[key] = text;
  }
  return Object.keys(out).length > 0 ? out : null;
}
