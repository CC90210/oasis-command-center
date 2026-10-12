/**
 * lib/crypto/derived-keys.ts - HKDF-SHA256 (RFC 5869) over the Worker's own
 * AUTH_SESSION_SECRET, so O4's run and MCP bearers need NO new Cloudflare
 * secret: one master key already in production, one label per token kind.
 *
 * WHY THIS IS SAFE TO SHARE A MASTER KEY ACROSS THREE TOKEN KINDS. HKDF's
 * whole point is domain separation: deriveKey(label) for one label reveals
 * nothing about deriveKey(other label) or about AUTH_SESSION_SECRET itself,
 * as long as each label is distinct and the master key never leaves this
 * module. Every derived token is ALSO bound to the person's live seat and
 * session version at verify time (lib/os/seat.ts liveSeat) -- so a leaked
 * derived key alone still reaches nothing a removed person's cookie could
 * not already be stopped from reaching.
 *
 * NEVER derive from OASIS_OUTBOUND_HMAC_SECRET (shared with the VPS and
 * Bravo's self-pair), BRIDGE_BEARER_TOKEN_* (held by a PC) or
 * CHAT_RESUME_HMAC_KEY (a lower-power key: a leak there would ESCALATE if it
 * could also forge a run or MCP bearer). AUTH_SESSION_SECRET is the one
 * already-provisioned secret this slice may read.
 *
 * WEB CRYPTO ONLY (crypto.subtle), never node:crypto: this runs inside the
 * Cloudflare Worker (workerd), where node:crypto is not guaranteed without an
 * explicit compat polyfill this repo does not carry for HMAC. Web Crypto is
 * available in every runtime Next.js on Cloudflare uses, Node test scripts
 * included.
 *
 * RFC 5869, two steps:
 *   PRK = HMAC-SHA256(salt, IKM)                              (Extract)
 *   T(0) = ""; T(i) = HMAC-SHA256(PRK, T(i-1) || info || i)    (Expand)
 *   OKM  = T(1) || T(2) || ... , truncated to `length` bytes
 * `hkdfSha256` is the general primitive (tested against the official RFC
 * 5869 SHA-256 test case 1 vector). `deriveKey` is the one this estate's
 * tokens call: IKM = AUTH_SESSION_SECRET, salt = DERIVED_KEYS_SALT, info =
 * the label, length = 32 bytes, output as 64 lowercase hex characters.
 */
import "server-only";

/** Fixed across every derivation: changing it would silently re-key everything derived here. */
export const DERIVED_KEYS_SALT = "oasis-derived-keys/v1";

/** The one label per token kind this slice mints; kept together so a typo never derives a fourth, unintended key. */
export const DERIVED_KEY_LABELS = {
  mcp: "oasis-mcp-token/d1",
  run: "oasis-run-token/v1",
  inferJob: "oasis-infer-job/v1",
  offerUpload: "offer-upload-v1",
} as const;

export type DerivedKeyLabel = (typeof DERIVED_KEY_LABELS)[keyof typeof DERIVED_KEY_LABELS];

const enc = new TextEncoder();

function toBytes(v: string | Uint8Array): Uint8Array {
  return typeof v === "string" ? enc.encode(v) : v;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, data as BufferSource);
  return new Uint8Array(sig);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const HASH_LEN = 32;
/** RFC 5869 bound: Expand may not be asked for more than 255 * HashLen bytes. */
const MAX_LENGTH = 255 * HASH_LEN;

/**
 * The general RFC 5869 HKDF-SHA256 primitive. Exported so the RFC test
 * vector can exercise it directly, apart from this estate's own salt/labels.
 */
export async function hkdfSha256(ikm: string | Uint8Array, salt: string | Uint8Array, info: string | Uint8Array, length: number): Promise<Uint8Array> {
  if (!Number.isInteger(length) || length < 1 || length > MAX_LENGTH) {
    throw new Error(`hkdfSha256: length must be between 1 and ${MAX_LENGTH} bytes`);
  }
  const ikmBytes = toBytes(ikm);
  const saltBytes = toBytes(salt);
  const infoBytes = toBytes(info);
  const prk = await hmacSha256(saltBytes, ikmBytes);

  const blocks: Uint8Array[] = [];
  let previous: Uint8Array = new Uint8Array(0);
  let produced = 0;
  let counter = 1;
  while (produced < length) {
    if (counter > 255) throw new Error("hkdfSha256: expand exceeded 255 rounds");
    const t = await hmacSha256(prk, concat(previous, infoBytes, Uint8Array.of(counter)));
    blocks.push(t);
    previous = t;
    produced += t.length;
    counter += 1;
  }
  return concat(...blocks).slice(0, length);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export type DeriveKeyEnv = Record<string, string | undefined>;

/**
 * This estate's own derivation: AUTH_SESSION_SECRET as the IKM, the fixed
 * salt, `label` as the HKDF info, 32-byte output as 64 lowercase hex
 * characters. Throws when AUTH_SESSION_SECRET is missing or too short to be
 * a real master key -- a derived key must never be mintable from an empty
 * or placeholder secret.
 */
export async function deriveKey(label: string, opts: { env?: DeriveKeyEnv } = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const master = (env.AUTH_SESSION_SECRET || "").trim();
  if (master.length < 32) throw new Error("deriveKey: AUTH_SESSION_SECRET is missing or too short to derive from");
  if (!label) throw new Error("deriveKey: a label is required");
  const okm = await hkdfSha256(master, DERIVED_KEYS_SALT, label, HASH_LEN);
  return toHex(okm);
}

/** The one kid every derived key mints and verifies under, unless an explicit key or the disable switch overrides it. */
export const MCP_DERIVED_KID = "d1";

/**
 * Whether derived 'd1' bearers are switched off (an emergency Worker
 * variable, no code change needed to stop trusting them). Any non-empty
 * value disables; unset or empty leaves derivation on.
 */
export function derivedKidDisabled(env: DeriveKeyEnv = process.env): boolean {
  return Boolean((env.OASIS_MCP_DERIVED_KID_DISABLED || "").trim());
}
