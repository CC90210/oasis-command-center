/**
 * Change password while signed in — replaces supabase.auth.updateUser({ password }).
 *
 * Requires the CURRENT password. Supabase's updateUser did not, because it
 * trusted its own session; re-verifying here means a stolen session cookie
 * cannot be used to lock the real owner out of their account.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { rateLimit } from "@/lib/rate-limit";
import {
  SESSION_COOKIE,
  SESSION_TTL_S,
  signSession,
  tursoAuthActive,
  verifyPassword,
  verifySessionAgainstDb,
} from "@/lib/turso-auth";

export const runtime = "nodejs";

const MIN_PASSWORD = 8;

export async function POST(req: NextRequest) {
  if (!tursoAuthActive()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    return NextResponse.json({ error: "auth backend unavailable" }, { status: 503 });
  }
  const db = createClient({ url, authToken });
  const session = await verifySessionAgainstDb(
    db,
    req.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  // Throttle per ACCOUNT, not per IP — this is an authenticated endpoint, so
  // the account is the thing worth protecting from password guessing.
  const gate = rateLimit({ key: `change-pw:${session.sub}`, capacity: 10,
                           refillPerSec: 10 / 900 });
  if (!gate.allowed) {
    return NextResponse.json({ error: "too many attempts" }, { status: 429 });
  }

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next = typeof body.newPassword === "string" ? body.newPassword : "";
  if (next.length < MIN_PASSWORD) {
    return NextResponse.json(
      { error: `password must be at least ${MIN_PASSWORD} characters` }, { status: 400 });
  }

  // A Google-only account has no current password with which to prove a
  // step-up. A session cookie alone is not enough to establish permanent
  // password access: a stolen browser session would become a durable login.
  // The email reset flow proves mailbox control and is the supported path.
  const existing = await db.execute({
    sql: `SELECT encrypted_password FROM "_supabase_auth_users"
          WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [session.sub],
  });
  if (!existing.rows.length) {
    return NextResponse.json({ error: "account not found" }, { status: 400 });
  }
  const hasPassword = Boolean(
    (existing.rows[0] as { encrypted_password?: string }).encrypted_password);

  if (!hasPassword) {
    return NextResponse.json(
      {
        code: "password_reset_required",
        error: "Use Reset via email to create a password for this Google-only account.",
      },
      { status: 403 },
    );
  }
  const ok = await verifyPassword(db, session.email, current);
  if (!ok) {
    return NextResponse.json({ error: "current password is incorrect" }, { status: 401 });
  }

  const bcrypt = await import("bcryptjs");
  // $2a$, matching the hashes preserved from Supabase that verifyPassword reads.
  const encrypted = bcrypt.hashSync(next, 10).replace(/^\$2b\$/, "$2a$");
  const now = new Date().toISOString();
  const upd = await db.execute({
    sql: `UPDATE "_supabase_auth_users"
          SET encrypted_password = ?, updated_at = ?, session_version = session_version + 1
          WHERE id = ? AND deleted_at IS NULL AND session_version = ?`,
    args: [encrypted, now, session.sub, session.ver],
  });
  if (!upd.rowsAffected) {
    return NextResponse.json(
      { error: "your session changed; sign in again before changing the password" },
      { status: 409 },
    );
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: signSession({
      sub: session.sub,
      email: session.email,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
      ver: session.ver + 1,
    }),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_S,
  });
  return response;
}
