/**
 * lib/config/email-signature.ts — the per-rep signature block + legal footer
 * for the DIRECT (operator-Gmail) email paths.
 *
 * WHY THIS EXISTS (2026-07-10)
 * ----------------------------
 * The shared submissions@ queue path signs emails on the VPS: send_gateway /
 * dashboard_email_consumer wrap the body in branded HTML and append the acting
 * rep's signature + the CASL/CAN-SPAM footer. The direct per-rep Gmail paths
 * (gmail-apppassword-send.ts, gmail-oauth-send.ts) bypass the VPS entirely —
 * and until now each carried its OWN hardcoded footer with NO rep signature
 * and a DIFFERENT street address ("1 East Broward Blvd" — ported from JARVIS)
 * than the CC-confirmed legal address every other surface uses. So Jordan's
 * direct sends went out from jordan@… with no name and a wrong address, while
 * her queued sends signed "— Jordan" with the right one.
 *
 * This module is the single source of truth both direct senders import:
 *   - SUNBIZ_LEGAL_FOOTER — canonical legal footer. The address matches
 *     send_gateway.BRAND_IDENTITY["sunbiz"].business_address (CEO-Agent repo,
 *     provenance: CC provided it 2026-06-17) and the generated templates.
 *     If SunBiz's legal address ever changes, update BRAND_IDENTITY first,
 *     then this constant.
 *   - appendSignatureAndFooter() — trims the body, appends "— {name}"
 *     (+ phone when the roster has one), then the footer. Skips the name
 *     line when the operator already signed (same idempotency rule as the
 *     VPS consumer's _footer_already_present), so a hand-signed or re-sent
 *     body is never double-signed.
 *
 * Like the footers it replaces, this is SunBiz-scoped: both direct senders
 * are de-facto SunBiz-only today (their footer was already hardcoded). When
 * a second tenant gets per-rep Gmail sends, brand-route this the way
 * send_gateway.BRAND_IDENTITY does instead of adding another constant.
 */

import { resolveSignerForOperator } from "@/lib/config/agents";
import type { BrandKey } from "@/lib/email/brands";

export type EmailSigner = { name: string; email?: string; phone?: string };

export const SUNBIZ_LEGAL_FOOTER =
  "\n\n---\nSunBiz Funding LLC\n221 W Hallandale Beach Blvd, Suite 518\nHallandale, FL 33009\n\n" +
  "You received this email because you submitted a funding inquiry. To stop receiving emails, reply UNSUBSCRIBE.";

/**
 * Append the rep's sign-off + the legal footer to an outbound body.
 *
 * `signer` is the resolved acting rep (route-side session resolution wins —
 * a rep may connect a personal Gmail whose address isn't in the roster).
 * When omitted, self-resolves from `fromAddress` via the roster so callers
 * without a session (the scheduled-send cron) still sign correctly.
 */
/**
 * Brand-routed legal footers.
 *
 * This module's own header anticipated the moment we reached on 2026-09-08:
 * "when a second tenant gets per-rep Gmail sends, brand-route this the way
 * send_gateway.BRAND_IDENTITY does". CC asked for exactly that, OASIS sends
 * leaving through a shared app-password mailbox instead of the bridge, and the
 * SunBiz footer was about to be appended to OASIS prospect emails: a Florida
 * address, another company's name, and the sentence "you received this email
 * because you submitted a funding inquiry", which is simply false for a cold
 * OASIS lead.
 *
 * The OASIS wording mirrors send_gateway.BRAND_IDENTITY["oasis"] so a message
 * reads the same whichever path sends it. Two footers that disagree are worse
 * than one that is merely wrong, because only one of them ever gets reviewed.
 */
/**
 * EXHAUSTIVE over BrandKey, deliberately.
 *
 * This was `Record<string, string>` with two entries and a `?? SUNBIZ_LEGAL_FOOTER`
 * tail, which meant a brand with no entry silently borrowed SunBiz's legal
 * identity. Bluerise was in exactly that state: every Bluerise send through
 * this helper appended "SunBiz Funding LLC ... you submitted a funding inquiry".
 *
 * `Record<BrandKey, string>` makes the compiler refuse a new brand until
 * somebody decides what it says. The consent sentence is per-brand rather than
 * derived, because it states WHY this recipient is being contacted — a cold
 * OASIS prospect did not submit a funding inquiry — and that is a factual
 * claim, not a formatting choice.
 *
 * The identity lines are checked against lib/email/brands.ts by
 * tests/brand-identity-coherence.test.ts, which asserts that each brand's
 * footer names its OWN legal entity and no other brand's — so the name and
 * address here cannot drift from the registry that picks the sending
 * credential. (That file name was wrong in the first version of this comment:
 * it cited tests/brand-footer-coherence.test.ts, which does not exist. Citing
 * a guard that was never built is the same defect as skills/email-safety
 * claiming --brand is required and validated, which it never was.)
 */
const BRAND_FOOTERS: Record<BrandKey, string> = {
  sunbiz: SUNBIZ_LEGAL_FOOTER,
  // Street address supplied by CC 2026-09-09. Until then this said only
  // "OASIS AI Solutions, Montreal, QC, Canada" — no street, which is an
  // incomplete CASL s.6(2) identification on every commercial email OASIS
  // sends. Laid out name / street / city-postal to match the SunBiz footer
  // above, so the two read as the same kind of document.
  oasis:
    "\n\n---\nOASIS AI Solutions\n6993 Decarie Blvd\nMontreal, QC H3W 0B5, Canada\n\n" +
    "You received this email because we reached out about your business. " +
    "To stop receiving emails, reply UNSUBSCRIBE.",
  bluerise:
    "\n\n---\nBluerise Business Capital LLC\n221 W Hallandale Beach Blvd, Suite 518\n" +
    "Hallandale, FL 33009\n\n" +
    "You received this email because you submitted a funding inquiry. " +
    "To stop receiving emails, reply UNSUBSCRIBE.",
};

export function appendSignatureAndFooter(
  body: string,
  /**
   * `brand` is REQUIRED as of 2026-09-09. It was optional, and the resolution
   * line below was `BRAND_FOOTERS[(opts.brand || "sunbiz")...] ?? SUNBIZ_LEGAL_FOOTER`
   * — two independent fail-opens in one expression, so a caller that simply
   * forgot the argument stamped SunBiz Funding LLC's name, Florida address and
   * "you submitted a funding inquiry" onto an OASIS cold email. Two live
   * callers were in exactly that state (gmail-apppassword-send, gmail-oauth-send).
   *
   * Making it required means the compiler, not a reviewer, finds the next one.
   */
  opts: { signer?: EmailSigner | null; fromAddress?: string; brand: BrandKey },
): string {
  const trimmed = body.replace(/\s+$/, "");
  // THE BRAND HAS TO REACH THE FALLBACK TOO.
  //
  // This resolved the signer with no brand, so a caller that passed
  // `brand: "oasis"` but no explicit signer got the OASIS footer with the other
  // portal's shared name above it — the same two-companies-in-one-message
  // defect, arriving through the back door. Threading opts.brand closes it for
  // every present and future caller rather than for the one route that was
  // reported.
  const signer = opts.signer ?? resolveSignerForOperator(opts.fromAddress, { brand: opts.brand });
  const name = (signer?.name || "").trim();

  // NO EM DASH. This sign-off is appended to EVERY outbound email, so the one
  // character here was the most-sent em dash in the system. A name on its own
  // line is how a person signs off; "— Jordan" reads as machine-written, which
  // is the last impression a cold email should leave. (CC, 2026-09-08.)
  //
  // Idempotency has to cover BOTH shapes now. The legacy "— Jordan" still
  // appears in bodies drafted before this change and in anything an operator
  // typed by hand, and missing it would sign those twice. The new shape is
  // matched only as the LAST line of the body: a bare `includes(name)` would
  // false-positive on a body that merely mentions the rep by name mid-sentence
  // and would then send it unsigned.
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim();
  const alreadySigned =
    !!name && (trimmed.includes(`— ${name}`) || lastLine === name);

  let signature = "";
  if (name && !alreadySigned) {
    signature = `\n\n${name}`;
    const phone = (signer?.phone || "").trim();
    if (phone) signature += `\n${phone}`;
  }
  // No fallback. `brand` is required and `BRAND_FOOTERS` is exhaustive over
  // BrandKey, so there is no path here that can reach for another company's
  // legal identity. An invalid value at runtime (untyped JS caller, bad JSON)
  // throws rather than defaulting — a commercial email must not go out
  // attributed to whoever happens to be first in the table.
  const footer = BRAND_FOOTERS[opts.brand];
  if (!footer) {
    throw new Error(
      `appendSignatureAndFooter: no footer for brand ${JSON.stringify(opts.brand)}. ` +
        "Refusing to substitute another company's legal identity.",
    );
  }
  return trimmed + signature + footer;
}
