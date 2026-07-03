/**
 * Manage the COLD sending mailbox pool (separate marketing domains). This is the
 * registry the cold-send router reads. Verifies the mailbox can actually SEND
 * (SMTP handshake) before storing — fail closed. App password stored encrypted,
 * never returned.
 *
 *   GET    → list cold mailboxes (no secrets)                [session admin]
 *   POST   → register a mailbox { domain, address, app_password, daily_cap?, warmup_status? }
 *   PATCH  → update { id, warmup_status?, active?, daily_cap? }
 *   DELETE → deactivate { id }
 *
 * Auth: signed-in ADMIN, OR Bearer SCAN_TRIGGER_SECRET + { tenantId } in the body
 * (so cold domains can be seeded programmatically as Adon buys them).
 */

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { registerColdMailbox, listColdMailboxes } from "@/lib/integrations/cold-sending";

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

/** Who is acting + which tenant. Bearer path requires tenantId in the body. */
async function resolveActor(
  req: NextRequest,
  body: { tenantId?: string },
): Promise<{ ok: true; tenantId: string } | { ok: false; status: number; error: string }> {
  if (bearerOk(req)) {
    if (!body.tenantId) return { ok: false, status: 400, error: "seed_needs_tenant" };
    return { ok: true, tenantId: body.tenantId };
  }
  const s = await resolveSessionContext();
  if (!s.ok) return { ok: false, status: 401, error: "unauthorized" };
  if (!s.isAdmin) return { ok: false, status: 403, error: "admin_only" };
  return { ok: true, tenantId: s.tenantId };
}

async function verifySmtp(address: string, appPassword: string): Promise<string | null> {
  const nodemailer = await import("nodemailer");
  const t = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 587, secure: false, requireTLS: true,
    auth: { user: address, pass: appPassword.replace(/\s+/g, "") },
  });
  try { await t.verify(); return null; }
  catch (e) { return e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : "smtp_failed"; }
}

export async function GET() {
  const s = await resolveSessionContext();
  if (!s.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!s.isAdmin) return NextResponse.json({ ok: false, error: "admin_only" }, { status: 403 });
  return NextResponse.json({ ok: true, mailboxes: await listColdMailboxes(s.tenantId) });
}

export async function POST(req: NextRequest) {
  let body: { tenantId?: string; domain?: string; address?: string; app_password?: string; daily_cap?: number; warmup_status?: string };
  try { body = (await req.json()) as typeof body; } catch { return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 }); }

  const actor = await resolveActor(req, body);
  if (!actor.ok) return NextResponse.json({ ok: false, error: actor.error }, { status: actor.status });

  const domain = (body.domain || "").trim();
  const address = (body.address || "").trim();
  const appPassword = (body.app_password || "").replace(/\s+/g, "");
  if (!domain || !address || !appPassword) return NextResponse.json({ ok: false, error: "missing_fields" }, { status: 400 });

  // Must be able to SEND before we store it. Fail closed.
  const smtpErr = await verifySmtp(address, appPassword);
  if (smtpErr) return NextResponse.json({ ok: false, error: "smtp_verify_failed", detail: smtpErr }, { status: 400 });

  const warmup = body.warmup_status === "ready" || body.warmup_status === "paused" ? body.warmup_status : "warming";
  const r = await registerColdMailbox({
    tenantId: actor.tenantId, domain, address, appPassword,
    dailyCap: typeof body.daily_cap === "number" ? body.daily_cap : undefined,
    warmupStatus: warmup,
  });
  if (!r.ok) return NextResponse.json({ ok: false, error: "store_failed", detail: r.error }, { status: 500 });
  return NextResponse.json({ ok: true, id: r.id, domain, address, warmup_status: warmup });
}

export async function PATCH(req: NextRequest) {
  let body: { tenantId?: string; id?: string; warmup_status?: string; active?: boolean; daily_cap?: number };
  try { body = (await req.json()) as typeof body; } catch { return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 }); }
  const actor = await resolveActor(req, body);
  if (!actor.ok) return NextResponse.json({ ok: false, error: actor.error }, { status: actor.status });
  if (!body.id) return NextResponse.json({ ok: false, error: "missing_id" }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.warmup_status === "warming" || body.warmup_status === "ready" || body.warmup_status === "paused") patch.warmup_status = body.warmup_status;
  if (typeof body.active === "boolean") patch.active = body.active;
  if (typeof body.daily_cap === "number" && body.daily_cap >= 0) patch.daily_cap = body.daily_cap;

  const db = getServiceSupabase();
  const { error } = await db.from("cold_sending_mailboxes").update(patch).eq("id", body.id).eq("tenant_id", actor.tenantId);
  if (error) return NextResponse.json({ ok: false, error: "update_failed", detail: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: body.id });
}

export async function DELETE(req: NextRequest) {
  let body: { tenantId?: string; id?: string };
  try { body = (await req.json()) as typeof body; } catch { return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 }); }
  const actor = await resolveActor(req, body);
  if (!actor.ok) return NextResponse.json({ ok: false, error: actor.error }, { status: actor.status });
  if (!body.id) return NextResponse.json({ ok: false, error: "missing_id" }, { status: 400 });
  const db = getServiceSupabase();
  // Soft-disable (keep the row for audit) rather than hard delete.
  const { error } = await db.from("cold_sending_mailboxes").update({ active: false, updated_at: new Date().toISOString() }).eq("id", body.id).eq("tenant_id", actor.tenantId);
  if (error) return NextResponse.json({ ok: false, error: "delete_failed", detail: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: body.id, deactivated: true });
}
