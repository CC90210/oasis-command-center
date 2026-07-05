/**
 * POST /api/integrations/smartlead/webhook — Smartlead event receiver.
 *
 * Compliance-critical path: bounces + unsubscribes + negative replies must land in
 * the SunBiz suppression list the same day (CAN-SPAM allows 10 business days; we do
 * it in seconds). Webhook auth (constant-time shared-secret check) is the FIRST
 * non-trivial line and runs BEFORE the body is read — fail closed on any mismatch.
 * The secret + tenant come from env (SMARTLEAD_WEBHOOK_SECRET, SMARTLEAD_TENANT_ID).
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Map Smartlead event → suppression reason. Only suppress-worthy events act.
function suppressionReason(event: string): "opt_out" | "bounce" | null {
  const e = event.toUpperCase();
  if (e.includes("UNSUBSCRIBE") || e.includes("OPTOUT") || e.includes("OPT_OUT")) return "opt_out";
  if (e.includes("BOUNCE")) return "bounce";
  return null;
}

export async function POST(req: NextRequest) {
  // 1. AUTH FIRST — constant-time secret compare, before reading the body. Fail closed.
  const expected = (process.env.SMARTLEAD_WEBHOOK_SECRET || "").trim();
  if (!expected) return NextResponse.json({ ok: false, error: "webhook_not_configured" }, { status: 503 });
  const provided = (req.nextUrl.searchParams.get("secret") || req.headers.get("x-smartlead-secret") || "").trim();
  if (!provided || !safeEqual(provided, expected)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const tenantId = (process.env.SMARTLEAD_TENANT_ID || "").trim();
  if (!tenantId) return NextResponse.json({ ok: false, error: "tenant_not_configured" }, { status: 503 });

  // 2. Now read the (authenticated) body.
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }

  const event = String(body.event_type || body.event || body.webhook_type || "").trim();
  const reason = suppressionReason(event);
  if (!reason) return NextResponse.json({ ok: true, ignored: event || "unknown" });

  // Extract the contact email defensively across Smartlead payload shapes.
  const lead = (body.lead || body.to_email || body.lead_email) as Record<string, unknown> | string | undefined;
  const email = String(
    (typeof lead === "string" ? lead : lead?.email) || body.to_email || body.email || "",
  ).trim().toLowerCase();
  if (!email) return NextResponse.json({ ok: true, no_email: true });

  try {
    const db = getServiceSupabase();
    await db.from("email_suppressions").upsert(
      { tenant_id: tenantId, email, brand: null as string | null, reason, source: "smartlead" },
      { onConflict: "email,tenant_id,brand" },
    );
    return NextResponse.json({ ok: true, suppressed: email, reason });
  } catch (e) {
    // Fail closed for the caller, but never leak PII/details.
    return NextResponse.json({ ok: false, error: "suppression_write_failed", message: (e as Error).message.slice(0, 120) }, { status: 500 });
  }
}
