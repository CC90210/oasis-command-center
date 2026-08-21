/**
 * lib/web-leads/url-safety.ts — turns a raw, untrusted `websiteUrl` into
 * something safe to put in an `<a href>`, or null.
 *
 * Two independent problems, both found in the live 27,000-row data by an
 * independent review of the Task 4 panel (2026-08-21):
 *
 * 1. BARE DOMAINS NAVIGATE INSIDE OUR OWN APP. 217 of the stored website
 *    values have no scheme (e.g. "whitfield.co"). A bare string in an
 *    `href` is treated as app-RELATIVE, so clicking "View website" would
 *    navigate inside our own dashboard instead of out to the prospect's
 *    site -- exactly when a rep is mid-call and about to use it.
 * 2. NO SCHEME ALLOWLIST. These values come from OpenStreetMap, which
 *    anyone on the internet can edit, and we ingest ~27,000 of them
 *    automatically with no human review. Zero dangerous URLs exist in the
 *    data today, but that is a fact about today's snapshot, not a control:
 *    a `javascript:` value in that field would execute in our app's
 *    origin the instant a rep clicked the link. Allowlisting http/https
 *    (rather than denylisting javascript:/data:/etc.) is what keeps this
 *    closed against schemes nobody has thought of yet.
 *
 * Used anywhere this panel turns a lead's `websiteUrl` into a clickable
 * link. Callers must render nothing (not a disabled/dead link) when this
 * returns null -- a missing button is honest, a broken or dangerous one
 * is not.
 */

export function safeExternalUrl(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // A bare domain in an href is app-RELATIVE, so it navigates inside our own
  // dashboard instead of out to the prospect. 217 of our stored websites are
  // bare domains.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    // Allowlist, not denylist. These URLs come from a public map that anyone
    // can edit, and a javascript: href would run in our origin the instant a
    // rep clicks it -- stored XSS delivered through a link.
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}
