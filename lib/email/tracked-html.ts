/**
 * lib/email/tracked-html.ts — build the HTML alternative part for ANY first-party
 * email (drip, cold outreach, submissions@) so it carries an open-tracking pixel
 * + click-tracked links + an optional CASL/RFC-8058 unsubscribe footer, WITHOUT
 * changing the plain-text part (which stays the already-sanitized fallback the
 * positioning guard ran over).
 *
 * The plain-text body is escaped, its bare http(s) links are rewritten through
 * /api/track/click/<sendId>, and a 1x1 pixel to /api/track/open/<sendId> is
 * appended. `sendId` MUST equal the lead_interactions row id the SENDER writes
 * for this send — that is the key both track routes resolve tenant_id + lead_id
 * from (never trusting the URL).
 *
 * `unsub` controls the VISIBLE in-body footer only:
 *   - 'footer' (default) → commercial mail: a minimal "unsubscribe here" link.
 *   - 'none'             → transactional/relationship mail (CAN-SPAM opt-out
 *                          exempt): NO visible link. The caller still decides
 *                          whether to emit the invisible List-Unsubscribe header
 *                          (kept for deliverability even on transactional mail).
 *
 * HMAC: click targets are signed with OASIS_UNSUBSCRIBE_HMAC_SECRET (reused —
 * same secret the /api/unsubscribe token uses). A validly-signed target is
 * trusted for redirect; unsigned/foreign targets fall back to a host allowlist
 * in the click route (fail-closed). Unsubscribe tokens match the exact scheme
 * /api/unsubscribe/route.ts verifies: HMAC-SHA256(email|brand) sliced to 16 hex.
 */

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveTrackingBase } from "./tracking-base";

// The brand string MUST resolve to the SunBiz tenant in /api/unsubscribe's
// resolveTenantId (matches tenants.name ILIKE 'SunBiz') or the recorded
// suppression carries tenant_id=NULL and checkEmailSuppressed (tenant-scoped)
// never honors it. Verified: tenants.name='SunBiz'.
export const SUNBIZ_BRAND = "SunBiz";

/**
 * SENDING-DOMAIN ALIGNMENT (2026-07-29).
 *
 * Drip mail goes out From submissions@sunbizfunding.com, but every URL inside it
 * — the open pixel, every click-wrapped link, the unsubscribe link and the
 * List-Unsubscribe header — was built on PUBLIC_APP_URL, which is oasisai.work.
 * A visible sender whose links all point at an unrelated domain is one of the
 * more reliable spam signals, because it is the shape phishing takes. It also
 * means sunbizfunding.com earns no reputation from opens or clicks while
 * carrying all of the complaint risk: the engagement accrues to the other domain.
 *
 * The base is therefore resolved PER BRAND, not globally. oasisai.work is the
 * platform domain and remains correct for everything that is not SunBiz mail, so
 * a blanket swap would misattribute other tenants' links.
 *
 * Set SUNBIZ_TRACKING_BASE_URL to a host on the sending domain (for example
 * https://go.sunbizfunding.com) that is added to this Vercel project and
 * CNAME'd to it. Middleware is path-based rather than host-based and
 * /api/track + /api/unsubscribe are both public, so the same routes serve
 * unchanged from the new hostname.
 *
 * UNSET IS TODAY'S BEHAVIOUR, EXACTLY. This is deliberate so the code can merge
 * before the DNS exists: nothing changes until the variable is set, and setting
 * it is the deploy.
 */
/**
 * WHICH DOMAIN a message's tracked URLs are built on.
 *
 * This is NOT derivable from `brand`. Brand is a SUPPRESSION key: it must be
 * "SunBiz" for anything whose unsubscribe should record against the SunBiz
 * tenant, including cold outreach, or the suppression lands with a null tenant
 * and is never honored. Sending IDENTITY is a different axis, and conflating
 * them is a real hazard: cold blasts deliberately send from isolated mailbox
 * domains precisely so their reputation cannot touch sunbizfunding.com, and
 * keying the tracking domain off brand would have moved their pixels and
 * unsubscribe links onto it (Codex review P1).
 *
 *  - "platform"  the shared platform origin (PUBLIC_APP_URL). THE DEFAULT, and
 *                today's behaviour for every caller. Correct for cold outreach,
 *                whose whole point is reputation isolation.
 *  - "aligned"   the sending domain for this brand. Opt in ONLY where the
 *                message is genuinely sent From that domain.
 *
 * Defaulting to "platform" is deliberate: a future caller that forgets to think
 * about this gets the safe, isolated behaviour rather than silently borrowing
 * the SunBiz sending domain.
 */
export type TrackingContext = "platform" | "aligned";

function trackingBaseFor(brand: string, ctx: TrackingContext): string | undefined {
  if (ctx !== "aligned") return undefined;
  if (brand === SUNBIZ_BRAND) return process.env.SUNBIZ_TRACKING_BASE_URL;
  return undefined;
}

/** Resolve the origin every tracked URL in a message is built on. Validation and
 *  the fail-safe fallback live in ./tracking-base so the click route's allowlist
 *  shares exactly the same logic and cannot drift from what mints the links. */
function appBase(brand: string = SUNBIZ_BRAND, ctx: TrackingContext = "platform"): string {
  const fallback = process.env.PUBLIC_APP_URL || "https://oasisai.work";
  return resolveTrackingBase(trackingBaseFor(brand, ctx), fallback);
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

export function pixelUrl(sendId: string, brand: string = SUNBIZ_BRAND, ctx: TrackingContext = "platform"): string {
  return `${appBase(brand, ctx)}/api/track/open/${encodeURIComponent(sendId)}`;
}

export function clickUrl(sendId: string, target: string, brand: string = SUNBIZ_BRAND, ctx: TrackingContext = "platform"): string {
  const u = b64urlEncode(target);
  const s = signClickTarget(u);
  const base = `${appBase(brand, ctx)}/api/track/click/${encodeURIComponent(sendId)}?u=${u}`;
  return s ? `${base}&s=${s}` : base;
}

/** Signed query string (email|brand|token) shared by the page + API unsub URLs.
 *  Email is lowercased in BOTH the token and the param because the route
 *  lowercases before it verifies HMAC(email|brand). */
function unsubQuery(email: string, brand: string): string {
  const lower = email.trim().toLowerCase();
  const secret = process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET;
  const qs = new URLSearchParams({ email: lower, brand });
  if (secret) {
    const token = createHmac("sha256", secret).update(`${lower}|${brand}`).digest("hex").slice(0, 16);
    qs.set("token", token);
  }
  return qs.toString();
}

/** Human-facing unsubscribe PAGE (renders a confirmation) — used by the visible
 *  in-body footer link on commercial mail. */
export function unsubscribeUrl(email: string, brand: string = SUNBIZ_BRAND, ctx: TrackingContext = "platform"): string {
  return `${appBase(brand, ctx)}/unsubscribe?${unsubQuery(email, brand)}`;
}

/** Machine-facing unsubscribe API — the RFC 8058 one-click POST target. Points at
 *  /api/unsubscribe (which accepts the query params on POST), NOT the page, so a
 *  mail client's one-click actually suppresses instead of 405-ing on the page. */
export function unsubscribeApiUrl(email: string, brand: string = SUNBIZ_BRAND, ctx: TrackingContext = "platform"): string {
  return `${appBase(brand, ctx)}/api/unsubscribe?${unsubQuery(email, brand)}`;
}

/** RFC 8058 List-Unsubscribe header value (one-click HTTPS URL + mailto fallback). */
export function listUnsubscribeHeader(email: string, brand: string = SUNBIZ_BRAND, ctx: TrackingContext = "platform"): string {
  return `<${unsubscribeApiUrl(email, brand, ctx)}>, <mailto:submissions@sunbizfunding.com?subject=unsubscribe>`;
}

export type UnsubMode = "footer" | "none";

/**
 * Build the tracked HTML alternative from a plain-text body. `plain` is the
 * ALREADY-SANITIZED text (positioning guard has run). Bare http(s) URLs become
 * click-tracked anchors; everything else is HTML-escaped. `unsub:'none'` omits
 * the visible unsubscribe footer (transactional/relationship mail).
 */
export function buildTrackedHtml(
  plain: string,
  opts: { sendId: string; email: string; brand?: string; unsub?: UnsubMode; tracking?: TrackingContext },
): string {
  const { sendId, email } = opts;
  const brand = opts.brand || SUNBIZ_BRAND;
  const unsub: UnsubMode = opts.unsub || "footer";
  const tracking: TrackingContext = opts.tracking || "platform";

  const urlRe = /(https?:\/\/[^\s<>"')]+)/g;
  let out = "";
  let last = 0;
  for (const m of plain.matchAll(urlRe)) {
    const idx = m.index ?? 0;
    out += escapeHtml(plain.slice(last, idx));
    const target = m[0];
    out += `<a href="${escapeHtml(clickUrl(sendId, target, brand, tracking))}" style="color:#0B1F4F;text-decoration:underline;">${escapeHtml(target)}</a>`;
    last = idx + target.length;
  }
  out += escapeHtml(plain.slice(last));
  const bodyHtml = out.replace(/\n/g, "<br />\n");

  const pixel = `<img src="${escapeHtml(pixelUrl(sendId, brand, tracking))}" width="1" height="1" alt="" style="display:none;max-height:0;overflow:hidden;" />`;
  const footer =
    unsub === "none"
      ? ""
      : `<div style="margin-top:24px;color:#8a94a6;font-size:12px;line-height:1.5;">` +
        `If you would prefer not to receive these, you can ` +
        `<a href="${escapeHtml(unsubscribeUrl(email, brand, tracking))}" style="color:#8a94a6;">unsubscribe here</a>.` +
        `</div>`;

  return (
    `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;">` +
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:600px;">` +
    `${bodyHtml}${footer}</div>${pixel}</body></html>`
  );
}

/** Back-compat alias for the drip executor's original call shape. */
export function buildDripHtml(plain: string, opts: { sendId: string; email: string; brand?: string; unsub?: UnsubMode; tracking?: TrackingContext }): string {
  return buildTrackedHtml(plain, opts);
}
