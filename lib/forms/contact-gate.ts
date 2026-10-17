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

/**
 * Every name a form may give a lead's email, phone, person and company, in the
 * order the submit route's initAnonymousLead reads them (first non-blank
 * wins; aliases are appended, never reordered). One list for both, so the
 * contact gate and the lead it lets through can never disagree on a field.
 */
export const LEAD_EMAIL_KEYS = ["email", "owner_email", "contact_email"] as const;
export const LEAD_PHONE_KEYS = ["phone", "owner_cell", "cell_phone"] as const;
export const LEAD_NAME_KEYS = ["contact_name", "name", "full_name", "owner_full_name", "owner_name"] as const;
export const LEAD_COMPANY_KEYS = ["business_name", "company", "business_legal_name", "legal_business_name", "dba"] as const;

const EMAIL_KEYS: readonly string[] = LEAD_EMAIL_KEYS;
const PHONE_KEYS: readonly string[] = LEAD_PHONE_KEYS;

/**
 * The details a contact step hands to the first step, so the lead is created
 * with them: the person, the company, the email and the phone, under every
 * name initAnonymousLead reads them by.
 */
const HANDOFF_KEYS = new Set<string>([...LEAD_EMAIL_KEYS, ...LEAD_PHONE_KEYS, ...LEAD_NAME_KEYS, ...LEAD_COMPANY_KEYS]);
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

/**
 * The email and phone a step's own typed fields hold, under the standard
 * names. The form builder names a renamed field by its label (`work_email`),
 * but it is still the email field: read by type, the gate and the lead see it
 * (Codex review of #668). The first non-blank value of each type wins.
 */
export function typedContact(
  fields: ReadonlyArray<{ name: string; type: string }>,
  values: Record<string, unknown>,
): { email?: string; phone?: string } {
  const out: { email?: string; phone?: string } = {};
  for (const field of fields) {
    const raw = values[field.name];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) continue;
    if (field.type === "email" && !out.email) out.email = value;
    if (field.type === "phone" && !out.phone) out.phone = value;
  }
  return out;
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
 *   send-held    the contact step while held steps remain unsent: send those
 *                first (the first creates the lead with this step's contact),
 *                then this step. Still so once a token exists: a retry after
 *                step 0 went through and a later held step failed must finish
 *                the held steps, never skip them (Codex review of #668).
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
  /** Steps this browser held are not all on the server yet. */
  heldUnsent: boolean;
}): ContactGateAction {
  const { anonymous, contactStep, currentStep, stepCount, heldUnsent } = input;
  if (heldUnsent && contactStep > 0 && currentStep === contactStep) return "send-held";
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
