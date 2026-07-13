/**
 * POST /api/internal/live-subs/promote — VPS-only callback that turns an
 * approved Breeze "live sub" lead into a shoppable application.
 *
 * Flow: the VPS scrubber bridge (ezra-telegram-bridge) injects the lead when
 * Ezra approves in Telegram, then POSTs { lead_id } here. This route resolves
 * the SunBiz ("submissions") tenant and runs promoteLeadToApplication — which
 * maps the full UW-sheet field set onto the application, stamps phone_status,
 * moves the lead off the Leads board, and regenerates the branded PDF. The same
 * endpoint backs the one-time backfill of already-approved leads.
 *
 * Trust boundary: NO Supabase session. Auth is HMAC-SHA256 over the raw body
 * with OASIS_OUTBOUND_HMAC_SECRET — the same shared secret the VPS send_gateway
 * + extraction_consumer already hold (see /api/internal/apply-extraction). A
 * browser can never call this; only a holder of the server-only secret.
 *
 * Tenant-scoped: the lead is read under the submissions tenant, so a lead_id
 * from any other tenant resolves to lead_not_found. Idempotent (reuses the
 * lead's existing application).
 *
 * Body:   { lead_id: uuid }
 * Header:  x-oasis-signature: hex(HMAC_SHA256(secret, rawBody))
 */

import { NextResponse, type NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { promoteLeadToApplication } from "@/lib/applications/promote-lead-to-application";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 8_000;

function verifyHmac(rawBody: string, header: string | null): boolean {
  const secret = (process.env.OASIS_OUTBOUND_HMAC_SECRET || "").trim();
  if (!secret || !header) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header.trim(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }
  if (!verifyHmac(raw, req.headers.get("x-oasis-signature"))) {
    return NextResponse.json({ ok: false, error: "bad_signature" }, { status: 401 });
  }

  let body: { lead_id?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const leadId = typeof body.lead_id === "string" ? body.lead_id.trim() : "";
  if (!UUID_RE.test(leadId)) {
    return NextResponse.json({ ok: false, error: "invalid_lead_id" }, { status: 400 });
  }

  // Resolve the SunBiz tenant by its canonical slug (same convention as
  // /api/automations/breeze-deals). The lead is read under this tenant, so the
  // promote is inherently tenant-scoped.
  const db = getServiceSupabase();
  const sun = await db.from("tenants").select("id").eq("slug", "submissions").maybeSingle();
  const tenantId = (sun.data as { id: string } | null)?.id ?? null;
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "tenant_unresolved" }, { status: 500 });
  }

  const result = await promoteLeadToApplication({ tenantId, leadId, source: "live_sub_auto" });
  if (!result.ok) {
    const status = result.error === "lead_not_found" ? 404 : 500;
    return NextResponse.json({ ok: false, error: result.error }, { status });
  }

  return NextResponse.json({
    ok: true,
    application_id: result.applicationId,
    created: result.created,
    phone_status: result.phoneStatus,
  });
}
