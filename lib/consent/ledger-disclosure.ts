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
export const CONSENT_DISCLOSURE_VERSION = "occ-ledger-v2-2026-10-16";
// v2 (2026-10-16, CC: "remove the text ... just make it a clickable link ... or
// drops it down"): the WORDING below is unchanged; the PRESENTATION changed.
// Each box now shows consentSummaryText (who, what, how to stop) and the full
// disclosure sits one click away under "Full terms", still in the page and
// tied to the box (aria-describedby). Rows stamped v2 were recorded under that
// presentation; v1 rows were shown the full text inline.

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

/**
 * The line shown beside each consent box (v2 presentation): who is asking,
 * what for, and how to stop, in one sentence. The full disclosure
 * (consentDisclosureText: the address, the privacy policy, "not a condition")
 * is one click away under "Full terms". The SMS line keeps "Msg & data rates
 * may apply" and "reply STOP" in plain view, as carrier rules expect at the
 * opt-in itself.
 */
export function consentSummaryText(channel: ConsentChannel, identity: ConsentIdentity): string {
  const { businessName } = identity;
  if (channel === "email") {
    return `Yes, ${businessName} may email me about my enquiry and related offers. I can unsubscribe at any time.`;
  }
  return (
    `Yes, ${businessName} may text my mobile about my enquiry and related offers, including automated texts. ` +
    `Msg & data rates may apply; reply STOP to opt out.`
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

// One plain mailbox, nothing a mail library could read as a second recipient,
// a display name, a comment or a route: no whitespace, comma, semicolon,
// colon, angle bracket, parenthesis, square bracket, quote or backslash.
const EMAIL_SHAPE = /^[^\s@,;:<>()[\]"\\]+@[^\s@,;:<>()[\]"\\]+\.[^\s@,;:<>()[\]"\\]+$/;
// Digits plus the separators people actually type. A letter (an "ext 22")
// makes the number ambiguous, so it is refused rather than guessed at.
const PHONE_SHAPE = /^\+?[\d\s().-]+$/;

/**
 * The ONE canonical form of a destination. Consent is stored under it, the
 * send gate looks it up under it, and the gate hands it back as the only
 * address a sender may use (lib/consent/marketing-send-gate.ts) — so there is
 * no second parser anywhere that could read the same input as a different
 * recipient from the one that consented.
 *
 * Email: trimmed, lowercased, exactly one plain mailbox (EMAIL_SHAPE).
 * SMS: E.164. A leading "+" keeps its country code; otherwise a 10-digit
 * number, or an 11-digit one starting with 1, is North American (+1), which
 * is the region these forms collect in. Anything else is ambiguous and
 * answers null — and a null subject can never authorise a send.
 */
export function normalizeConsentSubject(channel: ConsentChannel, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (channel === "email") {
    const email = trimmed.toLowerCase();
    return email.length <= 254 && EMAIL_SHAPE.test(email) ? email : null;
  }
  if (!PHONE_SHAPE.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** The value THIS submission's own visible field of this channel's type holds. */
function stepSubjectFor(
  step: FormStep,
  visibility: Record<string, unknown>,
  stepPayload: Record<string, unknown>,
  channel: ConsentChannel,
): string | null {
  const fieldType = channel === "email" ? "email" : "phone";
  for (const f of step.fields) {
    if (f.type !== fieldType || !isFieldVisible(f, visibility)) continue;
    const subject = normalizeConsentSubject(channel, stepPayload[f.name]);
    if (subject) return subject;
  }
  return null;
}

/**
 * Combine `renderedChannelsForStep` with a caller's claimed tick state into
 * the decisions actually worth recording.
 *
 * THIS IS THE FORGERY FENCE. `requested` is untrusted client input
 * (body.consent_ledger in the submit route). A channel is recorded only when
 * BOTH sides agree a box was on screen: the step's own fields render it
 * (renderedChannelsForStep — a forged extra channel is never looked at) AND
 * the client sent an answer for it (the page sends a key only for a box it
 * drew). Without the second half, a page whose visibility rules read the
 * answers differently from the server would leave the server recording
 * "shown and declined" for a disclosure nobody saw. The answer itself counts
 * as ticked only when it is exactly `true`; anything else is a decline.
 *
 * EACH DECISION BINDS TO THE DESTINATION THIS SUBMISSION TYPED. `subject`
 * comes from `stepPayload` — what was submitted on this step — never from
 * answers merged in from earlier submissions, which could bind a tick to an
 * address the visitor did not enter here. `visibility` (the merged answers)
 * is used only to decide which fields were showing. Consent is never a
 * property of the LEAD: an anonymous submission can smart-match an existing
 * lead by business name alone (app/api/forms/submit/route.ts
 * initAnonymousLead), so a lead-keyed tick would let a stranger's "yes"
 * authorise texts to the real customer's number.
 */
export function consentDecisionsForStep(
  step: FormStep,
  visibility: Record<string, unknown>,
  stepPayload: Record<string, unknown>,
  requested: Partial<Record<ConsentChannel, unknown>>,
): Array<{ channel: ConsentChannel; ticked: boolean; subject: string | null }> {
  return renderedChannelsForStep(step, visibility)
    .filter((channel) => Object.prototype.hasOwnProperty.call(requested, channel))
    .map((channel) => ({
      channel,
      ticked: requested[channel] === true,
      subject: stepSubjectFor(step, visibility, stepPayload, channel),
    }));
}
