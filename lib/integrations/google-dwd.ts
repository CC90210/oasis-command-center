/**
 * lib/integrations/google-dwd.ts — Google Workspace domain-wide delegation.
 *
 * WHAT THIS BUYS. Every rep on the Workspace domain gets calendar access with
 * ZERO clicks, including people hired next month. A super-admin authorises one
 * service account once in the Google admin console; after that this code can
 * act as any user on the allowlisted domain, so a rep never has to find a
 * Settings page, and nobody has to chase the ones who never did.
 *
 * WHY IT IMPERSONATES THE REP RATHER THAN USING A SHARED CALENDAR. The point
 * of a follow-up reminder is that it reaches the phone in that rep's pocket.
 * An event on a shared workspace calendar reaches nobody's lock screen and
 * publishes that rep's private call notes to everyone who can read it. When we
 * impersonate, "primary" IS that rep's own calendar, which is exactly right.
 * (`calendar-reminder.ts` refuses the shared-calendar fallback for this reason;
 * delegation is the correct way to get the same zero-touch result.)
 *
 * 🚨 THE DOMAIN ALLOWLIST IS THE WHOLE SECURITY MODEL, AND IT FAILS CLOSED.
 *
 * A delegated service account can mint a token for ANY address on the domains
 * the admin authorised it for. That is enormous power sitting behind one
 * function argument. If an address ever reached `mintDelegatedAccessToken`
 * from lead data, a form field, or a URL parameter, this would read a
 * stranger's calendar. So:
 *
 *   - only addresses whose domain is explicitly listed in GOOGLE_DWD_DOMAINS
 *     are ever impersonated, matched on the FULL domain, never a suffix
 *     (`notoasisai.work` must not pass a check for `oasisai.work`);
 *   - the local part is charset-validated before it is put in a signed claim;
 *   - the scope is pinned to calendar.events in this module and is not a
 *     parameter, so no caller can widen it;
 *   - anything unrecognised, malformed or unconfigured returns a typed refusal
 *     rather than an exception or a token.
 *
 * `tests/google-dwd.test.ts` pins every one of those and mutates them.
 *
 * CONFIGURATION (all three required; absent means the feature is simply off):
 *   GOOGLE_DWD_CLIENT_EMAIL   the service account address
 *   GOOGLE_DWD_PRIVATE_KEY    its PEM private key ("\n" escapes are unescaped)
 *   GOOGLE_DWD_DOMAINS        comma-separated domains it may impersonate
 *
 * The admin-console step that makes it work is documented in
 * docs/google-domain-wide-delegation.md.
 */

import "server-only";
import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** Pinned, not a parameter. A caller must not be able to widen delegation. */
const DELEGATED_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const ASSERTION_LIFETIME_SECONDS = 3600;
/** Refresh a little early rather than racing an expiry mid-request. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

export type DwdConfig = {
  clientEmail: string;
  privateKey: string;
  /** Lowercased domains this service account may impersonate. */
  domains: string[];
};

export type DwdFailure =
  /** No service account configured. Normal when the org has not set it up. */
  | "not_configured"
  /** The address is not on an authorised domain, or is malformed. Never retried. */
  | "not_delegatable"
  /** Google refused the assertion (bad key, delegation not granted). Needs a human. */
  | "delegation_rejected"
  /** Network, timeout, 429 or 5xx. A later attempt may succeed. */
  | "retryable";

export type DwdTokenResult =
  | { ok: true; accessToken: string; expiresAtMs: number }
  | { ok: false; reason: DwdFailure; detail: string };

/** Reads the service account from the environment. Null when not set up. */
export function dwdConfig(): DwdConfig | null {
  const clientEmail = (process.env.GOOGLE_DWD_CLIENT_EMAIL || "").trim();
  // Deployment platforms store PEM keys with escaped newlines; a key with
  // literal "\n" in it fails to sign with an unhelpful error, so unescape here
  // rather than making every operator remember to.
  const privateKey = (process.env.GOOGLE_DWD_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  const domains = (process.env.GOOGLE_DWD_DOMAINS || "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (!clientEmail || !privateKey || domains.length === 0) return null;
  return { clientEmail, privateKey, domains };
}

/** True when domain-wide delegation is available at all. */
export function isDwdConfigured(): boolean {
  return dwdConfig() !== null;
}

/**
 * May we act as this person?
 *
 * Split out and exported so the rule is testable on its own, because it is the
 * only thing standing between "convenient" and "reads any calendar we are
 * handed an address for".
 */
export function isDelegatableAddress(email: string, config: DwdConfig): boolean {
  const normalized = String(email || "").trim().toLowerCase();
  // One @, a charset-restricted local part, and a plausible domain. This runs
  // before the address enters a signed JWT claim.
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized)) return false;
  const at = normalized.lastIndexOf("@");
  const domain = normalized.slice(at + 1);
  // FULL domain equality, never endsWith: a suffix test would let
  // "evil-oasisai.work" through a check for "oasisai.work".
  return config.domains.includes(domain);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build and sign the assertion that asks Google to act as `subject`.
 *
 * Kept separate from the network call so a test can inspect exactly what is
 * claimed without minting anything.
 */
export function buildAssertion(
  config: DwdConfig,
  subject: string,
  nowSeconds: number,
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: config.clientEmail,
      sub: subject,
      scope: DELEGATED_SCOPE,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + ASSERTION_LIFETIME_SECONDS,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(config.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Cache of live access tokens, keyed by the impersonated address.
 *
 * Delegated tokens last an hour and minting one is a signed round trip, so a
 * cron pass over many leads for the same rep should not re-mint per lead. The
 * cache holds tokens, so it is process-local and never persisted.
 */
const tokenCache = new Map<string, { accessToken: string; expiresAtMs: number }>();

/** Exported for tests; also the right thing to call if a key is rotated. */
export function clearDelegatedTokenCache(): void {
  tokenCache.clear();
}

export type DwdDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/**
 * Mint an access token that acts as `email`.
 *
 * Never throws, and never returns a token for an address outside the
 * authorised domains.
 */
export async function mintDelegatedAccessToken(
  email: string,
  deps: DwdDeps = {},
): Promise<DwdTokenResult> {
  const config = dwdConfig();
  if (!config) {
    return { ok: false, reason: "not_configured", detail: "no delegated service account configured" };
  }
  if (!isDelegatableAddress(email, config)) {
    // Deliberately does not echo the address into the detail: this path is
    // reachable with attacker-influenced input by construction, and the log is
    // not the place to widen what it can write.
    return {
      ok: false,
      reason: "not_delegatable",
      detail: "address is not on an authorised Workspace domain",
    };
  }
  const subject = email.trim().toLowerCase();
  const now = deps.now || Date.now;
  const nowMs = now();

  const cached = tokenCache.get(subject);
  if (cached && cached.expiresAtMs - nowMs > TOKEN_REFRESH_SKEW_MS) {
    return { ok: true, accessToken: cached.accessToken, expiresAtMs: cached.expiresAtMs };
  }

  let assertion: string;
  try {
    assertion = buildAssertion(config, subject, Math.floor(nowMs / 1000));
  } catch {
    // A malformed private key lands here. It is a deployment problem, not a
    // transient one, so it must not be retried on a timer.
    return {
      ok: false,
      reason: "delegation_rejected",
      detail: "could not sign the delegation assertion (check the service account key)",
    };
  }

  const fetchImpl = deps.fetchImpl || fetch;
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return {
      ok: false,
      reason: "retryable",
      detail: error instanceof Error ? error.message : "token request failed",
    };
  }

  if (!response.ok) {
    let body = "";
    try {
      body = (await response.text()).slice(0, 300);
    } catch {
      body = "";
    }
    if (response.status === 429 || response.status >= 500) {
      return { ok: false, reason: "retryable", detail: `google_${response.status} ${body}`.trim() };
    }
    // 400/401/403 here means the admin has not authorised this client id for
    // this scope, or the key is wrong. A person must fix it in the admin
    // console; a retry loop would never once help.
    return {
      ok: false,
      reason: "delegation_rejected",
      detail: `google_${response.status} ${body}`.trim(),
    };
  }

  let payload: { access_token?: string; expires_in?: number };
  try {
    payload = (await response.json()) as { access_token?: string; expires_in?: number };
  } catch (error) {
    return {
      ok: false,
      reason: "retryable",
      detail: error instanceof Error ? error.message : "unreadable token response",
    };
  }
  if (!payload.access_token) {
    return { ok: false, reason: "retryable", detail: "google returned no access token" };
  }

  const expiresAtMs = nowMs + Math.max(0, Number(payload.expires_in) || 0) * 1000;
  tokenCache.set(subject, { accessToken: payload.access_token, expiresAtMs });
  return { ok: true, accessToken: payload.access_token, expiresAtMs };
}
