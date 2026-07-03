/**
 * POST /api/cold-sending/blast — send a COLD/marketing blast through the SEPARATE
 * cold-domain pool. This is the caller that proves the isolation: every recipient
 * goes through sendColdEmail(), which routes to a ready cold mailbox or BLOCKS —
 * it can never send from the primary sunbizfunding.com domain.
 *
 * Body: { subject, body, recipients: string[] }   (recipients = plain email addrs)
 * Auth: signed-in ADMIN, or Bearer SCAN_TRIGGER_SECRET + { tenantId } (automation).
 *
 * Fail-closed: if the cold pool is empty/exhausted, the whole blast is refused up
 * front with a clear message ("add a cold domain first") rather than leaking onto
 * the primary domain. Per-recipient suppression + never-mention-lenders still run
 * inside sendColdEmail.
 */

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { resolveSessionContext } from "@/lib/api-auth";
import { pickColdMailbox, sendColdEmail } from "@/lib/integrations/cold-sending";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 500;

function bearerOk(req: NextRequest): boolean {
  const secret = process.env.SCAN_TRIGGER_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization") || "";
  const t = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = Buffer.from(t);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  let body: { tenantId?: string; subject?: string; body?: string; recipients?: unknown };
  try { body = (await req.json()) as typeof body; } catch { return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 }); }

  // Auth → tenant.
  let tenantId: string;
  if (bearerOk(req)) {
    if (!body.tenantId) return NextResponse.json({ ok: false, error: "seed_needs_tenant" }, { status: 400 });
    tenantId = body.tenantId;
  } else {
    const s = await resolveSessionContext();
    if (!s.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    if (!s.isAdmin) return NextResponse.json({ ok: false, error: "admin_only" }, { status: 403 });
    tenantId = s.tenantId;
  }

  const subject = (body.subject || "").trim();
  const text = (body.body || "").trim();
  const recipients = Array.isArray(body.recipients)
    ? Array.from(new Set(body.recipients.filter((x): x is string => typeof x === "string" && EMAIL_RE.test(x.trim())).map((x) => x.trim())))
    : [];
  if (!subject || !text) return NextResponse.json({ ok: false, error: "missing_subject_or_body" }, { status: 400 });
  if (recipients.length === 0) return NextResponse.json({ ok: false, error: "no_valid_recipients" }, { status: 400 });
  if (recipients.length > MAX_RECIPIENTS) return NextResponse.json({ ok: false, error: "too_many_recipients", max: MAX_RECIPIENTS }, { status: 400 });

  // Fail-closed up front: no cold infra → refuse the whole blast (never touch primary).
  const anyMailbox = await pickColdMailbox(tenantId);
  if (!anyMailbox) {
    return NextResponse.json(
      { ok: false, error: "no_cold_infra", message: "No cold sending mailbox is configured/ready. Add a cold domain + mailbox (and warm it up) before running a cold blast." },
      { status: 409 },
    );
  }

  const results: Array<{ to: string; ok: boolean; via?: string; reason?: string }> = [];
  let sent = 0, blocked = 0, failed = 0;
  for (const to of recipients) {
    const r = await sendColdEmail({ tenantId, to, subject, body: text });
    if (r.ok) { sent += 1; results.push({ to, ok: true, via: r.from_address }); }
    else if (r.reason === "suppressed" || r.reason === "unsafe" || r.reason === "no_cold_infra") { blocked += 1; results.push({ to, ok: false, reason: r.reason }); }
    else { failed += 1; results.push({ to, ok: false, reason: r.reason }); }
  }

  return NextResponse.json({ ok: true, requested: recipients.length, sent, blocked, failed, results });
}
