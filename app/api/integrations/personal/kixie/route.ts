/**
 * /api/integrations/personal/kixie — per-employee Kixie overrides.
 *
 * Phase 5 of TT + Kixie full embedding (2026-06-01), extended 2026-06-18
 * to add a per-rep from-number. Two independent overrides per employee:
 *   - kixie_agent_email — "when a call/SMS fires on my behalf, attribute it
 *     to THIS Kixie agent email" (needed when the rep's Kixie login differs
 *     from their user_profiles.email, the default fallback).
 *   - kixie_from_number — "send my SMS from THIS Kixie DID" (my own number);
 *     falls back to the tenant default Kixie number when unset.
 *
 * GET    — returns the user's current kixie_agent_email + kixie_from_number
 * POST   — { kixie_agent_email?: string, kixie_from_number?: string } —
 *          set/update whichever field(s) are present
 * DELETE — ?field=kixie_agent_email | kixie_from_number clears one field;
 *          no ?field clears the whole service (legacy behavior)
 *
 * Stored encrypted in user_integration_credentials, per-tenant per-user.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { normalizePhoneE164 } from "@/lib/lead-interactions-queries";
import {
  getUserIntegrationValue,
  setUserIntegrationValue,
  clearUserIntegration,
  clearUserIntegrationField,
} from "@/lib/user-integration-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KIXIE_FIELDS = ["kixie_agent_email", "kixie_from_number"] as const;

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
  const [agentEmail, fromNumber] = await Promise.all([
    getUserIntegrationValue(tenantId, user.id, "kixie", "kixie_agent_email"),
    getUserIntegrationValue(tenantId, user.id, "kixie", "kixie_from_number"),
  ]);
  return NextResponse.json({
    ok: true,
    kixie_agent_email: agentEmail || null,
    kixie_from_number: fromNumber || null,
  });
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
  let body: { kixie_agent_email?: unknown; kixie_from_number?: unknown };
  try {
    body = (await req.json()) as { kixie_agent_email?: unknown; kixie_from_number?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const hasEmail = typeof body.kixie_agent_email === "string";
  const hasFrom = typeof body.kixie_from_number === "string";
  if (!hasEmail && !hasFrom) {
    return NextResponse.json(
      { ok: false, error: "nothing_to_update", message: "Provide kixie_agent_email and/or kixie_from_number." },
      { status: 400 },
    );
  }

  const out: { kixie_agent_email?: string; kixie_from_number?: string } = {};

  if (hasEmail) {
    const email = (body.kixie_agent_email as string).trim();
    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json(
        { ok: false, error: "invalid_email", message: "Provide a valid email like alex@kixie.account.com." },
        { status: 400 },
      );
    }
    const result = await setUserIntegrationValue(tenantId, user.id, "kixie", "kixie_agent_email", email);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: "save_failed", message: result.error }, { status: 500 });
    }
    out.kixie_agent_email = email;
  }

  if (hasFrom) {
    const normalized = normalizePhoneE164((body.kixie_from_number as string).trim());
    // normalizePhoneE164 is lenient (accepts digit-only, assumes +1 for 10
    // digits). Require a strict E.164 result so a typo'd DID is rejected at
    // save time instead of failing later as a Kixie 502 at send time.
    if (!normalized || !/^\+[1-9]\d{7,14}$/.test(normalized)) {
      return NextResponse.json(
        { ok: false, error: "invalid_from_number", message: "Provide a valid number in E.164 format, e.g. +17542127833." },
        { status: 400 },
      );
    }
    const result = await setUserIntegrationValue(tenantId, user.id, "kixie", "kixie_from_number", normalized);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: "save_failed", message: result.error }, { status: 500 });
    }
    out.kixie_from_number = normalized;
  }

  return NextResponse.json({ ok: true, ...out });
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
  const field = req.nextUrl.searchParams.get("field");
  // ?field=<one of KIXIE_FIELDS> clears just that override; no ?field clears
  // the whole Kixie personal service (legacy behavior, kept for callers that
  // expect a full disconnect).
  if (field) {
    if (!(KIXIE_FIELDS as readonly string[]).includes(field)) {
      return NextResponse.json({ ok: false, error: "unknown_field" }, { status: 400 });
    }
    const result = await clearUserIntegrationField(tenantId, user.id, "kixie", field);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: "clear_failed", message: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true, cleared: field });
  }
  const result = await clearUserIntegration(tenantId, user.id, "kixie");
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: "clear_failed", message: result.error },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
