/**
 * lib/connections/oauth.ts — the generic OAuth 2 start/finish for the
 * Connections framework, generalized from Constant Contact
 * (app/api/integrations/constant-contact/{authorize,callback}) with its three
 * gaps closed (doc 03 F7):
 *
 *   1. A DEDICATED state secret, CONNECTIONS_OAUTH_STATE_SECRET, with NO
 *      fallback. Constant Contact fell back to BRAVO_FIELD_ENCRYPTION_KEY, so
 *      one leaked value both decrypted every stored credential and forged
 *      consent states. A missing secret here is a refusal, never a substitute.
 *   2. SINGLE-USE state. Constant Contact's state was replayable for 15
 *      minutes. Here every state is an oauth_states row, and finishing
 *      consumes it with a conditional UPDATE that must affect exactly one row:
 *      a second use of the same state — or a forged nonce — affects none.
 *   3. ATOMIC token save lives in token-store.ts (setTenantIntegrationBundle),
 *      not three separate writes.
 *
 * The state token is `base64url(payload).base64url(hmac)`; the payload names
 * the tenant, user and provider the consent was started for, and the row must
 * agree on all three. PKCE (S256) is used where the provider supports it; the
 * verifier is stored encrypted and handed back exactly once.
 *
 * App credentials (client id/secret) come from Worker secrets named in the
 * ProviderDef — never from the tenant credential store with env fallback
 * (doc 03 a.1 principle 2).
 *
 * No provider is live over OAuth yet (lib/connections/registry.ts): these
 * helpers refuse any provider that is not, so no route can start a consent that
 * cannot finish.
 */
import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Client } from "@libsql/client";
import { decryptField, encryptField } from "@/lib/field-encryption";
import type { ProviderDef } from "@/lib/connections/registry";
import { OAUTH_STATE_SECRET_MIN_LENGTH, OAUTH_STATE_TTL_MS } from "@/lib/connections/rules";

export const OAUTH_STATE_SECRET_ENV = "CONNECTIONS_OAUTH_STATE_SECRET";
const MIN_SECRET_LENGTH = OAUTH_STATE_SECRET_MIN_LENGTH;

export class OAuthFlowError extends Error {
  code:
    | "provider_not_available"
    | "state_secret_missing"
    | "app_credentials_missing"
    | "state_malformed"
    | "state_signature_invalid"
    | "state_expired"
    | "state_replayed_or_unknown"
    | "pkce_unreadable";
  constructor(code: OAuthFlowError["code"], message?: string) {
    super(message ?? code);
    this.name = "OAuthFlowError";
    this.code = code;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** The dedicated state secret, or a refusal. Deliberately reads ONE variable. */
export function oauthStateSecret(env: Env = process.env): string {
  const secret = (env[OAUTH_STATE_SECRET_ENV] || "").trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new OAuthFlowError(
      "state_secret_missing",
      `${OAUTH_STATE_SECRET_ENV} is not set (or is shorter than ${MIN_SECRET_LENGTH} characters). There is no fallback.`,
    );
  }
  return secret;
}

type StatePayload = { v: 1; n: string; t: string; u: string; p: string; iat: number };

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(`oasis-connections-state.v1|${payloadB64}`).digest("base64url");
}

export function signState(payload: StatePayload, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

/** Verify signature and age. Pure — the single-use check is completeCallback's. */
export function verifyState(token: string, secret: string, nowMs: number): StatePayload {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new OAuthFlowError("state_malformed");
  const [body, sig] = parts;
  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new OAuthFlowError("state_signature_invalid");
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  } catch {
    throw new OAuthFlowError("state_malformed");
  }
  if (
    payload?.v !== 1 ||
    typeof payload.n !== "string" ||
    typeof payload.t !== "string" ||
    typeof payload.u !== "string" ||
    typeof payload.p !== "string" ||
    typeof payload.iat !== "number"
  ) {
    throw new OAuthFlowError("state_malformed");
  }
  const age = nowMs - payload.iat;
  if (!(age >= 0 && age <= OAUTH_STATE_TTL_MS)) throw new OAuthFlowError("state_expired");
  return payload;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export type StartAuthorizeInput = {
  provider: ProviderDef;
  tenantId: string;
  userId: string;
  scopes: readonly string[];
  redirectUri: string;
  now: Date;
  env?: Env;
};

/**
 * Begin a consent: write the single-use state row, and return the provider URL
 * to send the popup to. Refuses a provider that is not live, a missing state
 * secret, and missing app credentials — before anything is written.
 */
export async function startAuthorize(db: Client, input: StartAuthorizeInput): Promise<{ url: string; state: string }> {
  const env = input.env ?? process.env;
  const oauth = input.provider.oauth;
  if (input.provider.availability !== "live" || !oauth) {
    throw new OAuthFlowError("provider_not_available", `${input.provider.id} cannot be connected over OAuth yet`);
  }
  const secret = oauthStateSecret(env);
  const clientId = (env[oauth.clientIdEnv] || "").trim();
  if (!clientId || !(env[oauth.clientSecretEnv] || "").trim()) {
    throw new OAuthFlowError("app_credentials_missing", `${oauth.clientIdEnv}/${oauth.clientSecretEnv} are not set`);
  }

  const nonce = randomBytes(24).toString("base64url");
  const pkce = oauth.pkce ? pkcePair() : null;
  const scopeSet = input.scopes.join(oauth.scopeSeparator ?? " ");
  await db.execute({
    sql: `INSERT INTO oauth_states (nonce, tenant_id, user_id, provider, scope_set, pkce_verifier_enc, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      nonce,
      input.tenantId,
      input.userId,
      input.provider.id,
      scopeSet,
      pkce ? encryptField(pkce.verifier) : null,
      input.now.toISOString(),
      new Date(input.now.getTime() + OAUTH_STATE_TTL_MS).toISOString(),
    ],
  });

  const state = signState(
    { v: 1, n: nonce, t: input.tenantId, u: input.userId, p: input.provider.id, iat: input.now.getTime() },
    secret,
  );
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: input.redirectUri,
    state,
    ...(scopeSet ? { scope: scopeSet } : {}),
    ...(pkce ? { code_challenge: pkce.challenge, code_challenge_method: "S256" } : {}),
    ...(oauth.extraAuthorizeParams ?? {}),
  });
  return { url: `${oauth.authorizeUrl}?${q}`, state };
}

export type CompletedState = {
  tenantId: string;
  userId: string;
  provider: string;
  scopeSet: string;
  pkceVerifier: string | null;
};

/**
 * Finish a consent: verify the state and CONSUME its row. The consume is a
 * single conditional UPDATE — nonce, tenant, user and provider must all match,
 * the row must be unconsumed and unexpired — and it must affect exactly one
 * row. A replayed state, a forged nonce, or a state for another tenant all
 * affect zero and are refused the same way.
 */
export async function completeCallback(
  db: Client,
  input: { state: string; now: Date; env?: Env },
): Promise<CompletedState> {
  const secret = oauthStateSecret(input.env ?? process.env);
  const payload = verifyState(input.state, secret, input.now.getTime());
  const nowIso = input.now.toISOString();
  const consumed = await db.execute({
    sql: `UPDATE oauth_states SET consumed_at = ?
          WHERE nonce = ? AND tenant_id = ? AND user_id = ? AND provider = ?
            AND consumed_at IS NULL AND expires_at > ?`,
    args: [nowIso, payload.n, payload.t, payload.u, payload.p, nowIso],
  });
  if (consumed.rowsAffected !== 1) throw new OAuthFlowError("state_replayed_or_unknown");

  const rs = await db.execute({
    sql: `SELECT scope_set, pkce_verifier_enc FROM oauth_states WHERE nonce = ? AND tenant_id = ?`,
    args: [payload.n, payload.t],
  });
  const row = rs.rows[0] as unknown as { scope_set: string | null; pkce_verifier_enc: string | null } | undefined;
  let pkceVerifier: string | null = null;
  if (row?.pkce_verifier_enc) {
    try {
      pkceVerifier = decryptField(String(row.pkce_verifier_enc));
    } catch {
      throw new OAuthFlowError("pkce_unreadable");
    }
  }
  return {
    tenantId: payload.t,
    userId: payload.u,
    provider: payload.p,
    scopeSet: row?.scope_set ? String(row.scope_set) : "",
    pkceVerifier,
  };
}
