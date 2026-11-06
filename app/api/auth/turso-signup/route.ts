/**
 * Create an account (Turso auth mode) — replaces supabase.auth.signUp.
 *
 * Without this, cancelling Supabase means nobody can ever register again: the
 * Google callback only signs in accounts that already exist, and the signup page
 * fell back to Supabase entirely.
 *
 * Account creation is invite-only. Possession of an active, email-pinned tenant
 * invite is the existing proof-of-mailbox mechanism; without that capability we
 * do not create an auth row and we never mint a session. Public workspace signup
 * stays closed until a real email-verification flow exists.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { rateLimit } from "@/lib/rate-limit";
import {
  SESSION_COOKIE,
  signSession,
  signupUserMetadata,
  tursoAuthActive,
} from "@/lib/turso-auth";
import { validateActiveInviteForEmail } from "@/lib/invite-account-recovery";

export const runtime = "nodejs";

const SESSION_TTL_S = 60 * 60 * 24 * 7;

export async function POST(req: NextRequest) {
  if (!tursoAuthActive()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const gate = rateLimit({ key: `signup:${ip}`, capacity: 5, refillPerSec: 5 / 3600 });
  if (!gate.allowed) {
    return NextResponse.json({ error: "too many attempts" }, { status: 429 });
  }

  let body: { email?: string; password?: string; full_name?: string; invite_token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const rawUserMetadata = signupUserMetadata(body.full_name);
  if (!email.includes("@") || password.length < 8) {
    return NextResponse.json(
      { error: "a valid email and an 8+ character password are required" }, { status: 400 });
  }

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    return NextResponse.json({ error: "auth backend unavailable" }, { status: 503 });
  }
  const db = createClient({ url, authToken });

  const inviteToken = typeof body.invite_token === "string" ? body.invite_token.trim() : "";
  if (!inviteToken) {
    return NextResponse.json(
      {
        code: "invite_required",
        error: "Command Center access is invite-only — ask your workspace admin for a link",
      },
      { status: 403 },
    );
  }

  const invite = await validateActiveInviteForEmail(db, { rawToken: inviteToken, email });
  if (!invite.ok) {
    return NextResponse.json(
      {
        code: invite.error === "email_mismatch" ? "invite_email_mismatch" : "invite_invalid",
        error: invite.error === "email_mismatch"
          ? "this invite was sent to a different email address"
          : "this invite is no longer active — ask your admin for a new link",
      },
      { status: 400 },
    );
  }

  const existing = await db.execute({
    sql: `SELECT id FROM "_supabase_auth_users"
          WHERE lower(email) = ? AND deleted_at IS NULL LIMIT 1`,
    args: [email],
  });
  if (existing.rows.length) {
    // Same copy Supabase used. Signup is inherently an enumeration surface —
    // the honest, actionable message is worth more here than a fiction that
    // sends a real user in circles.
    return NextResponse.json(
      {
        code: "account_exists",
        error: "an account with this email already exists — sign in or reset its password",
      },
      { status: 409 });
  }

  const bcrypt = await import("bcryptjs");
  // $2a$, matching the hashes preserved from Supabase that verifyPassword reads.
  const encrypted = bcrypt.hashSync(password, 10).replace(/^\$2b\$/, "$2a$");
  const id = randomUUID();
  const now = new Date().toISOString();

  try {
    await db.execute({
      sql: `INSERT INTO "_supabase_auth_users"
              (id, email, encrypted_password, raw_user_meta_data,
               created_at, updated_at, session_version)
            VALUES (?, ?, ?, ?, ?, ?, 0)`,
      args: [id, email, encrypted, rawUserMetadata, now, now],
    });
  } catch (e) {
    // A UNIQUE violation here means someone registered the same address between
    // the check above and this insert. Report it as the conflict it is rather
    // than a 500.
    const msg = e instanceof Error ? e.message : "insert failed";
    if (/UNIQUE|constraint/i.test(msg)) {
      return NextResponse.json(
        {
          code: "account_exists",
          error: "an account with this email already exists — sign in or reset its password",
        },
        { status: 409 });
    }
    console.error("[turso-signup] insert failed:", msg);
    return NextResponse.json({ error: "could not create account" }, { status: 500 });
  }

  const res = NextResponse.json({ ok: true, user: { id, email } });
  res.cookies.set({
    name: SESSION_COOKIE,
    value: signSession({
      sub: id,
      email,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
      ver: 0,
    }),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_S,
  });
  return res;
}
