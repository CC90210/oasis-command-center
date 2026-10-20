/**
 * POST /api/unsubscribe — CASL-compliant email opt-out.
 *
 * Anonymous: the recipient may not have a dashboard account. The page at
 * /unsubscribe POSTs here with { email, brand, token } in the body.
 *
 * Idempotent: the migration's UNIQUE (email, tenant_id, brand) constraint
 * makes a second click on the same link a no-op (we upsert, treating
 * conflicts as success).
 *
 * Defense layers:
 *   1. JSON shape validation (email format, length caps).
 *   2. The link's token. When OASIS_UNSUBSCRIBE_HMAC_SECRET is set, links are
 *      signed with HMAC-SHA256(email|brand), 16 hex chars
 *      (lib/email/tracked-html.ts). Only a matching token makes a filing
 *      "signed". No token, or one that does not match, is "unsigned":
 *      accepted, capped (layer 4) and, for a mismatch, logged. Refusing a
 *      mismatch bought no security (anyone can leave the token off) and
 *      would strand every real link the day the secret rotates. An opt-out
 *      link has to keep working after the send (CASL: at least 60 days). The
 *      secret was not set when this was written (2026-10-19), so every live
 *      link is unsigned.
 *   3. Where the opt-out is filed. A brand pinned to one workspace files
 *      there (pinnedSuppressionTenant, lib/email/support-mailbox.ts: OASIS's
 *      support mail). Every other brand, or none, files globally
 *      (tenant_id NULL), which every sender honours
 *      (lib/email/suppression-scope.ts). The brand is never looked up by
 *      workspace name: dozens of workspaces are called "OASIS AI", and a self-signup
 *      can take any name, so a name match could file a real opt-out where its
 *      sender never looks (2026-10-19 audit). SunBiz, the only other brand a
 *      live link has carried, is retired, so its opt-outs file globally too.
 *   4. Rate limits by IP. Failures count toward the pair-code limiter
 *      (anti-enumeration). An unsigned link can opt out anyone, and a
 *      global row stops every sender, so unsigned filings are also capped at
 *      UNSIGNED_FILINGS_PER_IP_PER_HOUR per address bucket (an IPv6 /64,
 *      lib/pair-rate-limit.ts ipRateBucket). Each filing takes its place in
 *      line before it counts (claimCappedSlot), so a parallel burst cannot
 *      all slip under. Real volume is a handful of web opt-outs a month, and
 *      mail providers send one-click opt-outs from shared addresses; a signed
 *      link is never capped. A trip and each global filing are logged.
 *
 * Returns 200 on success (or already-suppressed). Never reveals whether
 * an email exists in our CRM — same response shape for any input that
 * passes shape validation. Prevents the route from being used as an
 * address-existence oracle.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { bad, getClientIp } from "@/lib/api-helpers";
import { claimCappedSlot, ipRateBucket, isRateLimited, recordPairAttempt } from "@/lib/pair-rate-limit";
import { pinnedSuppressionTenant } from "@/lib/email/support-mailbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_EMAIL_LEN = 254;
const MAX_BRAND_LEN = 80;
const MAX_TOKEN_LEN = 64;
// Standard email regex — lightweight; we don't enforce deliverability
// here, only shape sanity. The CRM has already verified the address
// itself when the email was sent.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Unsigned opt-outs one address bucket may file in an hour (defense layer 4).
 *  Real volume is a handful a month. Not exported: a route module may export
 *  only its handlers and config. */
const UNSIGNED_FILINGS_PER_IP_PER_HOUR = 30;

/**
 * "signed": the secret is set and the token matches. "unsigned": no secret,
 * or no token (a link from before signing). "invalid": a token that does not
 * match, which the caller treats as unsigned (defense layer 2).
 */
function tokenStatus(email: string, brand: string, token: string): "signed" | "unsigned" | "invalid" {
  const secret = process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET;
  if (!secret || !token) return "unsigned";
  const expected = createHmac("sha256", secret)
    .update(`${email}|${brand}`)
    .digest("hex")
    .slice(0, 16);
  // timingSafeEqual requires equal-length buffers; bail early on length mismatch.
  if (token.length !== expected.length) return "invalid";
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected)) ? "signed" : "invalid";
  } catch {
    return "invalid";
  }
}

export async function POST(req: NextRequest) {
  // ---- Rate-limit by IP (reuses the pair-code limiter for consistency) ----
  const ip = getClientIp(req);
  const rateKey = `unsubscribe:${ip || "unknown"}`;
  if (await isRateLimited(rateKey)) {
    await recordPairAttempt(rateKey, "rate_limited", ip);
    return bad(429, "rate_limited: too many opt-out attempts; back off and retry");
  }

  // ---- Read the identity from EITHER the query string (RFC 8058 one-click:
  // the mail client POSTs to the List-Unsubscribe URL with email/brand/token in
  // the query and a `List-Unsubscribe=One-Click` form body) OR the JSON body
  // (the /unsubscribe page form). Query wins; only parse a JSON body when the
  // query has no email, so the one-click form-encoded body never trips invalid_json.
  const qp = req.nextUrl.searchParams;
  let src: { email?: unknown; brand?: unknown; token?: unknown } = {
    email: qp.get("email") || undefined,
    brand: qp.get("brand") || undefined,
    token: qp.get("token") || undefined,
  };
  if (!src.email) {
    try {
      src = await req.json();
    } catch {
      return bad(400, "invalid_json");
    }
  }
  const rawEmail = String(src.email ?? "").trim().toLowerCase();
  const rawBrand = String(src.brand ?? "").trim();
  const rawToken = String(src.token ?? "").trim();

  if (!rawEmail || rawEmail.length > MAX_EMAIL_LEN || !EMAIL_RE.test(rawEmail)) {
    await recordPairAttempt(rateKey, "code_invalid_shape", ip);
    return bad(400, "invalid_email");
  }
  if (rawBrand.length > MAX_BRAND_LEN) {
    await recordPairAttempt(rateKey, "code_invalid_shape", ip);
    return bad(400, "invalid_brand");
  }
  if (rawToken.length > MAX_TOKEN_LEN) {
    await recordPairAttempt(rateKey, "code_invalid_shape", ip);
    return bad(400, "invalid_token");
  }

  // ---- The link's signature (layer 2) ----
  // A token that does not match counts as no token: capped and logged, never
  // refused (reviewer of #711: refusing strands real links when the secret
  // rotates, and an attacker simply leaves the token off).
  const signature = tokenStatus(rawEmail, rawBrand, rawToken);
  if (signature === "invalid") console.warn("[unsubscribe] link signature did not match; filed as unsigned");
  const signed = signature === "signed";

  // ---- Where it is filed (layer 3): a pinned workspace, or globally ----
  const tenantId = rawBrand ? pinnedSuppressionTenant(rawBrand) : null;

  // ---- The cap on unsigned filings (layer 4) ----
  const bucket = ipRateBucket(ip);
  if (!signed && !(await claimCappedSlot(`unsubscribe-unsigned:${bucket}`, ip, 3600, UNSIGNED_FILINGS_PER_IP_PER_HOUR))) {
    console.warn("[unsubscribe] unsigned opt-out cap reached", { bucket, cap: UNSIGNED_FILINGS_PER_IP_PER_HOUR });
    await recordPairAttempt(rateKey, "rate_limited", ip);
    return bad(429, "rate_limited: too many opt-out attempts; back off and retry");
  }

  // ---- UPSERT into email_suppressions ----
  const db = getServiceSupabase();
  const file = (filedUnder: string | null) =>
    db.from("email_suppressions").upsert(
      {
        email: rawEmail,
        tenant_id: filedUnder,
        brand: rawBrand || null,
        reason: "unsubscribe",
        source: "web_form",
        user_agent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
        ip_address: ip || null,
      },
      { onConflict: "email,tenant_id,brand", ignoreDuplicates: false },
    );
  let filedUnder = tenantId;
  let { error } = await file(filedUnder);
  if (error && filedUnder && /foreign key/i.test(error.message)) {
    // The pinned workspace is gone (tenant_id is a foreign key). The opt-out
    // must not be lost with it: file it for every sender instead.
    console.error("[unsubscribe] pinned workspace missing; filing for every sender", { tenant_id: filedUnder });
    filedUnder = null;
    ({ error } = await file(null));
  }

  if (error) {
    // Map DB errors to the limiter's "code_redeem_failed" bucket — closest
    // existing outcome for "we couldn't finish the write." The database's
    // words stay in the log; an anonymous caller gets the code.
    console.error("[unsubscribe] opt-out write failed", { error: error.message });
    await recordPairAttempt(rateKey, "code_redeem_failed", ip);
    return bad(500, "db_error");
  }

  await recordPairAttempt(rateKey, "ok", ip);
  if (!filedUnder) {
    // A global row stops every sender, so each one is logged. Never the address.
    console.warn("[unsubscribe] opt-out filed for every sender", { brand: rawBrand || null, signed });
  }
  return NextResponse.json({ ok: true });
}
