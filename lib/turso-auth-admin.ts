/**
 * turso-auth-admin — the SERVICE-ROLE half of Supabase Auth, ported to the
 * migrated auth store.
 *
 * lib/turso-auth.ts covers the user-facing half (verify a password, mint and
 * verify a session cookie). It does not cover the three admin calls the team-
 * invite path makes on behalf of a user who has no session yet:
 *
 *   auth.admin.getUserById      -> read id/email for the invite email-pin check
 *   auth.admin.updateUserById   -> { email_confirm: true }
 *   auth.admin.generateLink     -> a one-time link that lands a session
 *
 * Those are GoTrue HTTP endpoints. When the Supabase project is cancelled they
 * stop existing, and every one of them throws (getServiceSupabase() hands back
 * a Proxy whose `auth` getter raises by design). The result is that nobody can
 * join a team: redeemInvite() dies on getUserById before it ever reaches the
 * already-ported redeem_tenant_invite RPC.
 *
 * All three are replaceable with SQL against tables that were migrated:
 *   _supabase_auth_users   id, email, email_confirmed_at, banned_until,
 *                          deleted_at, updated_at  (etl_auth_to_turso.py)
 *   _auth_tokens           single-use token store already used by the
 *                          password-reset flow (TURSO_NATIVE_TABLES)
 *
 * DISPATCH. Each exported admin call takes the SupabaseClient the caller
 * already holds and routes to GoTrue when EMPIRE_AUTH_BACKEND is not "turso".
 * Supabase mode is therefore behaviourally unchanged; Turso mode never touches
 * the network. There is no third branch — an unconfigured Turso client throws
 * out of getTursoClient() with a message naming the missing env var.
 */

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTursoClient } from "@/lib/turso";
import { tursoAuthActive } from "@/lib/turso-auth";

const AUTH_USERS = '"_supabase_auth_users"';
const AUTH_TOKENS = '"_auth_tokens"';

/** Purpose tag for the one-time link that replaces generateLink('magiclink'). */
export const SESSION_LINK_PURPOSE = "desktop_session";

/**
 * 15 minutes — deliberately the pair-code's own TTL, not Supabase's 1-hour
 * magic-link default. The link is minted by a pair-code redemption and consumed
 * by the desktop app seconds later; a wider window is leak surface for nothing.
 */
export const SESSION_LINK_TTL_MS = 15 * 60 * 1000;

export type AuthUserRecord = {
  id: string;
  email: string | null;
  /** From raw_user_meta_data. redeem_tenant_invite needs it — Postgres read it
   *  from auth.users itself, and without it a new profile's full_name becomes
   *  the user's email address. */
  fullName: string | null;
};

/**
 * Clamp a caller-supplied redirect to a same-origin absolute path.
 *
 * Whoever holds a sign-in link controls `next`, and the browser follows it
 * holding a session cookie that was just minted — so "//evil.com" or an
 * absolute URL must never survive. Lives here rather than in the route so it
 * is directly testable; route.ts files can only export HTTP verbs.
 */
export function safeInternalPath(raw: string | null | undefined): string {
  if (!raw || raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  // Backslashes may be normalized into slashes by browsers. Control characters
  // are not meaningful application routes and create parser disagreement.
  if (raw.includes("\\") || /[\u0000-\u001F\u007F]/u.test(raw)) return "/";
  try {
    const base = new URL("https://oasis.invalid");
    const parsed = new URL(raw, base);
    if (parsed.origin !== base.origin) return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

/** Recover only the opaque base64url token shape used by `/invite/[token]`. */
export function inviteTokenFromPath(path: string): string | null {
  const match = path.match(/^\/invite\/([A-Za-z0-9_-]{16,512})$/u);
  return match?.[1] ?? null;
}

export type AdminResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function text(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/**
 * Display name out of Supabase's raw_user_meta_data.
 *
 * Postgres read this inside redeem_tenant_invite via auth.users; there is no
 * auth.users under Turso, so the caller has to supply it — and without it a new
 * member's profile is created with full_name set to their email address.
 *
 * The metadata survived the migration (verified: 57 rows carry it) but its
 * shape differs by provider — email signups store `full_name`, Google OAuth
 * stores `name`. Checking only one silently loses the other half of the users.
 */
function displayName(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let meta: unknown = raw;
  if (typeof raw === "string") {
    try {
      meta = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  for (const key of ["full_name", "name"]) {
    const v = m[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Look up an auth user by id. Replaces auth.admin.getUserById.
 *
 * Soft-deleted rows are excluded, matching GoTrue — a deleted user must not
 * satisfy an invite's email pin.
 */
export async function adminGetUser(
  db: SupabaseClient,
  userId: string,
): Promise<AdminResult<AuthUserRecord>> {
  if (!tursoAuthActive()) {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error || !data?.user) {
      return { ok: false, error: error?.message || "auth_user_not_found" };
    }
    return {
      ok: true,
      value: {
        id: data.user.id,
        email: data.user.email ?? null,
        fullName: displayName(data.user.user_metadata),
      },
    };
  }
  const res = await getTursoClient().execute({
    sql: `SELECT id, email, raw_user_meta_data FROM ${AUTH_USERS}
          WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [userId],
  });
  const row = res.rows[0] as
    | { id?: unknown; email?: unknown; raw_user_meta_data?: unknown }
    | undefined;
  if (!row) return { ok: false, error: "auth_user_not_found" };
  return {
    ok: true,
    value: {
      id: String(row.id),
      email: text(row.email),
      fullName: displayName(row.raw_user_meta_data),
    },
  };
}

/**
 * Mark an address as confirmed. Replaces
 * auth.admin.updateUserById(id, { email_confirm: true }).
 *
 * Idempotent, like the GoTrue call it replaces — but "already confirmed" and
 * "no such user" are NOT collapsed. A bare `rowsAffected === 0 -> success`
 * would report ok:true for a userId that does not exist, and the invite-
 * finalize route would then go on to redeem an invite for a phantom account.
 * So a zero-row UPDATE is re-checked against the users table before it is
 * allowed to count as success.
 */
export async function adminConfirmEmail(
  db: SupabaseClient,
  userId: string,
): Promise<AdminResult<{ alreadyConfirmed: boolean }>> {
  if (!tursoAuthActive()) {
    const { error } = await db.auth.admin.updateUserById(userId, { email_confirm: true });
    if (error) return { ok: false, error: error.message };
    return { ok: true, value: { alreadyConfirmed: false } };
  }
  const now = new Date().toISOString();
  const upd = await getTursoClient().execute({
    sql: `UPDATE ${AUTH_USERS} SET email_confirmed_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL AND email_confirmed_at IS NULL`,
    args: [now, now, userId],
  });
  if (upd.rowsAffected > 0) return { ok: true, value: { alreadyConfirmed: false } };
  const found = await adminGetUser(db, userId);
  if (!found.ok) return found;
  return { ok: true, value: { alreadyConfirmed: true } };
}

/**
 * Mint a single-use sign-in token for `email`. Replaces the token half of
 * auth.admin.generateLink({ type: "magiclink" }); the URL is assembled by the
 * caller and redeemed at /auth/turso-session.
 *
 * Only the sha256 of the token is stored, so a dump of _auth_tokens is not a
 * set of working sign-in links — the same shape the password-reset flow uses.
 *
 * Turso-only. Callers must check tursoAuthActive() first; under Supabase this
 * throws rather than silently minting a token no route can redeem.
 */
export async function mintSessionLinkToken(
  email: string,
  ttlMs: number = SESSION_LINK_TTL_MS,
): Promise<string> {
  if (!tursoAuthActive()) {
    throw new Error(
      "mintSessionLinkToken called with EMPIRE_AUTH_BACKEND != turso — " +
      "use auth.admin.generateLink on the Supabase path instead.",
    );
  }
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) {
    throw new Error("mintSessionLinkToken: an email address is required");
  }
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  const now = Date.now();
  await getTursoClient().execute({
    sql: `INSERT INTO ${AUTH_TOKENS} (token_hash, email, purpose, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [
      hash,
      normalized,
      SESSION_LINK_PURPOSE,
      new Date(now + ttlMs).toISOString(),
      new Date(now).toISOString(),
    ],
  });
  return raw;
}

/**
 * Redeem a token minted by mintSessionLinkToken and resolve the account it
 * signs in. Returns null for unknown / expired / already-used tokens and for
 * addresses with no live account.
 *
 * Consumed with a compare-and-swap (`used_at IS NULL` inside the UPDATE), so
 * two concurrent redemptions cannot both win — a check-then-update would leave
 * that race open, and the prize is a session.
 *
 * unixepoch() on both sides of the expiry test, NOT string comparison: the
 * stored ISO timestamp and a SQLite-rendered one differ at character 11
 * (' ' vs 'T'), which silently mis-orders them. That exact bug is documented in
 * turso-reset-confirm.
 *
 * The token is burned before the account lookup runs. If the address has no
 * usable account the caller gets null AND the token is spent — correct: a token
 * that survives a failed redemption is a retryable credential.
 */
export async function consumeSessionLinkToken(
  rawToken: string,
): Promise<{ id: string; email: string; sessionVersion: number } | null> {
  if (!rawToken) return null;
  const client = getTursoClient();
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const now = new Date().toISOString();

  const claim = await client.execute({
    sql: `UPDATE ${AUTH_TOKENS} SET used_at = ?
          WHERE token_hash = ? AND purpose = ? AND used_at IS NULL
            AND unixepoch(expires_at) > unixepoch(?)`,
    args: [now, hash, SESSION_LINK_PURPOSE, now],
  });
  if (!claim.rowsAffected) return null;

  const res = await client.execute({
    sql: `SELECT u.id AS id, u.email AS email, u.session_version AS session_version
          FROM ${AUTH_TOKENS} t
          JOIN ${AUTH_USERS} u ON lower(u.email) = lower(t.email)
          WHERE t.token_hash = ?
            AND u.deleted_at IS NULL
            AND (u.banned_until IS NULL OR unixepoch(u.banned_until) < unixepoch(?))
          LIMIT 1`,
    args: [hash, now],
  });
  const row = res.rows[0] as {
    id?: unknown;
    email?: unknown;
    session_version?: unknown;
  } | undefined;
  if (!row || !row.id || !row.email) return null;
  const sessionVersion = Number(row.session_version ?? 0);
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) return null;
  return { id: String(row.id), email: String(row.email), sessionVersion };
}
