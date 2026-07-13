/**
 * lib/drips/html-email.ts — build the HTML alternative part for a drip email so
 * it carries an open-tracking pixel + click-tracked links + a CASL/RFC-8058
 * unsubscribe footer, WITHOUT changing the plain-text part (which stays the
 * already-sanitized fallback and is what the positioning guard ran over).
 *
 * The plain-text body is escaped, its bare http(s) links are rewritten through
 * /api/track/click/<sendId> (so a click both logs and advances the lead), and a
 * 1x1 pixel to /api/track/open/<sendId> is appended. `sendId` MUST equal the
 * lead_interactions row id the executor writes for this send — that is the key
 * both track routes resolve tenant_id + lead_id from (never trusting the URL).
 *
 * HMAC: click targets are signed with OASIS_UNSUBSCRIBE_HMAC_SECRET (reused —
 * same secret the /api/unsubscribe token uses). A validly-signed target is
 * trusted for redirect; unsigned/foreign targets fall back to a host allowlist
 * in the click route (fail-closed). Unsubscribe tokens match the exact scheme
 * /api/unsubscribe/route.ts verifies: HMAC-SHA256(email|brand) sliced to 16 hex.
 */

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// The brand string MUST resolve to the SunBiz tenant in /api/unsubscribe's
// resolveTenantId (matches tenants.name ILIKE 'SunBiz') or the recorded
// suppression carries tenant_id=NULL and the drip's checkEmailSuppressed
// (tenant-scoped) never honors it. Verified: tenants.name='SunBiz'.
const SUNBIZ_BRAND = "SunBiz";

function appBase(): string {
  return (process.env.PUBLIC_APP_URL || "https://oasisai.work").replace(/\/+$/, "");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decode a base64url string. Throws on malformed input (caller catches). */
export function b64urlDecode(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** HMAC of the (already-encoded) click target, 32 hex chars. Empty string when
 *  no secret is configured — the link is still wrapped, but the click route can
 *  only trust it via the host allowlist, never the signature. */
export function signClickTarget(uEncoded: string): string {
  const secret = process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET;
  if (!secret) return "";
  return createHmac("sha256", secret).update(uEncoded).digest("hex").slice(0, 32);
}

/** Constant-time verify of a click-target signature. False when unconfigured or
 *  mismatched — the route then falls back to its host allowlist (fail-closed). */
export function verifyClickTarget(uEncoded: string, sig: string): boolean {
  const secret = process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET;
  if (!secret || !sig) return false;
  const expected = createHmac("sha256", secret).update(uEncoded).digest("hex").slice(0, 32);
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function pixelUrl(sendId: string): string {
  return `${appBase()}/api/track/open/${encodeURIComponent(sendId)}`;
}

export function clickUrl(sendId: string, target: string): string {
  const u = b64urlEncode(target);
  const s = signClickTarget(u);
  const base = `${appBase()}/api/track/click/${encodeURIComponent(sendId)}?u=${u}`;
  return s ? `${base}&s=${s}` : base;
}

/** Unsubscribe URL matching /api/unsubscribe's token scheme. Email is lowercased
 *  in BOTH the token and the query param because the route lowercases before it
 *  verifies HMAC(email|brand). */
export function unsubscribeUrl(email: string, brand: string = SUNBIZ_BRAND): string {
  const lower = email.trim().toLowerCase();
  const secret = process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET;
  const qs = new URLSearchParams({ email: lower, brand });
  if (secret) {
    const token = createHmac("sha256", secret).update(`${lower}|${brand}`).digest("hex").slice(0, 16);
    qs.set("token", token);
  }
  return `${appBase()}/unsubscribe?${qs.toString()}`;
}

/** RFC 8058 List-Unsubscribe header value (one-click URL + mailto fallback). */
export function listUnsubscribeHeader(email: string, brand: string = SUNBIZ_BRAND): string {
  return `<${unsubscribeUrl(email, brand)}>, <mailto:submissions@sunbizfunding.com?subject=unsubscribe>`;
}

/**
 * Build the HTML alternative for a drip email from its plain-text body.
 * `plain` is the ALREADY-SANITIZED text (positioning guard has run). Bare
 * http(s) URLs become click-tracked anchors; everything else is HTML-escaped.
 */
export function buildDripHtml(plain: string, opts: { sendId: string; email: string; brand?: string }): string {
  const { sendId, email } = opts;
  const brand = opts.brand || SUNBIZ_BRAND;

  const urlRe = /(https?:\/\/[^\s<>"')]+)/g;
  let out = "";
  let last = 0;
  for (const m of plain.matchAll(urlRe)) {
    const idx = m.index ?? 0;
    out += escapeHtml(plain.slice(last, idx));
    const target = m[0];
    out += `<a href="${escapeHtml(clickUrl(sendId, target))}" style="color:#0B1F4F;text-decoration:underline;">${escapeHtml(target)}</a>`;
    last = idx + target.length;
  }
  out += escapeHtml(plain.slice(last));
  const bodyHtml = out.replace(/\n/g, "<br />\n");

  const pixel = `<img src="${escapeHtml(pixelUrl(sendId))}" width="1" height="1" alt="" style="display:none;max-height:0;overflow:hidden;" />`;
  const footer =
    `<div style="margin-top:24px;color:#8a94a6;font-size:12px;line-height:1.5;">` +
    `If you would prefer not to receive these, you can ` +
    `<a href="${escapeHtml(unsubscribeUrl(email, brand))}" style="color:#8a94a6;">unsubscribe here</a>.` +
    `</div>`;

  return (
    `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;">` +
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:600px;">` +
    `${bodyHtml}${footer}</div>${pixel}</body></html>`
  );
}
