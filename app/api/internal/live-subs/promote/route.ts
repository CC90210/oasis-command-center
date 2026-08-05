/**
 * POST /api/internal/live-subs/promote — VPS-only callback that turns an
 * approved Breeze "live sub" lead into a shoppable application.
 *
 * Flow: the VPS scrubber bridge (ezra-telegram-bridge) injects the lead when
 * Ezra approves in Telegram, then POSTs { lead_id } here. This route resolves
 * the SunBiz ("submissions") tenant and runs promoteLeadToApplication — which
 * maps the full UW-sheet field set onto the application, stamps phone_status,
 * and regenerates the branded PDF. The lead REMAINS on the Live Subs board —
 * an accepted Bridge deal is worked there, not routed to "Application In". The
 * same endpoint backs the one-time backfill of already-approved leads.
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
import { writeAgentAlert } from "@/lib/notify/agent-alert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 8_000;

function hmacHex(payload: string): string | null {
  const secret = (process.env.OASIS_OUTBOUND_HMAC_SECRET || "").trim();
  if (!secret) return null;
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function verifyHmac(payload: string, header: string | null): boolean {
  const expected = hmacHex(payload);
  if (!expected || !header) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header.trim(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Resolve the SunBiz ("submissions") tenant id — needed to file an alert. */
async function submissionsTenantId(): Promise<string | null> {
  try {
    const db = getServiceSupabase();
    const sun = await db.from("tenants").select("id").eq("slug", "submissions").maybeSingle();
    return (sun.data as { id: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * GET — echo/health check for BOTH sides to verify the shared HMAC secret
 * without promoting anything. The VPS doctor calls
 *   GET .../promote?ping=<nonce>  with x-oasis-signature = HMAC(secret, "ping:<nonce>")
 * and expects { ok: true, pong: <nonce> }. Distinguishes "secret unset on oasis"
 * (500 secret_unset) from "secret mismatch" (401 bad_signature) so a
 * misconfiguration is diagnosable from the VPS side, not just guessed at.
 */
export async function GET(req: NextRequest) {
  const nonce = (req.nextUrl.searchParams.get("ping") || "").slice(0, 128);
  if (!nonce) {
    // Unauthenticated liveness only — never reveals whether the secret is set.
    return NextResponse.json({ ok: true, service: "live-subs/promote", hint: "pass ?ping=<nonce> + HMAC to verify secret" });
  }
  const expected = hmacHex(`ping:${nonce}`);
  if (!expected) {
    return NextResponse.json({ ok: false, error: "secret_unset" }, { status: 500 });
  }
  if (!verifyHmac(`ping:${nonce}`, req.headers.get("x-oasis-signature"))) {
    return NextResponse.json({ ok: false, error: "bad_signature" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, pong: nonce });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }
  if (!verifyHmac(raw, req.headers.get("x-oasis-signature"))) {
    // A browser can never reach this (middleware-allowlisted, no session), and a
    // holder of the secret signs correctly — so a bad signature here is almost
    // always a real VPS↔oasis secret mismatch that silently halts ALL promotes.
    // Make it loud + operator-visible (dedup'd to one open card).
    const secretUnset = !process.env.OASIS_OUTBOUND_HMAC_SECRET;
    const tenantId = await submissionsTenantId();
    if (tenantId) {
      await writeAgentAlert({
        tenantId,
        alertType: "live_sub_hmac_bad_signature",
        lane: "sunbiz-ops",
        severity: "urgent",
        subjectType: "tenant",
        subjectId: tenantId,
        title: "Live Subs promote: HMAC signature rejected",
        body: secretUnset
          ? "OASIS_OUTBOUND_HMAC_SECRET is UNSET on oasis — every Breeze approval is failing to promote. Set it to the VPS value."
          : "A promote call failed HMAC verification — the VPS send_gateway secret likely differs from oasis. No Live Subs are promoting until this matches.",
        payload: { secretUnset },
      });
    }
    return NextResponse.json({ ok: false, error: "bad_signature" }, { status: 401 });
  }

  let body: { lead_id?: unknown; restore_live_subs?: unknown };
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

  const result = await promoteLeadToApplication({
    tenantId,
    leadId,
    source: "live_sub_auto",
    restoreLiveSubs: body.restore_live_subs === true,
  });
  if (!result.ok) {
    const status = result.error === "lead_not_found" ? 404 : 500;
    return NextResponse.json({ ok: false, error: result.error, stage: result.stage }, { status });
  }

  return NextResponse.json({
    ok: true,
    application_id: result.applicationId,
    created: result.created,
    phone_status: result.phoneStatus,
    missing_critical: result.missingCritical,
    empty_fields: result.emptyFields,
    pdf_ok: result.pdfOk,
    retained_in_live_subs: result.retainedInLiveSubs,
  });
}
