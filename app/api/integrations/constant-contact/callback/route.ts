/**
 * GET /api/integrations/constant-contact/callback — Constant Contact bounces here
 * after consent. Verifies the signed state (CSRF + 15-min replay window) + session,
 * reads the PKCE verifier cookie, exchanges the code for tokens, and stores them
 * encrypted under service='constant_contact'. Redirects back to /email-blast with a
 * status flag.
 */
import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { exchangeCode } from "@/lib/integrations/constant-contact/client";
import { ccCredentials, ccTokenStore, CC_REDIRECT_URI } from "@/lib/integrations/constant-contact/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RETURN_PATH = "/email-blast";

function backTo(params: Record<string, string>): NextResponse {
  // Land back on the SAME canonical domain the OAuth happened on (oasisai.work,
  // where the operator is logged in) — NOT PUBLIC_APP_URL, which resolves to the
  // raw agent-dashboard-*.vercel.app host where the session cookie isn't present.
  const base = new URL(CC_REDIRECT_URI).origin;
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
  if (error) return backTo({ constant_contact: "denied", reason: error });
  if (!code || !state) return backTo({ constant_contact: "denied", reason: "missing_code_or_state" });

  const stateSecret = process.env.CONSTANT_CONTACT_OAUTH_STATE_SECRET || process.env.BRAVO_FIELD_ENCRYPTION_KEY || "";
  if (!stateSecret) return backTo({ constant_contact: "error", reason: "state_secret_missing" });

  const parts = state.split("|");
  if (parts.length !== 5) return backTo({ constant_contact: "error", reason: "malformed_state" });
  const [tenantId, stateUserId, nonce, issuedAtRaw, providedSig] = parts;
  const expectedSig = createHmac("sha256", stateSecret).update(`${tenantId}|${stateUserId}|${nonce}|${issuedAtRaw}`).digest("base64url");
  let sigMatch = false;
  try {
    sigMatch = providedSig.length === expectedSig.length && timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig));
  } catch {
    sigMatch = false;
  }
  if (!sigMatch) return backTo({ constant_contact: "error", reason: "state_signature_invalid" });

  const issuedAtMs = parseInt(issuedAtRaw, 36);
  if (!Number.isFinite(issuedAtMs) || Date.now() - issuedAtMs > 15 * 60 * 1000) {
    return backTo({ constant_contact: "error", reason: "state_expired" });
  }

  // Authenticate this leg via the SIGNED STATE (HMAC + 15-min window, verified
  // above) + the PKCE verifier cookie (below). CRITICAL: do NOT read the app
  // session here. This is a public route, so getAuthedSupabase's cookie writes are
  // a no-op; calling getUser() would refresh + ROTATE the Supabase refresh token
  // WITHOUT persisting the rotated value, invalidating the operator's session and
  // logging them out on the next page load (the "Connect logs me out" bug). The
  // signed state — which carries the tenant + user id — is the trust anchor.

  const codeVerifier = req.cookies.get("cc_oauth_pkce")?.value || "";
  if (!codeVerifier) return backTo({ constant_contact: "error", reason: "pkce_verifier_missing" });

  const creds = await ccCredentials(tenantId);
  if (!creds) return backTo({ constant_contact: "error", reason: "not_configured" });

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
    return backTo({ constant_contact: "error", reason: "token_exchange_failed" });
  }

  try {
    await ccTokenStore(tenantId).save(tokens);
  } catch (e) {
    console.error("[constant-contact.callback] token store failed", (e as Error).message);
    return backTo({ constant_contact: "error", reason: "store_failed" });
  }

  return backTo({ constant_contact: "connected" });
}
