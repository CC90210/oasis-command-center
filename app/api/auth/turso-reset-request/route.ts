/**
 * Turso password-reset request.
 *
 * Unauthenticated responses stay uniform to prevent account enumeration. A
 * signed-in user requesting their own reset may receive a delivery/config error
 * because the session has already proven that account exists.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { createHash, randomBytes } from "node:crypto";
import { rateLimit } from "@/lib/rate-limit";
import { tursoAuthActive } from "@/lib/turso-auth";
import { sendAuthEmail } from "@/lib/auth-email";
import { getSessionUser } from "@/lib/supabase-server";
import { validateActiveInviteForEmail } from "@/lib/invite-account-recovery";

export const runtime = "nodejs";

function unavailableForAuthenticatedSelf(isAuthenticatedSelf: boolean) {
  return isAuthenticatedSelf
    ? NextResponse.json(
        { error: "Account-security email is unavailable. Please try again later." },
        { status: 503 },
      )
    : NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  if (!tursoAuthActive()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const gate = rateLimit({ key: `reset-req:${ip}`, capacity: 5, refillPerSec: 5 / 900 });
  if (!gate.allowed) return NextResponse.json({ ok: true });

  let body: { email?: string; invite_token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) return NextResponse.json({ ok: true });

  const sessionUser = await getSessionUser().catch(() => null);
  const isAuthenticatedSelf =
    !!sessionUser?.email && sessionUser.email.trim().toLowerCase() === email;
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) return unavailableForAuthenticatedSelf(isAuthenticatedSelf);
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
    const requestedInvite = typeof body.invite_token === "string"
      ? body.invite_token.trim()
      : "";
    let verifiedInvite = "";
    if (requestedInvite) {
      const validation = await validateActiveInviteForEmail(db, {
        rawToken: requestedInvite,
        email,
      });
      // Deliberately do not expose whether the token or email pin failed.
      // Password reset still proceeds; only the tenant continuation is dropped.
      // Auto-continuation is restricted to an invite explicitly pinned to
      // this address. An open invite remains usable through its original link,
      // but cannot be injected into an unrelated account-security email.
      if (validation.ok && validation.emailPinned) verifiedInvite = requestedInvite;
    }

    const issuedAt = new Date().toISOString();
    // Keep one active reset capability per account. Repeated clicks invalidate
    // older messages before the new token is issued.
    await db.execute({
      sql: `UPDATE "_auth_tokens" SET used_at = ?
            WHERE lower(email) = ? AND purpose = 'password_reset' AND used_at IS NULL`,
      args: [issuedAt, email],
    });

    const raw = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(raw).digest("hex");
    await db.execute({
      sql: `INSERT INTO "_auth_tokens" (token_hash, email, purpose, expires_at, created_at)
            VALUES (?, ?, 'password_reset', ?, ?)`,
      args: [hash, email, new Date(Date.now() + 60 * 60 * 1000).toISOString(), issuedAt],
    });

    const base = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
    const resetUrl = new URL("/auth/reset-password", base);
    resetUrl.searchParams.set("turso_token", raw);
    resetUrl.searchParams.set("email", email);
    if (verifiedInvite) resetUrl.searchParams.set("invite", verifiedInvite);
    const link = resetUrl.toString();
    const delivery = await sendAuthEmail({
      to: email,
      subject: "Reset your OASIS AI password",
      text:
        `A password reset was requested for your OASIS AI account.\n\n` +
        `Reset link (valid 1 hour, single use):\n${link}\n\n` +
        `If you didn't request this, ignore this email — your password is unchanged.`,
    });
    if (!delivery.ok) {
      // Delivery failed: immediately consume the token so an undelivered secret
      // never remains active in the credential table.
      await db.execute({
        sql: `UPDATE "_auth_tokens" SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`,
        args: [new Date().toISOString(), hash],
      });
      console.error("[turso-reset-request] auth mail delivery failed", {
        code: delivery.code,
        authenticatedSelf: isAuthenticatedSelf,
      });
      return unavailableForAuthenticatedSelf(isAuthenticatedSelf);
    }
  }

  return NextResponse.json({ ok: true });
}
