/**
 * Submissions account Gmail OAuth — Adon spec section 4 (2026-06-10).
 *
 * Server-only. Manages the access token for the submissions@sunbizfunding.com
 * Gmail account so the shop-out engine can call gmail.users.messages.send
 * directly from Vercel. Refresh-token-based long-lived auth; we never
 * see the operator's browser-side OAuth flow.
 *
 * Required Vercel env vars (Production scope):
 *   SUNBIZ_GMAIL_CLIENT_ID
 *   SUNBIZ_GMAIL_CLIENT_SECRET
 *   SUNBIZ_GMAIL_REFRESH_TOKEN
 *   SUNBIZ_GMAIL_REDIRECT_URI
 *   SUNBIZ_SUBMISSIONS_EMAIL  (defaults to submissions@sunbizfunding.com)
 *
 * Hard rules:
 *   - These env vars NEVER appear in any response body or log line.
 *     Audit by greping for SUNBIZ_GMAIL_ in the build; zero hits outside
 *     this file is the verification gate (spec section 8 item #2).
 *   - Access tokens are cached in module-scope memory only. Vercel's
 *     function recycling means caches live for the duration of one
 *     warm function — that's fine; we refresh 60s before expiry so a
 *     fresh function spawn never blocks on a token call.
 *   - On 401 from Gmail, the caller (submissions-gmail-send) refreshes
 *     once and retries once. After the second 401 it bubbles up.
 */

import "server-only";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_PROFILE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/** Skew the expiry check 60s early so the cached token never expires mid-request. */
const EARLY_REFRESH_MS = 60_000;

type CachedToken = {
  accessToken: string;
  expiresAt: number; // epoch milliseconds
};

let _cache: CachedToken | null = null;
let _inflight: Promise<string> | null = null;

function readEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    // Throwing the env var NAME (not value) — name is safe to surface.
    // The caller maps this to the spec's testConnection() failure path.
    throw new Error(`missing_env:${name}`);
  }
  return v.trim();
}

/**
 * Get a valid access token. Returns the cached one if it's still fresh,
 * otherwise refreshes (with concurrent-call dedup so a burst of N
 * parallel sends only triggers one refresh).
 *
 * Throws on revoked refresh token / network failure / Google 4xx.
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (_cache && _cache.expiresAt > now + EARLY_REFRESH_MS) {
    return _cache.accessToken;
  }
  // Dedup concurrent refresh calls — without this, N parallel sends each
  // try to refresh and Google rate-limits the OAuth endpoint.
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const clientId = readEnv("SUNBIZ_GMAIL_CLIENT_ID");
      const clientSecret = readEnv("SUNBIZ_GMAIL_CLIENT_SECRET");
      const refreshToken = readEnv("SUNBIZ_GMAIL_REFRESH_TOKEN");

      const form = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      });

      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (!res.ok) {
        // Body may include `error: invalid_grant` (revoked refresh token).
        // Surface the status + Google's machine-readable error code, not
        // the full payload (which can echo back the refresh_token in some
        // error responses).
        let code = "oauth_refresh_failed";
        try {
          const body = (await res.json()) as { error?: string };
          if (typeof body?.error === "string") code = `oauth_${body.error}`;
        } catch {
          // Ignore JSON parse errors — we still throw a clean message.
        }
        throw new Error(`${code}:${res.status}`);
      }
      const data = (await res.json()) as {
        access_token: string;
        expires_in: number;
      };
      if (!data.access_token || typeof data.expires_in !== "number") {
        throw new Error("oauth_malformed_response");
      }
      _cache = {
        accessToken: data.access_token,
        expiresAt: now + data.expires_in * 1000,
      };
      return _cache.accessToken;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/**
 * Force a token refresh on next call. Used by submissions-gmail-send
 * when Gmail returns 401 — the cached token might be revoked or the
 * Google session might have rotated. Clearing forces a fresh fetch.
 */
export function invalidateAccessToken(): void {
  _cache = null;
}

/**
 * Hit gmail.users.getProfile to verify the credentials work and the
 * account email matches what the operator expects. Used by /run as a
 * connection gate before any send fires (spec section 8 item #1).
 *
 * Returns a discriminated union so the caller can JSON.stringify it
 * straight into a response. Never throws.
 */
export async function testConnection(): Promise<
  | { ok: true; email: string }
  | { ok: false; error: string }
> {
  try {
    const token = await getAccessToken();
    const res = await fetch(GMAIL_PROFILE_URL, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return { ok: false, error: `gmail_profile_http_${res.status}` };
    }
    const data = (await res.json()) as { emailAddress?: string };
    const email = data.emailAddress || "";
    if (!email) {
      return { ok: false, error: "gmail_profile_missing_email" };
    }
    return { ok: true, email };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "unknown_connection_error",
    };
  }
}

/**
 * Read the submissions account address. Defaults to the canonical
 * shared inbox when the env var is unset — useful for dev where the
 * operator may not have provisioned all env vars yet.
 */
export function getSubmissionsEmail(): string {
  return (
    process.env.SUNBIZ_SUBMISSIONS_EMAIL?.trim() ||
    "submissions@sunbizfunding.com"
  );
}
