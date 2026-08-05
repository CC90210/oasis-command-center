/**
 * lib/email/brand-shell.ts — the brand-identifying footer that every commercial
 * drip email carries.
 *
 * Pure, and deliberately NOT "server-only", so the thing that satisfies a legal
 * requirement is directly testable. Same split drip-rules-core.ts has from
 * governor.ts. lib/email/tracked-html.ts imports this and renders it.
 *
 * WHAT THIS CLOSES: the 2026-08-05 audit checked all 29 live drip email steps,
 * every copy variant included, and found ZERO carrying a physical postal
 * address. CAN-SPAM 15 U.S.C. 7704(a)(5) requires one in every commercial email.
 * The unsubscribe half was already handled — a visible footer link plus both RFC
 * 8058 headers — but the address half was handled nowhere on the drip path.
 * SUNBIZ_LEGAL_FOOTER in lib/config/email-signature.ts holds the right address
 * and is imported only by the per-rep direct senders.
 *
 * It lives in the SHELL rather than in the copy on purpose. Copy is written by
 * whoever is writing templates that week; a legal requirement that depends on
 * every author remembering it is a requirement that will eventually be missed.
 */

import { getBrand, resolveBrandKey, type BrandKey } from "./brands";

/** Escape for HTML text and attribute contexts. Mirrors tracked-html's escaper
 *  rather than importing it, because that module is server-only. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The footer block: sending entity, its physical postal address, and the
 * unsubscribe link when the message is commercial.
 *
 * `unsubscribeHref` of null omits the unsubscribe line (transactional mail).
 * The ADDRESS is emitted either way: it costs nothing, and misclassifying
 * commercial mail as transactional is a far more likely mistake than the
 * reverse, so the safe default is to always identify the sender.
 */
export function brandFooter(brand: BrandKey | undefined, unsubscribeHref: string | null): string {
  const b = getBrand(resolveBrandKey(brand));
  const unsubLine = unsubscribeHref
    ? `<div style="margin-bottom:8px;">If you would prefer not to receive these, you can ` +
      `<a href="${esc(unsubscribeHref)}" style="color:#8a94a6;">unsubscribe here</a>.</div>`
    : "";
  return (
    `<div style="margin-top:24px;padding-top:14px;border-top:1px solid #e7ebf1;` +
    `color:#8a94a6;font-size:12px;line-height:1.5;">` +
    unsubLine +
    `<div>${esc(b.legalName)}</div>` +
    `<div>${esc(b.postalAddress)}</div>` +
    `</div>`
  );
}
