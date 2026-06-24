/**
 * /api/integrations/personal/texttorrent — per-employee TextTorrent override.
 *
 * Per-agent SMS (2026-06-24). SunBiz reps share ONE tenant TextTorrent API key
 * but each texts from their OWN number. This stores the rep's personal sending
 * DID so manual sends (lead/application drawer, inbox reply, chat tool) go out
 * from THEIR number; falls back to the tenant "Default Business Number" when
 * unset. Direct analogue of /api/integrations/personal/kixie's
 * `kixie_from_number`.
 *
 * GET    — returns the user's current texttorrent_from_number
 * POST   — { texttorrent_from_number: string } — set/update it
 * DELETE — ?field=texttorrent_from_number clears it (also the no-field default)
 *
 * Stored encrypted in user_integration_credentials, per-tenant per-user.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { normalizePhoneE164 } from "@/lib/lead-interactions-queries";
import {
  getUserIntegrationValue,
  setUserIntegrationValue,
  clearUserIntegrationField,
} from "@/lib/user-integration-store";
import { TEXTTORRENT_FROM_NUMBER_FIELD } from "@/lib/integrations/texttorrent-sender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveTenantId(userId: string): Promise<string | null> {
  const db = getServiceSupabase();
  const r = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  return (r.data as { tenant_id?: string | null } | null)?.tenant_id ?? null;
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenantId = await resolveTenantId(user.id);
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });
  }
  const fromNumber = await getUserIntegrationValue(
    tenantId,
    user.id,
    "texttorrent",
    TEXTTORRENT_FROM_NUMBER_FIELD,
  );
  return NextResponse.json({ ok: true, texttorrent_from_number: fromNumber || null });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenantId = await resolveTenantId(user.id);
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });
  }
  let body: { texttorrent_from_number?: unknown };
  try {
    body = (await req.json()) as { texttorrent_from_number?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.texttorrent_from_number !== "string") {
    return NextResponse.json(
      {
        ok: false,
        error: "nothing_to_update",
        message: "Provide texttorrent_from_number.",
      },
      { status: 400 },
    );
  }

  // normalizePhoneE164 is lenient (digit-only, assumes +1 for 10 digits).
  // Require a strict E.164 result so a typo'd number is rejected at save time
  // instead of failing later as a TT send error.
  const normalized = normalizePhoneE164(body.texttorrent_from_number.trim());
  if (!normalized || !/^\+[1-9]\d{7,14}$/.test(normalized)) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_from_number",
        message: "Provide a valid number in E.164 format, e.g. +17542127833.",
      },
      { status: 400 },
    );
  }
  const result = await setUserIntegrationValue(
    tenantId,
    user.id,
    "texttorrent",
    TEXTTORRENT_FROM_NUMBER_FIELD,
    normalized,
  );
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: "save_failed", message: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, texttorrent_from_number: normalized });
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenantId = await resolveTenantId(user.id);
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });
  }
  // Only one field exists for this service; accept ?field=texttorrent_from_number
  // for symmetry with the Kixie route, and clear it on the no-field default too.
  const field = req.nextUrl.searchParams.get("field");
  if (field && field !== TEXTTORRENT_FROM_NUMBER_FIELD) {
    return NextResponse.json({ ok: false, error: "unknown_field" }, { status: 400 });
  }
  const result = await clearUserIntegrationField(
    tenantId,
    user.id,
    "texttorrent",
    TEXTTORRENT_FROM_NUMBER_FIELD,
  );
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: "clear_failed", message: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, cleared: TEXTTORRENT_FROM_NUMBER_FIELD });
}
