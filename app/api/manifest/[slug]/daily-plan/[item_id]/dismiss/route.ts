/**
 * POST /api/manifest/[slug]/daily-plan/[item_id]/dismiss
 *
 * Marks a daily_plan_items row as dismissed. Consumed by DailyPlanClient.tsx
 * (the "Daily Plan" tab added in the 2026-05-25 second SunBiz product meeting)
 * via its optimistic-dismiss flow — the client immediately removes the card
 * from the UI and calls this route to persist the decision.
 *
 * Defense-in-depth: the item's tenant_id is verified against the resolved
 * dataTenantId before any write, so a cross-tenant dismiss via a guessed
 * item_id is blocked even if the caller owns a different valid slug.
 *
 * Idempotent: if the row is already dismissed, returns ok + { already_dismissed: true }.
 * The client may retry on network failure without corrupting the row.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { manifestExists } from "@/lib/manifest/loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string; item_id: string }> },
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { slug, item_id } = await ctx.params;
  if (!(await manifestExists(slug))) {
    return NextResponse.json({ ok: false, error: "unknown_tenant" }, { status: 404 });
  }

  const db = getServiceSupabase();
  const profileRes = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const userTenantId =
    (profileRes.data as { tenant_id: string | null } | null)?.tenant_id ?? null;
  if (!userTenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 401 });
  }

  const dataTenantId = await resolveDataTenant(slug, userTenantId);
  if (!dataTenantId) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Fetch the item first to confirm it exists AND belongs to this tenant.
  // Don't trust slug-derived dataTenantId alone — defense-in-depth against
  // cross-tenant dismiss where an operator guesses a foreign item_id.
  const fetchRes = await db
    .from("daily_plan_items")
    .select("id, status, tenant_id")
    .eq("id", item_id)
    .maybeSingle();

  if (fetchRes.error) {
    return NextResponse.json(
      { ok: false, error: "db_error", message: fetchRes.error.message },
      { status: 500 },
    );
  }

  type ItemRow = { id: string; status: string; tenant_id: string };
  const item = fetchRes.data as ItemRow | null;

  if (!item || item.tenant_id !== dataTenantId) {
    // Collapse "not found" and "wrong tenant" into a single 404 — don't
    // leak whether the id exists on a different tenant.
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // Idempotent path — already dismissed.
  if (item.status === "dismissed") {
    return NextResponse.json({ ok: true, already_dismissed: true });
  }

  const updateRes = await db
    .from("daily_plan_items")
    .update({ status: "dismissed", dismissed_at: new Date().toISOString() })
    .eq("id", item_id)
    .eq("tenant_id", dataTenantId);

  if (updateRes.error) {
    return NextResponse.json(
      { ok: false, error: "db_error", message: updateRes.error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
