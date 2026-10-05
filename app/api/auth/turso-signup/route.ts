/**
 * Create an account (Turso auth mode) — replaces supabase.auth.signUp.
 *
 * Without this, cancelling Supabase means nobody can ever register again: the
 * Google callback only signs in accounts that already exist, and the signup page
 * fell back to Supabase entirely.
 *
 * INVITE-ONLY (P0-8, 2026-09-28). An account is created only when the request
 * carries an active tenant invite pinned to this exact address. Signup used to
 * be open: 47 of 49 tenants were strangers' self-signups, and because nothing
 * proved the caller owned the address, registering someone else's email and then
 * provisioning relinked their existing profile — a latent account takeover. No
 * token, a stale token, or a token pinned to another address is 403: the caller
 * is not permitted to create an account, which is different from a malformed
 * request. /signup without a token shows "invite-only — book a call" instead of
 * the form; new client workspaces are operator-provisioned.
 *
 * On success the caller holds a session cookie and redeems the invite through
 * /api/auth/redeem-invite, which attaches them to the inviting tenant.
 *
 * No separate email-confirmation round trip, and now for a stronger reason than
 * before: the invite reached this mailbox by email, so presenting its token is
 * the proof of address ownership that Supabase's confirmation gate existed for.
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
import { getClientIp } from "@/lib/api-helpers";

export const runtime = "nodejs";

const SESSION_TTL_S = 60 * 60 * 24 * 7;

export async function POST(req: NextRequest) {
  if (!tursoAuthActive()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const ip = getClientIp(req);
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
  // Refused before anything else is examined: a caller with no invite gets no
  // feedback about which email or password would have been accepted.
  const inviteToken = typeof body.invite_token === "string" ? body.invite_token.trim() : "";
  if (!inviteToken) {
    return NextResponse.json(
      {
        code: "invite_required",
        error: "OASIS OS is invite-only — open the invite link you were emailed, or book a call",
      },
      { status: 403 },
    );
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

  // The email pin is the whole proof: a leaked token must not mint an account
  // for any address other than the one the invite was sent to.
  const invite = await validateActiveInviteForEmail(db, { rawToken: inviteToken, email });
  if (!invite.ok) {
    return NextResponse.json(
      {
        code: invite.error === "email_mismatch" ? "invite_email_mismatch" : "invite_invalid",
        error: invite.error === "email_mismatch"
          ? "this invite was sent to a different email address"
          : "this invite is no longer active — ask your admin for a new link",
      },
      { status: 403 },
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
