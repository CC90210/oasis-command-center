/**
 * GET /api/integrations/constant-contact/callback — Constant Contact bounces here
 * after consent. Verifies the signed state (CSRF + 15-min replay window) + session,
 * reads the PKCE verifier cookie, exchanges the code for tokens, and stores them
 * encrypted under service='constant_contact'. Redirects back to /email-blast with a
 * status flag.
 */
import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSessionUser } from "@/lib/supabase-server";
import { exchangeCode } from "@/lib/integrations/constant-contact/client";
import { ccCredentials, ccTokenStore, CC_REDIRECT_URI } from "@/lib/integrations/constant-contact/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RETURN_PATH = "/email-blast";

function backTo(req: NextRequest, params: Record<string, string>): NextResponse {
  const base = process.env.PUBLIC_APP_URL?.replace(/\/$/, "") || new URL(req.url).origin;
  const dest = new URL(`${base}${RETURN_PATH}`);
  for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
  const res = NextResponse.redirect(dest.toString());
  res.cookies.set("cc_oauth_pkce", "", { path: "/", maxAge: 0 }); // clear the verifier
  return res;
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code") || "";
  const state = req.nextUrl.searchParams.get("state") || "";
  const error = req.nextUrl.searchParams.get("error") || "";
  if (error) return backTo(req, { constant_contact: "denied", reason: error });
  if (!code || !state) return backTo(req, { constant_contact: "denied", reason: "missing_code_or_state" });

  const stateSecret = process.env.CONSTANT_CONTACT_OAUTH_STATE_SECRET || process.env.BRAVO_FIELD_ENCRYPTION_KEY || "";
  if (!stateSecret) return backTo(req, { constant_contact: "error", reason: "state_secret_missing" });

  const parts = state.split("|");
  if (parts.length !== 5) return backTo(req, { constant_contact: "error", reason: "malformed_state" });
  const [tenantId, stateUserId, nonce, issuedAtRaw, providedSig] = parts;
  const expectedSig = createHmac("sha256", stateSecret).update(`${tenantId}|${stateUserId}|${nonce}|${issuedAtRaw}`).digest("base64url");
  let sigMatch = false;
  try {
    sigMatch = providedSig.length === expectedSig.length && timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig));
  } catch {
    sigMatch = false;
  }
  if (!sigMatch) return backTo(req, { constant_contact: "error", reason: "state_signature_invalid" });

  const issuedAtMs = parseInt(issuedAtRaw, 36);
  if (!Number.isFinite(issuedAtMs) || Date.now() - issuedAtMs > 15 * 60 * 1000) {
    return backTo(req, { constant_contact: "error", reason: "state_expired" });
  }

  // Authenticate this leg via the SIGNED STATE (HMAC + 15-min window, verified
  // above) + the PKCE verifier cookie (below) — NOT a live session. The provider's
  // cross-site redirect may not carry the app session cookie, so requiring a live
  // session here 401s the whole connect. If a session IS present, assert it matches
  // the state (defense in depth); if absent, trust the signed state.
  const user = await getSessionUser();
  if (user && user.id !== stateUserId) return backTo(req, { constant_contact: "error", reason: "session_mismatch" });

  const codeVerifier = req.cookies.get("cc_oauth_pkce")?.value || "";
  if (!codeVerifier) return backTo(req, { constant_contact: "error", reason: "pkce_verifier_missing" });

  const creds = await ccCredentials(tenantId);
  if (!creds) return backTo(req, { constant_contact: "error", reason: "not_configured" });

  let tokens;
  try {
    tokens = await exchangeCode({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      code,
      redirectUri: CC_REDIRECT_URI,
      codeVerifier,
    });
  } catch (e) {
    console.error("[constant-contact.callback] token exchange failed", (e as Error).message);
    return backTo(req, { constant_contact: "error", reason: "token_exchange_failed" });
  }

  try {
    await ccTokenStore(tenantId).save(tokens);
  } catch (e) {
    console.error("[constant-contact.callback] token store failed", (e as Error).message);
    return backTo(req, { constant_contact: "error", reason: "store_failed" });
  }

  return backTo(req, { constant_contact: "connected" });
}
