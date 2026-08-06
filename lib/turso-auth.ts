/**
 * turso-auth â€” Supabase Auth replacement for the password login path.
 *
 * WHY THIS IS SAFE TO SWAP. Supabase Auth's password flow is: bcrypt-verify the
 * password against auth.users.encrypted_password, then issue a signed session
 * cookie. Both halves are replaceable with primitives we fully control:
 *   - the SAME bcrypt hashes were preserved into _supabase_auth_users during
 *     the migration (users keep their exact passwords â€” no resets, no emails)
 *   - the session becomes an HMAC-SHA256-signed HttpOnly cookie minted here
 *
 * All 12 of this app's users are password users (auth-method census
 * 2026-08-05: zero OAuth identities), so this module covers 100% of logins.
 *
 * Env:
 *   AUTH_SESSION_SECRET   64+ chars random. Signing key for session cookies.
 *                         Rotating it logs everyone out (that is the kill switch).
 *   EMPIRE_AUTH_BACKEND   "turso" activates this path in middleware/login.
 *
 * Threat notes: timing-safe HMAC comparison; constant-shape errors from login
 * (no user-enumeration); session carries user id + email + expiry only â€” no
 * roles baked in, authorization stays in the route layer where it already is.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { compare } from "bcryptjs";
import type { Client } from "@libsql/client";

export const SESSION_COOKIE = "oasis_session";
const SESSION_TTL_S = 60 * 60 * 24 * 7; // 7 days, matching Supabase's default refresh window

export interface TursoSession {
  sub: string;      // auth user id (same uuid as auth.users.id â€” FK-compatible)
  email: string;
  exp: number;      // unix seconds
}

function secret(): string {
  const s = process.env.AUTH_SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      "AUTH_SESSION_SECRET missing/short â€” refusing to mint or verify sessions. "
      + "Set a 64-char random value (vercel_env_tool set-random).");
  }
  return s;
}

const b64u = (buf: Buffer) => buf.toString("base64url");

export function signSession(payload: TursoSession): string {
  const body = b64u(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = b64u(createHmac("sha256", secret()).update(body).digest());
  return `${body}.${mac}`;
}

export function verifySession(token: string | undefined | null): TursoSession | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expect = b64u(createHmac("sha256", secret()).update(body).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TursoSession;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Verify email+password against the preserved Supabase hashes.
 * Returns a session payload on success, null on ANY failure (same shape/time
 * profile for wrong-email and wrong-password â€” no enumeration).
 */
export async function verifyPassword(
  client: Client, email: string, password: string,
): Promise<TursoSession | null> {
  const norm = email.trim().toLowerCase();
  const res = await client.execute({
    sql: `SELECT id, email, encrypted_password FROM "_supabase_auth_users"
          WHERE lower(email) = ? AND encrypted_password IS NOT NULL
            AND encrypted_password <> '' AND (banned_until IS NULL OR banned_until < ?)
            AND deleted_at IS NULL LIMIT 1`,
    args: [norm, new Date().toISOString()],
  });
  // Constant-work fallback: verify against a burner hash when no row matches,
  // so response timing does not reveal whether the account exists.
  const BURNER = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
  const row = res.rows[0] as { id?: string; email?: string; encrypted_password?: string } | undefined;
  const ok = await compare(password, String(row?.encrypted_password ?? BURNER));
  if (!row || !ok) return null;
  return {
    sub: String(row.id),
    email: String(row.email),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
  };
}

export function tursoAuthActive(): boolean {
  return process.env.EMPIRE_AUTH_BACKEND === "turso" && !!process.env.AUTH_SESSION_SECRET;
}

