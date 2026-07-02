/**
 * GET /api/integrations/constant-contact/authorize — start the Constant Contact
 * OAuth2 (auth-code + PKCE) connect. Returns { ok, url }; the client redirects the
 * browser to `url`. CC bounces back to /callback after consent.
 *
 * Admin-only: Constant Contact is a tenant-shared (org-level) integration, so only
 * an owner/admin connects it. PKCE code_verifier is stashed in a short-lived
 * httpOnly cookie; a signed state carries CSRF + a 15-min replay window.
 */
import { NextResponse } from "next/server";
import { randomBytes, createHash, createHmac } from "node:crypto";
import { resolveSessionContext } from "@/lib/api-auth";
import { buildAuthorizeUrl } from "@/lib/integrations/constant-contact/client";
import { ccCredentials, CC_SCOPES, CC_REDIRECT_URI } from "@/lib/integrations/constant-contact/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ ok: false, error: "admin_only" }, { status: 403 });

  const creds = await ccCredentials(session.tenantId);
  if (!creds) {
    return NextResponse.json(
      { ok: false, error: "not_configured", message: "Constant Contact app credentials (api_key_Constant_Contact / APP_SECRET) are not set in the server env." },
      { status: 500 },
    );
  }

  const stateSecret = process.env.CONSTANT_CONTACT_OAUTH_STATE_SECRET || process.env.BRAVO_FIELD_ENCRYPTION_KEY || "";
  if (!stateSecret) {
    return NextResponse.json({ ok: false, error: "state_secret_missing" }, { status: 500 });
  }

  // PKCE
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  // Signed state: tenantId|userId|nonce|issuedAt|sig
  const nonce = randomBytes(16).toString("base64url");
  const issuedAt = Date.now().toString(36);
  const statePayload = `${session.tenantId}|${session.userId}|${nonce}|${issuedAt}`;
  const sig = createHmac("sha256", stateSecret).update(statePayload).digest("base64url");
  const state = `${statePayload}|${sig}`;

  const url = buildAuthorizeUrl({
    clientId: creds.clientId,
    redirectUri: CC_REDIRECT_URI,
    scopes: CC_SCOPES,
    state,
    codeChallenge,
  });

  const res = NextResponse.json({ ok: true, url });
  res.cookies.set("cc_oauth_pkce", codeVerifier, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 15 * 60, // 15 min, matches the state replay window
  });
  return res;
}
