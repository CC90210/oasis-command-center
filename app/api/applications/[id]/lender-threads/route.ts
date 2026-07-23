/**
 * GET /api/applications/[id]/lender-threads
 *
 * Returns every application_lender_threads row for one application,
 * tenant-scoped. Powers the Shopping Out page's "what's been sent /
 * what's pending" result panel and the Offers page's deal-first view.
 *
 * Auth: session cookie + tenant_id match on the row's tenant_id.
 */

import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveTenantId } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { id: applicationId } = await ctx.params;

  const db = getServiceSupabase();
  const r = await db
    .from("application_lender_threads")
    .select(
      "id, lender_id, status, subject, sent_at, last_response_at, last_response_summary, last_error, gmail_thread_id, email_identity, created_at",
    )
    .eq("tenant_id", tenantId)
    .eq("application_id", applicationId)
    .order("created_at", { ascending: false });

  if (r.error) {
    return NextResponse.json({ ok: false, error: r.error.message }, { status: 500 });
  }

  // Hydrate lender name from tenant_records so the UI doesn't need a
  // second round-trip per row. Single batched fetch by lender_id set.
  const lenderIds = Array.from(new Set((r.data || []).map((t) => t.lender_id))).filter(Boolean);
  let lenderNameById = new Map<string, string>();
  if (lenderIds.length > 0) {
    const lenders = await db
      .from("tenant_records")
      .select("id, data")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "lender")
      .in("id", lenderIds);
    if (!lenders.error && lenders.data) {
      lenderNameById = new Map(
        lenders.data.map((row) => {
          const data = (row.data as Record<string, unknown>) || {};
          const name = typeof data.name === "string" ? data.name : "(unnamed lender)";
          return [row.id as string, name];
        }),
      );
    }
  }

  const threads = (r.data || []).map((t) => ({
    ...t,
    lender_name: lenderNameById.get(t.lender_id) || "(unknown lender)",
  }));

  return NextResponse.json({ ok: true, threads });
}
