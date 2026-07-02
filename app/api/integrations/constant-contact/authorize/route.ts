/**
 * GET /api/integrations/constant-contact/authorize — start the Constant Contact
 * OAuth connect. Opened in a POPUP by the Email Blast UI, so this is a 302 REDIRECT
 * straight to Constant Contact (not a JSON+fetch). Sets NO cookies — a signed
 * `state` (HMAC + 15-min replay window) carries CSRF; the confidential client
 * secret secures the code exchange. Admin-only (tenant-shared integration).
 *
 * On error we render the popup result page (postMessage the opener + close) rather
 * than raw JSON, so a blocked/failed start closes cleanly.
 */
import { NextResponse } from "next/server";
import { randomBytes, createHmac } from "node:crypto";
import { resolveSessionContext } from "@/lib/api-auth";
import { buildAuthorizeUrl } from "@/lib/integrations/constant-contact/client";
import { ccCredentials, CC_SCOPES, CC_REDIRECT_URI } from "@/lib/integrations/constant-contact/store";
import { ccPopupResult } from "@/lib/integrations/constant-contact/popup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await resolveSessionContext();
  if (!session.ok) return ccPopupResult("error", "login_required");
  if (!session.isAdmin) return ccPopupResult("error", "admin_only");

  const creds = await ccCredentials(session.tenantId);
  if (!creds) return ccPopupResult("error", "not_configured");

  const stateSecret = process.env.CONSTANT_CONTACT_OAUTH_STATE_SECRET || process.env.BRAVO_FIELD_ENCRYPTION_KEY || "";
  if (!stateSecret) return ccPopupResult("error", "state_secret_missing");

  // Signed state: tenantId|userId|nonce|issuedAt|sig — CSRF + 15-min replay window.
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
  });

  // 302 to Constant Contact. No Set-Cookie here → nothing can touch the session.
  return NextResponse.redirect(url);
}
