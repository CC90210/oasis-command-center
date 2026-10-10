/**
 * lib/mcp/bearer.ts - the short-lived bearer a department agent running as a CLI
 * on the operator's PC uses to reach the OASIS MCP server (app/api/mcp).
 *
 *   omcp1.<base64url payload>.<base64url HMAC-SHA256 of "omcp1.<payload>">
 *
 * Payload: { aud:"oasis-mcp", kid, tid, uid, dept, prof:"read"|"propose", sid,
 * iat, exp }, exp - iat <= 60 minutes.
 *
 * The bearer is a CLAIM, not a permission: the server re-reads the member's seat
 * on every call (components/os/department/viewer.ts resolveOsViewerFor), so a
 * removed seat or a lowered role bites at once. Stateless on purpose (no table):
 * revoking everything is rotating the key id - unset the old
 * OASIS_MCP_TOKEN_KEY_<kid> secret and every bearer signed with it stops
 * verifying.
 *
 * Keys: Worker secret OASIS_MCP_TOKEN_KEY_<kid> per key id; OASIS_MCP_TOKEN_KID
 * names the id new bearers are minted under. A kid is 1-16 letters or digits.
 * A missing or short key is "unknown kid": nothing verifies, nothing mints.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const MCP_TOKEN_PREFIX = "omcp1";
export const MCP_TOKEN_AUD = "oasis-mcp";
export const MCP_TOKEN_MAX_TTL_SECONDS = 60 * 60;
export const MCP_TOKEN_MIN_KEY_CHARS = 32;
/** Clock skew allowed on iat, so a Worker a few seconds behind the minter still accepts a fresh bearer. */
const IAT_SKEW_SECONDS = 60;

const KID_RE = /^[A-Za-z0-9]{1,16}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export type McpProfile = "read" | "propose";

export type McpTokenClaims = {
  aud: typeof MCP_TOKEN_AUD;
  kid: string;
  /** Workspace (tenant) id. */
  tid: string;
  /** The member's auth user id. */
  uid: string;
  /** Department key (lib/os/types DepartmentKey). */
  dept: string;
  prof: McpProfile;
  /** Chat session id, for the audit trail. */
  sid: string;
  iat: number;
  exp: number;
};

export type McpTokenFailure = "malformed" | "unknown_kid" | "bad_signature" | "wrong_aud" | "expired" | "not_yet_valid" | "bad_claims";

export type McpTokenEnv = Record<string, string | undefined>;

export type MintInput = {
  tid: string;
  uid: string;
  dept: string;
  prof: McpProfile;
  sid: string;
  /** Seconds, capped at 60 minutes. Default 60 minutes. */
  ttlSeconds?: number;
  /** For tests: the clock (ms) and the env. */
  nowMs?: number;
  env?: McpTokenEnv;
};

export class McpTokenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTokenConfigError";
  }
}

function keyFor(kid: string, env: McpTokenEnv): string | null {
  if (!KID_RE.test(kid)) return null;
  const key = (env[`OASIS_MCP_TOKEN_KEY_${kid}`] || "").trim();
  return key.length >= MCP_TOKEN_MIN_KEY_CHARS ? key : null;
}

const b64u = (buf: Buffer) => buf.toString("base64url");

function sign(key: string, signingInput: string): Buffer {
  return createHmac("sha256", key).update(signingInput, "utf8").digest();
}

/** Mint a bearer for a verified member. Throws McpTokenConfigError when no signing key is configured. */
export function mintMcpToken(input: MintInput): { token: string; exp: number; kid: string } {
  const env = input.env ?? process.env;
  const kid = (env.OASIS_MCP_TOKEN_KID || "").trim();
  const key = keyFor(kid, env);
  if (!key) throw new McpTokenConfigError("oasis_mcp_not_configured");
  if (!input.tid || !input.uid || !input.dept || !input.sid) throw new McpTokenConfigError("mcp_token_claims_missing");
  if (input.prof !== "read" && input.prof !== "propose") throw new McpTokenConfigError("mcp_token_profile_invalid");
  const iat = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const ttl = Math.max(1, Math.min(Math.floor(input.ttlSeconds ?? MCP_TOKEN_MAX_TTL_SECONDS), MCP_TOKEN_MAX_TTL_SECONDS));
  const claims: McpTokenClaims = {
    aud: MCP_TOKEN_AUD,
    kid,
    tid: input.tid,
    uid: input.uid,
    dept: input.dept,
    prof: input.prof,
    sid: input.sid,
    iat,
    exp: iat + ttl,
  };
  const signingInput = `${MCP_TOKEN_PREFIX}.${b64u(Buffer.from(JSON.stringify(claims), "utf8"))}`;
  return { token: `${signingInput}.${b64u(sign(key, signingInput))}`, exp: claims.exp, kid };
}

export type VerifyResult = { ok: true; claims: McpTokenClaims } | { ok: false; reason: McpTokenFailure };

const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null);

/**
 * Verify signature, audience, expiry and key id. Order matters: nothing in the
 * payload is trusted until the signature over it checks out, except `kid`,
 * which is read only to choose WHICH key to check with.
 */
export function verifyMcpToken(token: string, opts: { nowMs?: number; env?: McpTokenEnv } = {}): VerifyResult {
  const env = opts.env ?? process.env;
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || parts[0] !== MCP_TOKEN_PREFIX || !B64URL_RE.test(parts[1]) || !B64URL_RE.test(parts[2])) {
    return { ok: false, reason: "malformed" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!raw || typeof raw !== "object") return { ok: false, reason: "malformed" };
  const p = raw as Record<string, unknown>;

  const kid = typeof p.kid === "string" ? p.kid : "";
  const key = keyFor(kid, env);
  if (!key) return { ok: false, reason: "unknown_kid" };

  const given = Buffer.from(parts[2], "base64url");
  const expected = sign(key, `${parts[0]}.${parts[1]}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };

  if (p.aud !== MCP_TOKEN_AUD) return { ok: false, reason: "wrong_aud" };

  const iat = p.iat;
  const exp = p.exp;
  if (typeof iat !== "number" || typeof exp !== "number" || !Number.isFinite(iat) || !Number.isFinite(exp)) {
    return { ok: false, reason: "bad_claims" };
  }
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (nowSec >= exp) return { ok: false, reason: "expired" };
  if (iat > nowSec + IAT_SKEW_SECONDS) return { ok: false, reason: "not_yet_valid" };
  if (exp - iat > MCP_TOKEN_MAX_TTL_SECONDS || exp <= iat) return { ok: false, reason: "bad_claims" };

  const tid = str(p.tid);
  const uid = str(p.uid);
  const dept = str(p.dept);
  const sid = str(p.sid);
  if (!tid || !uid || !dept || !sid || (p.prof !== "read" && p.prof !== "propose")) return { ok: false, reason: "bad_claims" };
  return { ok: true, claims: { aud: MCP_TOKEN_AUD, kid, tid, uid, dept, prof: p.prof, sid, iat, exp } };
}
