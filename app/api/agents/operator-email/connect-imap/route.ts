/**
 * Connect a mailbox to the Operator Email Agent by Gmail App Password (IMAP
 * monitor + SMTP send) — the OAuth-free path. Verifies BOTH an IMAP read
 * handshake AND an SMTP auth handshake before persisting anything: fail-closed,
 * nothing is stored unless both succeed. The password is never returned.
 *
 * Two auth modes:
 *   - self-serve: the signed-in operator connects their OWN mailbox (session)
 *   - admin seed: Bearer SCAN_TRIGGER_SECRET + { tenantId, userId } in the body
 *
 * Stored per-user in user_integration_credentials (gmail_imap / gmail_imap_personal),
 * encrypted with BRAVO_FIELD_ENCRYPTION_KEY. Read path: imap-read.ts.
 */

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { resolveSessionContext } from "@/lib/api-auth";
import { setUserIntegrationBundle } from "@/lib/user-integration-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function bearerOk(req: NextRequest): boolean {
  const secret = process.env.SCAN_TRIGGER_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization") || "";
  const t = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = Buffer.from(t);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** IMAP read handshake. Returns null on success, an error string otherwise. */
async function verifyImap(address: string, appPassword: string): Promise<string | null> {
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true,
    auth: { user: address, pass: appPassword }, logger: false,
    greetingTimeout: 12_000, socketTimeout: 20_000,
  });
  try {
    await client.connect();
    await client.logout();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : "imap_failed";
  }
}

/** SMTP auth handshake. Returns null on success, an error string otherwise. */
async function verifySmtp(address: string, appPassword: string): Promise<string | null> {
  const nodemailer = await import("nodemailer");
  const t = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 587, secure: false, requireTLS: true,
    auth: { user: address, pass: appPassword },
  });
  try {
    await t.verify();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : "smtp_failed";
  }
}

export async function POST(req: NextRequest) {
  let body: { mailbox?: string; address?: string; app_password?: string; tenantId?: string; userId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const mailbox = body.mailbox === "personal" ? "personal" : "work";
  const address = (body.address || "").trim();
  const appPassword = (body.app_password || "").replace(/\s+/g, "");
  if (!address || !appPassword) {
    return NextResponse.json({ ok: false, error: "missing_fields" }, { status: 400 });
  }

  // Whose mailbox: admin-seed (bearer) targets explicit ids; otherwise the signed-in operator.
  let tenantId: string;
  let userId: string;
  if (bearerOk(req)) {
    if (!body.tenantId || !body.userId) {
      return NextResponse.json({ ok: false, error: "seed_needs_ids" }, { status: 400 });
    }
    tenantId = body.tenantId;
    userId = body.userId;
  } else {
    const s = await resolveSessionContext();
    if (!s.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    tenantId = s.tenantId;
    userId = s.userId;
  }

  // Fail-closed: both handshakes must pass before anything is persisted.
  const imapErr = await verifyImap(address, appPassword);
  if (imapErr) return NextResponse.json({ ok: false, error: "imap_verify_failed", detail: imapErr }, { status: 400 });
  const smtpErr = await verifySmtp(address, appPassword);
  if (smtpErr) return NextResponse.json({ ok: false, error: "smtp_verify_failed", detail: smtpErr }, { status: 400 });

  const service = mailbox === "personal" ? "gmail_imap_personal" : "gmail_imap";
  await setUserIntegrationBundle(tenantId, userId, service, { address, app_password: appPassword });
  return NextResponse.json({ ok: true, mailbox, address });
}
