/**
 * lib/mcp/bearer.ts - the short-lived bearer a department agent running as a CLI
 * on the operator's PC uses to reach the OASIS MCP server (app/api/mcp).
 *
 *   omcp1.<base64url payload>.<base64url HMAC-SHA256 of "omcp1.<payload>">
 *
 * Payload: { aud:"oasis-mcp", kid, tid, uid, dept, prof:"read"|"propose", sid,
 * iat, exp, rid?, pid?, sv?, orig? }, exp - iat <= 60 minutes.
 *
 *   rid   (O4) the run this bearer was minted for, pull-dispatched to a
 *         person's own paired computer. Absent on the legacy push path (the
 *         workspace tunnel, B2's interim branch), which names no run.
 *   pid   (O4) the pairing (computer) the bearer was minted for.
 *   sv    (O4) the auth user's session_version at mint time: a password
 *         change or deactivation bumps it, which invalidates every bearer
 *         minted before (lib/os/seat.ts liveSeat).
 *   orig  (O4) the run's origin ('chat' | 'automation' | 'test'), so a tool
 *         can tell an unattended automation turn from a live chat turn.
 *
 * The bearer is a CLAIM, not a permission: the server re-reads the member's seat
 * on every call (components/os/department/viewer.ts resolveOsViewerFor), so a
 * removed seat or a lowered role bites at once. For an O4 bearer (rid set) it
 * ALSO re-checks, on every call, that the named run is still running on a
 * computer, still belongs to this person, and is still claimed by THIS
 * pairing, unrevoked (lib/mcp/tools.ts resolveMcpSession) -- disconnecting
 * that computer must stop its MCP calls at once, not at token expiry.
 *
 * Keys: an explicit Worker secret, OASIS_MCP_TOKEN_KEY_<kid>, wins when it is
 * set with at least MCP_TOKEN_MIN_KEY_CHARS characters. Otherwise, for kid ==
 * MCP_DERIVED_KID ('d1') only, and only while OASIS_MCP_DERIVED_KID_DISABLED
 * is unset, the key is derived from AUTH_SESSION_SECRET
 * (lib/crypto/derived-keys.ts) -- O4 ships with no new Cloudflare secret.
 * mintMcpToken mints under OASIS_MCP_TOKEN_KID when set, else MCP_DERIVED_KID.
 * A kid is 1-16 letters or digits. No usable key at all is "unknown kid":
 * nothing verifies, nothing mints.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveKey, derivedKidDisabled, DERIVED_KEY_LABELS, MCP_DERIVED_KID } from "@/lib/crypto/derived-keys";

export { MCP_DERIVED_KID };

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
  /** O4: the run this bearer was minted for (pull dispatch). Absent on the legacy push path. */
  rid?: string;
  /** O4: the pairing (computer) that claimed `rid`. */
  pid?: string;
  /** O4: the auth user's session_version at mint time. */
  sv?: number;
  /** O4: the run's origin. */
  orig?: "chat" | "automation" | "test";
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
  /** O4 claims; see McpTokenClaims. */
  rid?: string;
  pid?: string;
  sv?: number;
  orig?: "chat" | "automation" | "test";
};

export class McpTokenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTokenConfigError";
  }
}

/**
 * The signing key for `kid`: an explicit Worker secret
 * (OASIS_MCP_TOKEN_KEY_<kid>) always wins when it is long enough. Otherwise,
 * ONLY for kid === MCP_DERIVED_KID ('d1'), and only while
 * OASIS_MCP_DERIVED_KID_DISABLED is unset, the key is derived from
 * AUTH_SESSION_SECRET under the 'mcp' label (lib/crypto/derived-keys.ts). Any
 * other kid with no explicit key is "unknown kid": nothing verifies.
 */
async function keyFor(kid: string, env: McpTokenEnv): Promise<string | null> {
  if (!KID_RE.test(kid)) return null;
  const explicit = (env[`OASIS_MCP_TOKEN_KEY_${kid}`] || "").trim();
  if (explicit.length >= MCP_TOKEN_MIN_KEY_CHARS) return explicit;
  if (kid !== MCP_DERIVED_KID || derivedKidDisabled(env)) return null;
  try {
    return await deriveKey(DERIVED_KEY_LABELS.mcp, { env });
  } catch {
    return null;
  }
}

const b64u = (buf: Buffer) => buf.toString("base64url");

function sign(key: string, signingInput: string): Buffer {
  return createHmac("sha256", key).update(signingInput, "utf8").digest();
}

/** Mint a bearer for a verified member. Throws McpTokenConfigError when no signing key is configured. */
export async function mintMcpToken(input: MintInput): Promise<{ token: string; exp: number; kid: string }> {
  const env = input.env ?? process.env;
  const kid = (env.OASIS_MCP_TOKEN_KID || "").trim() || MCP_DERIVED_KID;
  const key = await keyFor(kid, env);
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
    ...(input.rid ? { rid: input.rid } : {}),
    ...(input.pid ? { pid: input.pid } : {}),
    ...(input.sv !== undefined ? { sv: input.sv } : {}),
    ...(input.orig ? { orig: input.orig } : {}),
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
export async function verifyMcpToken(token: string, opts: { nowMs?: number; env?: McpTokenEnv } = {}): Promise<VerifyResult> {
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
  const key = await keyFor(kid, env);
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
  // O4 claims: optional, and validated loosely -- a malformed one is simply
  // dropped (treated as absent), never a reason to refuse an otherwise-valid
  // legacy (push-path) bearer that carries none of them.
  const rid = str(p.rid) ?? undefined;
  const pid = str(p.pid) ?? undefined;
  const sv = typeof p.sv === "number" && Number.isFinite(p.sv) ? p.sv : undefined;
  const orig = p.orig === "chat" || p.orig === "automation" || p.orig === "test" ? p.orig : undefined;
  return {
    ok: true,
    claims: { aud: MCP_TOKEN_AUD, kid, tid, uid, dept, prof: p.prof, sid, iat, exp, ...(rid ? { rid } : {}), ...(pid ? { pid } : {}), ...(sv !== undefined ? { sv } : {}), ...(orig ? { orig } : {}) },
  };
}
