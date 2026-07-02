/**
 * GET /api/integrations/constant-contact/callback — Constant Contact bounces the
 * POPUP here after consent. Public route (in the middleware allowlist): it reads
 * NO app session and sets NO cookies, so it can never rotate/invalidate the
 * operator's Supabase token (that was the "Connect logs me out" bug). It's
 * authenticated by the signed `state` (HMAC + 15-min replay window); the code
 * exchange is secured by the confidential client secret. On completion it renders
 * the popup result page (postMessage the opener + close).
 */
import { NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { exchangeCode } from "@/lib/integrations/constant-contact/client";
import { ccCredentials, ccTokenStore, CC_REDIRECT_URI } from "@/lib/integrations/constant-contact/store";
import { ccPopupResult } from "@/lib/integrations/constant-contact/popup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code") || "";
  const state = req.nextUrl.searchParams.get("state") || "";
  const error = req.nextUrl.searchParams.get("error") || "";
  if (error) return ccPopupResult("denied", error);
  if (!code || !state) return ccPopupResult("denied", "missing_code_or_state");

  const stateSecret = process.env.CONSTANT_CONTACT_OAUTH_STATE_SECRET || process.env.BRAVO_FIELD_ENCRYPTION_KEY || "";
  if (!stateSecret) return ccPopupResult("error", "state_secret_missing");

  const parts = state.split("|");
  if (parts.length !== 5) return ccPopupResult("error", "malformed_state");
  const [tenantId, stateUserId, nonce, issuedAtRaw, providedSig] = parts;
  const expectedSig = createHmac("sha256", stateSecret).update(`${tenantId}|${stateUserId}|${nonce}|${issuedAtRaw}`).digest("base64url");
  let sigMatch = false;
  try {
    sigMatch = providedSig.length === expectedSig.length && timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig));
  } catch {
    sigMatch = false;
  }
  if (!sigMatch) return ccPopupResult("error", "state_signature_invalid");

  const issuedAtMs = parseInt(issuedAtRaw, 36);
  if (!Number.isFinite(issuedAtMs) || Date.now() - issuedAtMs > 15 * 60 * 1000) {
    return ccPopupResult("error", "state_expired");
  }

  const creds = await ccCredentials(tenantId);
  if (!creds) return ccPopupResult("error", "not_configured");

  let tokens;
  try {
    tokens = await exchangeCode({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      code,
      redirectUri: CC_REDIRECT_URI,
    });
  } catch (e) {
    console.error("[constant-contact.callback] token exchange failed", (e as Error).message);
    return ccPopupResult("error", "token_exchange_failed");
  }

  try {
    await ccTokenStore(tenantId).save(tokens);
  } catch (e) {
    console.error("[constant-contact.callback] token store failed", (e as Error).message);
    return ccPopupResult("error", "store_failed");
  }

  return ccPopupResult("connected");
}
