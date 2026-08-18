/**
 * lib/sms/lawful-basis.ts — may we lawfully TEXT this person?
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE SAME AS THE EMAIL RULE.
 *
 * Adon's routing rule (2026-08-10) is: email whoever has an email, text whoever
 * only has a number. That is right operationally and wrong legally if applied
 * without this file, because the two channels sit under different law:
 *
 *   EMAIL (CAN-SPAM)  no prior permission needed. Honest headers, a real postal
 *                     address, a working unsubscribe. That is the whole bar.
 *   TEXT  (TCPA)      prior express consent for marketing to a mobile. $500 per
 *                     message, $1,500 if wilful, no cap, and a private right of
 *                     action. Florida adds its own statute on top, which matters
 *                     because SunBiz works Florida merchants.
 *
 * So the channel fallback silently converts a message that needed NO permission
 * into one that DOES. Without a basis check, "we have their number so text
 * them" turns 359 leads we cannot prove consent for into 359 potential claims.
 *
 * WHAT COUNTS, STRONGEST FIRST:
 *
 *   consent_artifact  A sealed Opt-in Vault record: the exact disclosure they
 *                     saw, the affirmative action, timestamp, and source IP.
 *                     This is the only tier that is genuinely provable. It
 *                     began 2026-08-09 and therefore covers new form leads only.
 *
 *   inquiry           They came to US and asked for funding — our own public
 *                     form or a started application. A text responding to their
 *                     own enquiry is defensible on an established business
 *                     relationship. Weaker than an artifact because we cannot
 *                     reproduce the wording they were shown, but it is a real
 *                     relationship with a real record of them initiating it.
 *
 *   none              A purchased list or a cold-dialled number. Whoever sold
 *                     the list may hold consent; we do not, and we cannot
 *                     produce it. Measured 2026-08-10 this is 240 purchased
 *                     phone-only leads plus 119 cold-called — every one of them
 *                     phone-only, which is precisely why the fallback would
 *                     otherwise route them all into SMS.
 *
 * Pure and free of "server-only" so the rule that decides whether a real person
 * gets a text is directly testable.
 */

export type LawfulBasis = "consent_artifact" | "inquiry" | "none";

export type BasisVerdict = {
  basis: LawfulBasis;
  /** May we send a MARKETING text on this basis? */
  mayText: boolean;
  reason: string;
};

/**
 * Lead sources that represent the merchant approaching US. Kept explicit rather
 * than inferred: a new source name must be classified deliberately, because the
 * default has to be "we cannot prove anything".
 */
const INQUIRY_SOURCES = new Set([
  "public_form",
  "dropped_application",
  "inbound_form",
  "referral",
  "website",
  // Live Subs. These merchants COMPLETED AND SIGNED a SunBiz application; it
  // reached us through Breeze rather than through our own form, and was then
  // keyed in by hand, which is the only reason the source string differs.
  //
  // Adon, 2026-08-14, asked directly about consent: "We do have consent to
  // reach them because they agreed upon the application that we have from
  // them. They were just funneled through breeze when they signed our
  // application."
  //
  // Same basis `dropped_application` already carries — someone who started our
  // application is an inbound enquiry — and a stronger version of it, since
  // these finished and signed.
  //
  // WHAT WE DO NOT HAVE, stated plainly because this entry rests on it: no
  // sealed consent receipt exists for any of the 86 (measured 2026-08-17,
  // sealed_consent=0 across all 60 with phones). The provable tier above is
  // `consent_receipt.consent_id`, and until a copy of the signed application is
  // attached to these records the basis here is an asserted relationship, not
  // an artifact we could produce on demand. Getting those signatures filed
  // against the leads is the thing that would make this provable rather than
  // relied upon.
  "breeze_uw_sheet",
  // A SunBiz web form, filled in by the merchant. Adon, 2026-08-18: "none of
  // our leads are purchased. We generate our own leads." The batch name reads
  // like a vendor drop, which is why our own BUILTIN_COLD list had it flagged
  // as purchased — that was our mistake, not a property of the lead.
  //
  // Same basis as public_form: they approached us. Measured 2026-08-18, this
  // one string was blocking 239 phone-only merchants from being contacted on
  // the only channel they have.
  "mca webforms may 25-29",
]);

function normalise(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

/**
 * Determine the basis for texting this lead.
 *
 * FAILS CLOSED. An unrecognised source is `none`, never a guess in our favour.
 * The cost of a wrong "yes" is a statutory claim; the cost of a wrong "no" is
 * an email instead of a text.
 */
export function smsLawfulBasis(data: Record<string, unknown>): BasisVerdict {
  // A sealed vault receipt is the only provable tier. `claimed_captured` alone
  // is a client assertion, so it does NOT qualify — see the consent receipt
  // shape in app/api/forms/submit.
  const receipt = data.consent_receipt as Record<string, unknown> | undefined;
  if (receipt && receipt.claimed_captured === true && typeof receipt.consent_id === "string" && receipt.consent_id) {
    return {
      basis: "consent_artifact",
      mayText: true,
      reason: `sealed consent record ${String(receipt.consent_id).slice(0, 18)}`,
    };
  }

  const source = normalise(data.source);
  if (INQUIRY_SOURCES.has(source)) {
    return {
      basis: "inquiry",
      mayText: true,
      reason: `merchant approached us via ${source}; responsive contact on an established relationship`,
    };
  }

  return {
    basis: "none",
    mayText: false,
    reason: source
      ? `no consent record and "${source}" is not an inbound enquiry`
      : "no consent record and no identifiable source",
  };
}

/**
 * Is this specific send lawful on this basis?
 *
 * Split from the basis itself because the answer differs by what we are
 * sending. A purely transactional message to someone mid-application (their
 * documents, their signature, their offer) is not marketing and does not carry
 * the same exposure as a promotional blast.
 */
export function mayTextFor(
  data: Record<string, unknown>,
  purpose: "marketing" | "transactional",
): BasisVerdict {
  const v = smsLawfulBasis(data);
  if (v.mayText) return v;
  if (purpose === "transactional") {
    return {
      basis: v.basis,
      mayText: true,
      reason: "transactional message about work already in progress, not a solicitation",
    };
  }
  return v;
}
