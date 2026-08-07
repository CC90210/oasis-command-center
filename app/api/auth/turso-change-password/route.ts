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
  tursoAuthActive,
  verifyPassword,
  verifySession,
} from "@/lib/turso-auth";

export const runtime = "nodejs";

const MIN_PASSWORD = 8;

export async function POST(req: NextRequest) {
  if (!tursoAuthActive()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const session = verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }
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

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    return NextResponse.json({ error: "auth backend unavailable" }, { status: 503 });
  }
  const db = createClient({ url, authToken });

  // Accounts created through Google OAuth have no password to re-verify, so
  // requiring one would permanently lock them out of ever setting one. Require
  // the current password only when the account actually has one.
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

  if (hasPassword) {
    const ok = await verifyPassword(db, session.email, current);
    if (!ok) {
      return NextResponse.json({ error: "current password is incorrect" }, { status: 401 });
    }
  }

  const bcrypt = await import("bcryptjs");
  // $2a$, matching the hashes preserved from Supabase that verifyPassword reads.
  const encrypted = bcrypt.hashSync(next, 10).replace(/^\$2b\$/, "$2a$");
  const upd = await db.execute({
    sql: `UPDATE "_supabase_auth_users" SET encrypted_password = ?
          WHERE id = ? AND deleted_at IS NULL`,
    args: [encrypted, session.sub],
  });
  if (!upd.rowsAffected) {
    return NextResponse.json({ error: "account not found" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
