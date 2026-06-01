/**
 * /api/integrations/personal/kixie — per-employee Kixie agent email mapping.
 *
 * Phase 5 of TT + Kixie full embedding (2026-06-01). Lets each employee
 * tell us "when a call fires on my behalf, ring THIS Kixie agent email"
 * — needed when the rep's Kixie login email differs from their
 * user_profiles.email (which is the default fallback).
 *
 * GET   — returns the user's current kixie_agent_email (if set)
 * POST  — { kixie_agent_email: string } — set or update
 * DELETE — clear the override (drawer falls back to user_profiles.email)
 *
 * Stored encrypted in user_integration_credentials under
 * service="kixie", field_key="kixie_agent_email". Per-tenant per-user.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import {
  getUserIntegrationValue,
  setUserIntegrationValue,
  clearUserIntegration,
} from "@/lib/user-integration-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const value = await getUserIntegrationValue(
    tenantId,
    user.id,
    "kixie",
    "kixie_agent_email",
  );
  return NextResponse.json({ ok: true, kixie_agent_email: value || null });
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
  let body: { kixie_agent_email?: unknown };
  try {
    body = (await req.json()) as { kixie_agent_email?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const email = typeof body.kixie_agent_email === "string" ? body.kixie_agent_email.trim() : "";
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json(
      { ok: false, error: "invalid_email", message: "Provide a valid email like alex@kixie.account.com." },
      { status: 400 },
    );
  }
  const result = await setUserIntegrationValue(
    tenantId,
    user.id,
    "kixie",
    "kixie_agent_email",
    email,
  );
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: "save_failed", message: result.error },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, kixie_agent_email: email });
}

export async function DELETE() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenantId = await resolveTenantId(user.id);
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });
  }
  // clearUserIntegration drops every field for (tenant, user, service);
  // here we only have one field, so it's effectively a single-field clear.
  const result = await clearUserIntegration(tenantId, user.id, "kixie");
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: "clear_failed", message: result.error },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
