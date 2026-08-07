/**
 * Password reset, step 2 — redeem the token and set a new password.
 *
 * Replaces supabase.auth.updateUser({ password }) on the reset page.
 *
 * The token is single-use and consumed with a compare-and-swap: the UPDATE
 * carries `used_at IS NULL` in its WHERE clause, so two concurrent redemptions
 * cannot both win. Checking-then-updating would leave that race open.
 *
 * Writes a $2a$ bcrypt hash, matching what verifyPassword reads and what was
 * preserved from Supabase — so migrated and newly-reset passwords stay
 * indistinguishable and nobody has to reset twice.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { rateLimit } from "@/lib/rate-limit";
import { tursoAuthActive } from "@/lib/turso-auth";

export const runtime = "nodejs";

const MIN_PASSWORD = 8;

export async function POST(req: NextRequest) {
  if (!tursoAuthActive()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const gate = rateLimit({ key: `reset-confirm:${ip}`, capacity: 10, refillPerSec: 10 / 900 });
  if (!gate.allowed) {
    return NextResponse.json({ error: "too many attempts" }, { status: 429 });
  }

  let body: { token?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!token || password.length < MIN_PASSWORD) {
    return NextResponse.json(
      { error: `password must be at least ${MIN_PASSWORD} characters` }, { status: 400 });
  }

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    return NextResponse.json({ error: "auth backend unavailable" }, { status: 503 });
  }
  const db = createClient({ url, authToken });
  const hash = createHash("sha256").update(token).digest("hex");
  const now = new Date().toISOString();

  // Compare-and-swap: claim the token and confirm we were the one who claimed it.
  //
  // unixepoch() on both sides, NOT a string comparison. expires_at and `now`
  // are produced independently, and TEXT comparison silently mis-orders the two
  // common shapes: '2026-08-07 05:55:31' (SQLite datetime) vs
  // '2026-08-07T04:55:31.951Z' (ISO). At character 11 a space sorts before 'T',
  // so a token valid for another hour reads as ALREADY EXPIRED and the user is
  // told their link is invalid with nothing to diagnose. unixepoch parses both.
  const claim = await db.execute({
    sql: `UPDATE "_auth_tokens" SET used_at = ?
          WHERE token_hash = ? AND purpose = 'password_reset'
            AND used_at IS NULL AND unixepoch(expires_at) > unixepoch(?)`,
    args: [now, hash, now],
  });
  if (!claim.rowsAffected) {
    return NextResponse.json(
      { error: "this reset link is invalid, expired, or already used" }, { status: 400 });
  }

  const row = await db.execute({
    sql: `SELECT email FROM "_auth_tokens" WHERE token_hash = ? LIMIT 1`,
    args: [hash],
  });
  const email = String((row.rows[0] as { email?: string } | undefined)?.email ?? "");
  if (!email) {
    return NextResponse.json({ error: "reset link is not usable" }, { status: 400 });
  }

  const bcrypt = await import("bcryptjs");
  // $2a$, not bcryptjs' default $2b$ — verifyPassword compares against hashes
  // preserved from Supabase, which are $2a$.
  const encrypted = bcrypt.hashSync(password, 10).replace(/^\$2b\$/, "$2a$");

  const upd = await db.execute({
    sql: `UPDATE "_supabase_auth_users" SET encrypted_password = ?
          WHERE lower(email) = ? AND deleted_at IS NULL`,
    args: [encrypted, email.toLowerCase()],
  });
  if (!upd.rowsAffected) {
    return NextResponse.json({ error: "account not found" }, { status: 400 });
  }

  // Burn any other outstanding reset tokens for this address — a second link
  // sitting in an inbox is a second way in.
  await db.execute({
    sql: `UPDATE "_auth_tokens" SET used_at = ?
          WHERE lower(email) = ? AND purpose = 'password_reset' AND used_at IS NULL`,
    args: [now, email.toLowerCase()],
  });

  return NextResponse.json({ ok: true });
}
