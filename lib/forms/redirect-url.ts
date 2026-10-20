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

const SAME_SITE = "https://same-site.invalid";

export function safeFormRedirect(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;

  if (value.startsWith("/") || value.startsWith("\\")) {
    // A path on this site, as the URL parser reads it: it drops tabs and
    // newlines and turns "\" into "/", so "/\t/evil.example" and
    // "/\evil.example" are another host ("//evil.example") and are refused.
    try {
      const u = new URL(value, SAME_SITE);
      return u.origin === SAME_SITE ? `${u.pathname}${u.search}${u.hash}` : null;
    } catch {
      return null;
    }
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
