/**
 * lib/os/runs/producer-auth.ts - the credential a PRODUCER holds to write one
 * run's events: the paired computer's bridge, when it answers a department turn
 * itself and posts what the app does to POST /api/os/runs/<id>/events.
 *
 * NOT A SESSION. The bridge has no sign-in and must never get one. It is handed
 * a run credential that can do exactly one thing: append events to ONE run, for
 * a short time. The credential names the run (rid) and the workspace (tid); the
 * route checks both against the run's own row, and takes the workspace and the
 * person from that row, never from the request body.
 *
 *   orun1.<base64url payload>.<base64url HMAC-SHA256 of "orun1.<payload>">
 *   payload { aud: "oasis-run", rid, tid, iat, exp }   (seconds)
 *
 * The key is the Worker secret OASIS_RUN_TOKEN_KEY (at least 32 characters). With
 * no key set nothing verifies and the events route answers 503: fail closed.
 * Rotating the key ends every outstanding credential. Minting lives here so the
 * Worker that dispatches a bridge turn and the route that receives its events
 * agree on one format; the bridge only echoes it back.
 */
import "server-only";

const AUD = "oasis-run";
const PREFIX = "orun1";
/** Longest one lives: a bridge turn is capped at about five minutes; this leaves room for a queue. */
export const RUN_CREDENTIAL_MAX_TTL_SEC = 30 * 60;
const MIN_KEY_CHARS = 32;

export type RunClaims = { aud: string; rid: string; tid: string; iat: number; exp: number };

export type RunCredentialCheck =
  | { ok: true; claims: RunClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "wrong_audience" | "expired" };

/** The signing key, or null when this deployment has none (then nothing verifies). */
export function runSigningKey(): string | null {
  const key = process.env.OASIS_RUN_TOKEN_KEY;
  return key && key.length >= MIN_KEY_CHARS ? key : null;
}

function toB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const enc = new TextEncoder();

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function mintRunCredential(
  key: string,
  input: { runId: string; tenantId: string; ttlSec: number; nowMs?: number },
): Promise<string> {
  if (key.length < MIN_KEY_CHARS) throw new Error("mintRunCredential: the signing key is too short");
  const iat = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const ttl = Math.max(1, Math.min(Math.floor(input.ttlSec), RUN_CREDENTIAL_MAX_TTL_SEC));
  const claims: RunClaims = { aud: AUD, rid: input.runId, tid: input.tenantId, iat, exp: iat + ttl };
  const body = `${PREFIX}.${toB64url(enc.encode(JSON.stringify(claims)))}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(key, "sign"), enc.encode(body));
  return `${body}.${toB64url(new Uint8Array(sig))}`;
}

/** Signature first (a constant-time check), then audience, then expiry. */
export async function verifyRunCredential(key: string, presented: string, nowMs: number = Date.now()): Promise<RunCredentialCheck> {
  const parts = presented.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: "malformed" };
  const sig = fromB64url(parts[2]);
  const payload = fromB64url(parts[1]);
  if (!sig || !payload) return { ok: false, reason: "malformed" };
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(key, "verify"), sig as BufferSource, enc.encode(`${parts[0]}.${parts[1]}`));
  if (!valid) return { ok: false, reason: "bad_signature" };
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const c = claims as Partial<RunClaims> | null;
  if (!c || typeof c !== "object" || typeof c.rid !== "string" || typeof c.tid !== "string" || typeof c.exp !== "number" || typeof c.iat !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (c.aud !== AUD) return { ok: false, reason: "wrong_audience" };
  if (Math.floor(nowMs / 1000) >= c.exp || c.exp - c.iat > RUN_CREDENTIAL_MAX_TTL_SEC) return { ok: false, reason: "expired" };
  return { ok: true, claims: c as RunClaims };
}
