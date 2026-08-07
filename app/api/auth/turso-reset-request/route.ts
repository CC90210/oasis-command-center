/**
 * Password reset, step 1 — request a reset link (Turso auth mode).
 *
 * Replaces supabase.auth.resetPasswordForEmail, which is one of the eight
 * surfaces still tying this dashboard to Supabase Auth. Until all of them move,
 * cancelling the Supabase subscription locks every operator out.
 *
 * Always returns 200 whether or not the account exists — a reset endpoint that
 * answers differently for real and fake addresses is an account-enumeration
 * oracle. When the account does exist, a single-use token (sha256 stored, raw
 * emailed) valid for one hour lands in _auth_tokens.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { createHash, randomBytes } from "node:crypto";
import { rateLimit } from "@/lib/rate-limit";
import { tursoAuthActive } from "@/lib/turso-auth";
import { sendAuthEmail } from "@/lib/auth-email";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!tursoAuthActive()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  // Uniform 200 even when throttled — a 429 here would leak that the address
  // was worth throttling.
  const gate = rateLimit({ key: `reset-req:${ip}`, capacity: 5, refillPerSec: 5 / 900 });
  if (!gate.allowed) return NextResponse.json({ ok: true });

  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) return NextResponse.json({ ok: true });

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) return NextResponse.json({ ok: true });
  const db = createClient({ url, authToken });

  await db.execute(`CREATE TABLE IF NOT EXISTS "_auth_tokens" (
    "token_hash" TEXT PRIMARY KEY, "email" TEXT NOT NULL, "purpose" TEXT NOT NULL,
    "expires_at" TEXT NOT NULL, "used_at" TEXT, "created_at" TEXT NOT NULL)`);

  const user = await db.execute({
    sql: `SELECT id, email FROM "_supabase_auth_users"
          WHERE lower(email) = ? AND deleted_at IS NULL LIMIT 1`,
    args: [email],
  });

  if (user.rows.length) {
    const raw = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(raw).digest("hex");
    await db.execute({
      sql: `INSERT INTO "_auth_tokens" (token_hash, email, purpose, expires_at, created_at)
            VALUES (?, ?, 'password_reset', ?, ?)`,
      args: [hash, email,
             new Date(Date.now() + 60 * 60 * 1000).toISOString(),
             new Date().toISOString()],
    });
    const base = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
    const link = `${base}/auth/reset-password?turso_token=${raw}`;
    await sendAuthEmail({
      to: email,
      subject: "Reset your password",
      text: `A password reset was requested for this address.\n\n`
        + `Reset link (valid 1 hour, single use):\n${link}\n\n`
        + `If you didn't request this, ignore this email — your password is unchanged.`,
    });
  }
  return NextResponse.json({ ok: true });
}
