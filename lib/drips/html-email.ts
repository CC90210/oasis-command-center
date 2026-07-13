/**
 * lib/drips/html-email.ts — moved to lib/email/tracked-html.ts (now shared by
 * drips + cold outreach + submissions@). This file re-exports for the existing
 * import sites (drip executor, /api/track/click route) so they keep working.
 * Prefer importing from "@/lib/email/tracked-html" in new code.
 */

export {
  SUNBIZ_BRAND,
  escapeHtml,
  b64urlDecode,
  signClickTarget,
  verifyClickTarget,
  pixelUrl,
  clickUrl,
  unsubscribeUrl,
  listUnsubscribeHeader,
  buildTrackedHtml,
  buildDripHtml,
  type UnsubMode,
} from "@/lib/email/tracked-html";
