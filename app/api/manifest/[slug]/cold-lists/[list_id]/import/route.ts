/**
 * POST /api/manifest/<slug>/cold-lists/<list_id>/import
 *
 * Bulk-inserts cold leads into the specified cold_lead_lists row.
 *
 * Body: { rows: ColdLeadInput[] }
 *   ColdLeadInput = { business_name?, contact_name?, phone?, email?, raw? }
 *
 * Returns: { ok, inserted, skipped, duplicates }
 *
 * Dedup: within this list only, on (tenant_id, list_id, lower(email), phone).
 * This matches the unique index idx_cold_leads_dedup added in migration 069.
 * Rows missing both email and phone are skipped before even attempting insert.
 *
 * After import, cold_lead_lists.row_count is updated to the live count.
 *
 * This route NEVER writes to tenant_records. Cold leads stay cold until
 * an explicit /promote action.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { manifestExists } from "@/lib/manifest/loader";
import { isUniqueViolationError } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS = 5_000;

type ColdLeadInput = {
  business_name?: string | null;
  contact_name?: string | null;
  phone?: string | null;
  email?: string | null;
  raw?: Record<string, unknown>;
};

async function resolveContext(
  userId: string,
  slug: string,
): Promise<
  | { ok: true; tenantId: string }
  | { ok: false; status: number; error: string }
> {
  if (!SLUG_RE.test(slug)) return { ok: false, status: 400, error: "invalid_slug" };
  if (!(await manifestExists(slug))) return { ok: false, status: 404, error: "unknown_tenant" };

  const db = getServiceSupabase();
  const profileRes = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  const userTenantId =
    (profileRes.data as { tenant_id: string | null } | null)?.tenant_id ?? null;

  const dataTenantId = await resolveDataTenant(slug, userTenantId);
  if (!dataTenantId) {
    return { ok: false, status: 403, error: "preview_mode_no_writes" };
  }
  return { ok: true, tenantId: dataTenantId };
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; list_id: string }> },
) {
  const { slug, list_id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  if (!UUID_RE.test(list_id)) {
    return NextResponse.json({ ok: false, error: "invalid_list_id" }, { status: 400 });
  }

  const context = await resolveContext(user.id, slug);
  if (!context.ok) {
    return NextResponse.json({ ok: false, error: context.error }, { status: context.status });
  }

  const db = getServiceSupabase();

  // Verify the list exists and belongs to this tenant.
  const { data: listRow, error: listErr } = await db
    .from("cold_lead_lists")
    .select("id")
    .eq("id", list_id)
    .eq("tenant_id", context.tenantId)
    .is("archived_at", null)
    .maybeSingle();

  if (listErr || !listRow) {
    return NextResponse.json({ ok: false, error: "list_not_found" }, { status: 404 });
  }

  let body: { rows?: unknown };
  try {
    body = (await req.json()) as { rows?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  if (!Array.isArray(body.rows)) {
    return NextResponse.json({ ok: false, error: "rows_required" }, { status: 400 });
  }

  if (body.rows.length > MAX_ROWS) {
    return NextResponse.json(
      { ok: false, error: "too_many_rows", max: MAX_ROWS },
      { status: 400 },
    );
  }

  // Fetch existing dedup keys for this list to detect duplicates before insert.
  // (lower(email), phone) — matches idx_cold_leads_dedup.
  const { data: existingRows } = await db
    .from("cold_leads")
    .select("email, phone")
    .eq("tenant_id", context.tenantId)
    .eq("list_id", list_id);

  const existingSet = new Set<string>();
  for (const row of existingRows ?? []) {
    const emailKey = (row as { email: string | null; phone: string | null }).email?.toLowerCase() ?? "";
    const phoneKey = (row as { email: string | null; phone: string | null }).phone ?? "";
    existingSet.add(`${emailKey}||${phoneKey}`);
  }

  let skipped = 0;
  let duplicates = 0;
  const toInsert: {
    tenant_id: string;
    list_id: string;
    business_name: string | null;
    contact_name: string | null;
    phone: string | null;
    email: string | null;
    raw: Record<string, unknown>;
    stage: string;
  }[] = [];

  // Dedup within the incoming batch itself using the same key.
  const batchSet = new Set<string>();

  for (const rawRow of body.rows as ColdLeadInput[]) {
    const email = typeof rawRow.email === "string" && rawRow.email.trim()
      ? rawRow.email.trim().toLowerCase()
      : null;
    const phone = typeof rawRow.phone === "string" && rawRow.phone.trim()
      ? rawRow.phone.trim()
      : null;

    // Skip rows missing both contact vectors — they can't be reached.
    if (!email && !phone) {
      skipped++;
      continue;
    }

    const dedupKey = `${email ?? ""}||${phone ?? ""}`;

    if (existingSet.has(dedupKey) || batchSet.has(dedupKey)) {
      duplicates++;
      continue;
    }

    batchSet.add(dedupKey);
    toInsert.push({
      tenant_id: context.tenantId,
      list_id,
      business_name:
        typeof rawRow.business_name === "string" && rawRow.business_name.trim()
          ? rawRow.business_name.trim()
          : null,
      contact_name:
        typeof rawRow.contact_name === "string" && rawRow.contact_name.trim()
          ? rawRow.contact_name.trim()
          : null,
      phone,
      email,
      raw: rawRow.raw && typeof rawRow.raw === "object" ? rawRow.raw : {},
      stage: "imported",
    });
  }

  let inserted = 0;

  if (toInsert.length > 0) {
    // Batch insert in chunks of 500 to avoid hitting request size limits.
    const CHUNK = 500;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK);
      const { data: insertData, error: insertErr } = await db
        .from("cold_leads")
        .insert(chunk)
        .select("id");

      if (insertErr) {
        // On conflict (race with another concurrent import), count as duplicates.
        if (isUniqueViolationError(insertErr)) {
          // Retry the chunk ROW BY ROW.
          //
          // `duplicates += chunk.length` threw away the whole chunk because one
          // row in it collided: a 500-row chunk with a single repeat lost 499
          // good leads AND reported them to the operator as duplicates, which
          // is a plausible number and a false one.
          //
          // It was invisible until now because the branch was unreachable — the
          // check was Postgres's 23505 on a Turso backend, so a collision took
          // the else and 500'd the whole request. Making the check work exposed
          // the handler behind it. Same per-row salvage the founders ingest
          // route already uses.
          for (const row of chunk) {
            const one = await db.from("cold_leads").insert(row).select("id");
            if (!one.error) {
              inserted += one.data?.length ?? 0;
            } else if (isUniqueViolationError(one.error)) {
              duplicates += 1;
            } else {
              return NextResponse.json(
                { ok: false, error: "db_error", detail: one.error.message },
                { status: 500 },
              );
            }
          }
        } else {
          return NextResponse.json(
            { ok: false, error: "db_error", detail: insertErr.message },
            { status: 500 },
          );
        }
      } else {
        inserted += insertData?.length ?? 0;
      }
    }
  }

  // Update the list's row_count to reflect the live count.
  const { count: liveCount } = await db
    .from("cold_leads")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", context.tenantId)
    .eq("list_id", list_id);

  await db
    .from("cold_lead_lists")
    .update({ row_count: liveCount ?? 0 })
    .eq("id", list_id)
    .eq("tenant_id", context.tenantId);

  return NextResponse.json({ ok: true, inserted, skipped, duplicates });
}
