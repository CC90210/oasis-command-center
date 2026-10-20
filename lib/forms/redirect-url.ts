/**
 * lib/forms/redirect-url.ts: the only places a public form may send a visitor.
 *
 * A form's redirect_url is typed by the workspace that owns the form, and the
 * public page opens it with `window.location.href` after the last step
 * (components/forms/FormPublicClient.tsx). A `javascript:` or `data:` value
 * there runs script in this site's origin for every visitor who submits,
 * signed-in operators included: stored XSS (2026-10-19 audit). So a redirect
 * is an absolute http(s) URL or a path on this site, nothing else. The save
 * routes refuse anything else, and the public page ignores anything else that
 * is already stored.
 *
 * A bare domain ("example.com/thanks") gets https:// in front, as
 * lib/web-leads/url-safety.ts safeExternalUrl does: as typed, the browser would
 * read it as a path under the form page itself.
 */
import { isSafeInternalPath } from "@/lib/offers/preserve-query";

export function safeFormRedirect(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;

  if (value.startsWith("/") || value.startsWith("\\")) {
    // A path on this site: the same check the offer routers use. It refuses
    // "//", any backslash and any tab, newline or other control character,
    // which the URL parser would drop or turn into "/" to reach another host.
    // The value is kept exactly as typed. Rewriting it to the parser's
    // pathname is what made "/.//evil.example/x" into "//evil.example/x", a
    // link to another site (independent review of #710); as typed, the
    // browser resolves it on this site.
    return isSafeInternalPath(value) ? value : null;
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The longest redirect a form may store, as the save routes always capped it. */
const MAX_REDIRECT_CHARS = 2000;

/**
 * A redirect_url as the save routes receive it in a request body.
 *
 * - Clear: null, undefined, or an empty or blank string.
 * - A string: checked by safeFormRedirect.
 * - Anything else is invalid. That covers `["example.com"]`, which String()
 *   would have turned into an accepted address, and `false`, which used to
 *   clear the redirect silently (CodeRabbit on #710).
 */
export function parseRedirectInput(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  if (!raw.trim()) return { ok: true, value: null };
  const value = safeFormRedirect(raw.slice(0, MAX_REDIRECT_CHARS));
  return value ? { ok: true, value } : { ok: false };
}
