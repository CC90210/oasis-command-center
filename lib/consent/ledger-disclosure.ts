/**
 * lib/consent/ledger-disclosure.ts — the exact disclosure text every public
 * form's consent checkboxes render, and the one place it is computed.
 *
 * WHY ONE FUNCTION FOR BOTH READ AND WRITE. The ledger's evidence value rests
 * entirely on "the hash matches what was shown". If the page rendered its own
 * copy of this wording and the submit route hashed a SEPARATELY maintained
 * copy, the two would drift the first time either was edited, and the ledger
 * would silently start recording a hash of text nobody ever saw — worse than
 * no record, because it reads as proof. So the server component that renders
 * the page and the submit route that records the ledger both call
 * `consentDisclosureText` with the SAME identity, and only the server computes
 * the hash (lib/consent/ledger.ts) — the client never sends one.
 *
 * Pure, no I/O, no "server-only": the identity resolution that touches the
 * database lives in lib/consent/ledger-identity.ts.
 */

import type { FormStep } from "@/lib/forms/types";
import { isFieldVisible } from "@/lib/forms/visibility";

export type ConsentChannel = "email" | "sms";

export type ConsentIdentity = {
  /** The business named in the disclosure — a real, legally accurate name,
   *  never a placeholder. */
  businessName: string;
  /** CAN-SPAM/CASL physical postal address, one line. */
  address: string;
  /** Absolute URL to the privacy policy (Law 25 s.8.1). */
  privacyUrl: string;
};

/**
 * Version string stamped on every row this module's current wording
 * produces. CHANGING THE WORDING BELOW REQUIRES BUMPING THIS. Editing the
 * text under an existing version would silently rewrite what past visitors
 * are recorded as having been shown — the same rule lib/consent/optinvault.ts
 * documents for the SunBiz/Bluerise vault, and the same reason it matters
 * here: the ledger asserts a person read exactly this text.
 */
export const CONSENT_DISCLOSURE_VERSION = "occ-ledger-v1-2026-10";

/**
 * The exact disclosure text for one channel. Deterministic: same channel +
 * same identity always produces byte-identical text, which is what makes the
 * hash meaningful.
 */
export function consentDisclosureText(channel: ConsentChannel, identity: ConsentIdentity): string {
  const { businessName, address, privacyUrl } = identity;
  if (channel === "email") {
    return (
      `I agree that ${businessName} (${address}) may email me about my enquiry and related offers. ` +
      `Consent is not a condition of receiving a response. I can unsubscribe at any time using the ` +
      `link in any email. Privacy policy: ${privacyUrl}`
    );
  }
  return (
    `I agree that ${businessName} (${address}) may text me at the mobile number I provided about my ` +
    `enquiry and related offers, including by automated text message. Consent is not a condition of ` +
    `receiving a response. Message and data rates may apply. Reply STOP at any time to opt out. ` +
    `Privacy policy: ${privacyUrl}`
  );
}

/** Both known channels, in the stable order this module renders them. */
export const CONSENT_CHANNELS: readonly ConsentChannel[] = ["email", "sms"] as const;

export function isConsentChannel(v: unknown): v is ConsentChannel {
  return v === "email" || v === "sms";
}

/**
 * Which ledger channels a form STEP actually declares — derived from the
 * step's own field definitions, never from anything a caller claims.
 *
 * THE ONE PLACE THIS IS DECIDED. Both the public page (FormPublicClient,
 * deciding which boxes to draw) and the submit route
 * (app/api/forms/submit/route.ts, deciding which decisions to record) call
 * this SAME function on the SAME step — not two independently-written
 * equivalents that could drift. A step with an `email` field renders the
 * email channel; a step with a `phone` field renders the sms channel; a
 * hidden-by-show_if field counts as absent, matching every other visibility
 * rule in this codebase.
 */
export function renderedChannelsForStep(step: FormStep, values: Record<string, unknown>): ConsentChannel[] {
  const channels: ConsentChannel[] = [];
  if (step.fields.some((f) => f.type === "email" && isFieldVisible(f, values))) channels.push("email");
  if (step.fields.some((f) => f.type === "phone" && isFieldVisible(f, values))) channels.push("sms");
  return channels;
}

/**
 * The canonical form of an email address or mobile number, so a consent
 * decision binds to the exact destination it was given for and the send gate
 * can match it. Email: trimmed + lowercased. SMS: digits only, a leading
 * North American "1" dropped from an 11-digit number. Anything that does not
 * look like a usable destination answers null — and a null subject can never
 * authorise a send (lib/consent/ledger.ts).
 */
export function normalizeConsentSubject(channel: ConsentChannel, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (channel === "email") {
    const email = raw.trim().toLowerCase();
    return email.includes("@") && email.length <= 320 ? email : null;
  }
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

/** The value the step's own visible field of this channel's type holds. */
function stepSubjectFor(
  step: FormStep,
  values: Record<string, unknown>,
  channel: ConsentChannel,
): string | null {
  const fieldType = channel === "email" ? "email" : "phone";
  for (const f of step.fields) {
    if (f.type !== fieldType || !isFieldVisible(f, values)) continue;
    const subject = normalizeConsentSubject(channel, values[f.name]);
    if (subject) return subject;
  }
  return null;
}

/**
 * Combine `renderedChannelsForStep` with a caller's claimed tick state into
 * the decisions actually worth recording.
 *
 * THIS IS THE FORGERY FENCE. `requested` is untrusted client input
 * (body.consent_ledger in the submit route) — a channel named there that the
 * step does not render is simply never looked at, because the loop only
 * ever iterates `renderedChannelsForStep`'s own output. A channel the step
 * DOES render gets exactly the boolean `requested` supplied for it (missing
 * or non-`true` means unticked, never a throw and never a default to
 * "ticked" — an absent/malformed claim must read as "did not consent").
 *
 * EACH DECISION BINDS TO THE DESTINATION ON THAT STEP. `subject` is the
 * normalised email/number the step's own field holds — the address the
 * visitor was agreeing about. Consent is never a property of the LEAD: an
 * anonymous submission can smart-match an existing lead by business name
 * alone (app/api/forms/submit/route.ts initAnonymousLead), so a lead-keyed
 * tick would let a stranger's "yes" authorise texts to the real customer's
 * number. The send gate matches on subject, never on lead.
 */
export function consentDecisionsForStep(
  step: FormStep,
  values: Record<string, unknown>,
  requested: Partial<Record<ConsentChannel, unknown>>,
): Array<{ channel: ConsentChannel; ticked: boolean; subject: string | null }> {
  return renderedChannelsForStep(step, values).map((channel) => ({
    channel,
    ticked: requested[channel] === true,
    subject: stepSubjectFor(step, values, channel),
  }));
}
