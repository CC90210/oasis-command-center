/**
 * The Ask composer's hand-off to the Chief of Staff channel (plan D2).
 *
 * Today's composer does not post anywhere itself: channels arrive with plan W4.
 * It opens the Chief of Staff department with the typed text in the URL, and
 * the department page prefills its composer from that parameter. One name for
 * the parameter, declared here, so the two sides cannot drift:
 *
 *   /team/chief-of-staff?q=Follow%20up%20with%20the%20three%20proposals
 *
 * app/team/[dept]/page.tsx reads it as `?q=` (capped at 2,000 characters) and
 * prefills the channel's message box; it never sends it on the viewer's
 * behalf. Change the name in both places or neither.
 *
 * Zero imports, so the client composer and any server page can share it.
 */

/** Query parameter the department page prefills its composer from. */
export const ASK_PREFILL_PARAM = "q";

/**
 * Longest text carried in the URL. Keeps the link well under the 8 KB request
 * line most proxies accept once percent-encoded; a longer brief belongs in the
 * channel, not in a query string.
 */
export const ASK_MAX_CHARS = 1500;

/** `href` with the trimmed, capped text as the prefill parameter; `href` alone when empty. */
export function askPrefillHref(href: string, text: string): string {
  const body = text.trim().slice(0, ASK_MAX_CHARS);
  if (!body) return href;
  const sep = href.includes("?") ? "&" : "?";
  return `${href}${sep}${ASK_PREFILL_PARAM}=${encodeURIComponent(body)}`;
}
