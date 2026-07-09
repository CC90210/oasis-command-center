/**
 * lib/esign/tokens.ts — signing-link token minting + verification.
 *
 * Same shape as the /f/ public-form token model (lib/form-links.ts) except
 * these tokens are OPAQUE random bytes, not an HMAC-signed payload: the
 * signer identity + expiry live in `esign_signers` (looked up by the
 * token's hash), so there's nothing to decode client-side and no signing
 * secret to manage.
 *
 * 32 bytes of entropy via crypto.randomBytes, base64url-encoded for a
 * clean URL. Only the SHA-256 of the raw token is ever persisted
 * (esign_signers.token_sha256, UNIQUE) — the raw token exists only in the
 * emailed link and the signer's browser URL. A DB leak alone can never
 * reconstruct a working signing link.
 */

import "server-only";
import { randomBytes, createHash } from "node:crypto";

export type MintedToken = {
  /** Raw token — goes ONLY into the emailed signing URL, never persisted. */
  raw: string;
  /** SHA-256 hex digest — the only form persisted, in esign_signers.token_sha256. */
  sha256: string;
};

/** Mint a fresh signing token: 32 bytes of entropy, base64url-encoded. */
export function mintSigningToken(): MintedToken {
  const raw = randomBytes(32).toString("base64url");
  return { raw, sha256: sha256Hex(raw) };
}

/** SHA-256 hex digest of an arbitrary string (tokens, PDF bytes-as-hex, etc). */
export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Hash an incoming raw token from the public /api/sign/[token] route the
 * same way it was hashed at mint time, for a direct token_sha256 lookup.
 * Fails closed on an empty/malformed token (returns a digest that can
 * never match a real row rather than throwing) so callers don't need a
 * separate empty-string guard before the DB lookup.
 */
export function hashIncomingToken(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return sha256Hex(`invalid:${randomBytes(16).toString("hex")}`);
  return sha256Hex(trimmed);
}
