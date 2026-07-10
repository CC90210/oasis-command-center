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
export function appendSignatureAndFooter(
  body: string,
  opts: { signer?: EmailSigner | null; fromAddress?: string },
): string {
  const trimmed = body.replace(/\s+$/, "");
  const signer = opts.signer ?? resolveSignerForOperator(opts.fromAddress);
  const name = (signer?.name || "").trim();

  // Idempotency: an operator who typed "— Jordan" (or an already-signed
  // re-send) must not get a second sign-off.
  const alreadySigned = !!name && trimmed.includes(`— ${name}`);

  let signature = "";
  if (name && !alreadySigned) {
    signature = `\n\n— ${name}`;
    const phone = (signer?.phone || "").trim();
    if (phone) signature += `\n${phone}`;
  }
  return trimmed + signature + SUNBIZ_LEGAL_FOOTER;
}
