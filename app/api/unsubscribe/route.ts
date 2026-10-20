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
 *   2. Optional HMAC token verification — when OASIS_UNSUBSCRIBE_HMAC_SECRET
 *      is set, the token in the URL must match HMAC-SHA256(email|brand)
 *      truncated to 16 hex chars. Without the secret, opt-out is
 *      email-only (matches the URL format casl_compliance.py emits today;
 *      tokens become enforced once email_template.py starts signing them).
 *      Unsigned links stay accepted on purpose: every email already sent
 *      carries one, and an opt-out link has to keep working after the send
 *      (CASL: at least 60 days), so refusing them would stop real people
 *      unsubscribing. The worst an unsigned link allows is unsubscribing
 *      someone else, which over-suppresses (the safe direction), bounded by
 *      the IP rate limit below.
 *   3. Brand → tenant resolution: we lookup the tenant by brand string
 *      from `tenants.custom_fields.brand` so suppressions are properly
 *      tenant-scoped per CASL s. 6 (per-sender rule). OASIS's support-mail
 *      brand is pinned to OASIS's own workspace first (pinnedSuppressionTenant,
 *      lib/email/support-mailbox.ts): its name is shared by dozens of other
 *      workspaces, so a name lookup would file the opt-out under a stranger's.
 *   4. Rate limit by IP — anti-enumeration. Reuses the pair-code limiter.
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
import { isRateLimited, recordPairAttempt } from "@/lib/pair-rate-limit";
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

function verifyToken(email: string, brand: string, token: string): boolean {
  const secret = process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET;
  if (!secret) return true; // no secret configured → token check disabled
  if (!token) return false; // secret set but no token supplied
  const expected = createHmac("sha256", secret)
    .update(`${email}|${brand}`)
    .digest("hex")
    .slice(0, 16);
  // timingSafeEqual requires equal-length buffers; bail early on length mismatch.
  if (token.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Resolve a tenant_id by brand string: a workspace whose name, or whose
 * custom_fields.brand, equals the brand (case-insensitive). Returns null when
 * no workspace, or more than one, matches. The opt-out is then recorded with
 * tenant_id=NULL, a "global" suppression that every sender also honours
 * (lib/email/suppression-scope.ts), so the recipient is protected even when the
 * brand cannot be tied to one sender.
 *
 * The brand comes from the opt-out link, so it is matched as a value, never
 * pasted into a filter expression. Before (2026-10-19 audit) it was spliced
 * into `.or("name.ilike.<brand>,...")`: a comma ("Acme, Inc.") broke the
 * expression and the opt-out failed with a 500, recording nothing; "_" and
 * "%" matched other workspaces' names; and `.limit(1)` filed a name several
 * workspaces share under whichever came first.
 */
async function resolveTenantId(brand: string): Promise<string | null> {
  if (!brand) return null;
  const pinned = pinnedSuppressionTenant(brand);
  if (pinned) return pinned;
  const db = getServiceSupabase();
  const exact = brand.toLowerCase().replace(/[%_\\]/g, "\\$&");
  const ids = new Set<string>();
  for (const column of ["name", "custom_fields->>brand"]) {
    const { data, error } = await db.from("tenants").select("id").ilike(column, exact).limit(5);
    if (error) throw new Error(`brand lookup failed: ${error.message}`);
    for (const row of data ?? []) ids.add(String((row as { id: string }).id));
  }
  return ids.size === 1 ? [...ids][0] : null;
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

  // ---- Token verification (no-op without OASIS_UNSUBSCRIBE_HMAC_SECRET) ----
  // The rate-limit helper exposes outcomes scoped to the pair-code flow; map
  // this unsubscribe-specific "invalid_token" to its closest match
  // ("invalid_hmac") so the limiter's failure-counter still trips.
  if (!verifyToken(rawEmail, rawBrand, rawToken)) {
    await recordPairAttempt(rateKey, "invalid_hmac", ip);
    return bad(401, "invalid_token");
  }

  // ---- Resolve brand → tenant_id (null when unknown or shared) ----
  // A failed lookup must not lose the opt-out: record it globally instead,
  // which every sender honours. Over-suppressing is the safe direction.
  let tenantId: string | null;
  try {
    tenantId = await resolveTenantId(rawBrand);
  } catch (err) {
    console.error("[unsubscribe] brand lookup failed; recording the opt-out globally", {
      error: err instanceof Error ? err.message : String(err),
    });
    tenantId = null;
  }

  // ---- UPSERT into email_suppressions ----
  const db = getServiceSupabase();
  const insertRow = {
    email: rawEmail,
    tenant_id: tenantId,
    brand: rawBrand || null,
    reason: "unsubscribe",
    source: "web_form",
    user_agent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
    ip_address: ip || null,
  };
  const { error } = await db
    .from("email_suppressions")
    .upsert(insertRow, {
      onConflict: "email,tenant_id,brand",
      ignoreDuplicates: false,
    });

  if (error) {
    // Map DB errors to the limiter's "code_redeem_failed" bucket — closest
    // existing outcome for "we couldn't finish the write."
    await recordPairAttempt(rateKey, "code_redeem_failed", ip);
    return bad(500, `db_error: ${error.message.slice(0, 120)}`);
  }

  await recordPairAttempt(rateKey, "ok", ip);
  return NextResponse.json({ ok: true });
}
