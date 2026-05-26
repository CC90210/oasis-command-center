/**
 * POST /api/manifest/<slug>/cold-lists/upload
 *
 * Inline CSV-paste handler for the compose step "New list" dialog.
 * Distinct from cold-lists/[list_id]/import which accepts pre-parsed
 * structured rows for bulk imports via the Import tab.
 *
 * Body: { name: string, csv: string }
 *   name — list name (required; creates a new cold_lead_lists row)
 *   csv  — raw CSV text pasted by the operator
 *
 * Behavior:
 *   1. Create a new cold_lead_lists row.
 *   2. Auto-detect header row: first line treated as header if it
 *      contains any of "name", "phone", "email", "business".
 *   3. Map columns → business_name, contact_name, phone, email
 *      (remaining columns land in the `raw` JSONB field).
 *   4. Server-side dedup on (lower(email), phone) within the list.
 *   5. Insert into cold_leads.
 *   6. UPDATE cold_lead_lists.row_count to the live count.
 *
 * Returns: { ok: true, list_id, inserted, skipped, duplicates }
 *
 * Auth: session required + caller must own this slug (resolveDataTenant).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { manifestExists } from "@/lib/manifest/loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const MAX_ROWS = 5_000;

// Column aliases that map to our canonical field names.
const BUSINESS_ALIASES = ["business_name", "business", "company", "company_name"];
const CONTACT_ALIASES = ["contact_name", "name", "full_name", "contact", "first_name"];
const PHONE_ALIASES = ["phone", "phone_number", "tel", "mobile"];
const EMAIL_ALIASES = ["email", "email_address", "e_mail"];

function normaliseHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function detectHeaderRow(firstLine: string): boolean {
  const lower = firstLine.toLowerCase();
  return (
    lower.includes("name") ||
    lower.includes("phone") ||
    lower.includes("email") ||
    lower.includes("business")
  );
}

function parseAlias(aliases: string[], headers: string[]): number {
  for (const alias of aliases) {
    const idx = headers.indexOf(alias);
    if (idx !== -1) return idx;
  }
  // Positional fallback by substring match.
  for (const alias of aliases) {
    const idx = headers.findIndex((h) => h.includes(alias));
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseCsvLine(line: string): string[] {
  // Minimal RFC 4180-compatible split: handles quoted fields with commas.
  const result: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        // Escaped quote inside quoted field.
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

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
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const context = await resolveContext(user.id, slug);
  if (!context.ok) {
    return NextResponse.json({ ok: false, error: context.error }, { status: context.status });
  }

  let body: { name?: unknown; csv?: unknown };
  try {
    body = (await req.json()) as { name?: unknown; csv?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ ok: false, error: "name_required" }, { status: 400 });
  }
  const csvText = typeof body.csv === "string" ? body.csv : "";
  const rawLines = csvText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (rawLines.length === 0) {
    return NextResponse.json({ ok: false, error: "csv_empty" }, { status: 400 });
  }

  // Detect header row and parse column indices.
  let dataLines = rawLines;
  let bizIdx = -1;
  let contactIdx = -1;
  let phoneIdx = -1;
  let emailIdx = -1;
  let headerCols: string[] = [];

  if (detectHeaderRow(rawLines[0])) {
    headerCols = parseCsvLine(rawLines[0]).map(normaliseHeader);
    dataLines = rawLines.slice(1);
    bizIdx = parseAlias(BUSINESS_ALIASES, headerCols);
    contactIdx = parseAlias(CONTACT_ALIASES, headerCols);
    phoneIdx = parseAlias(PHONE_ALIASES, headerCols);
    emailIdx = parseAlias(EMAIL_ALIASES, headerCols);
  } else {
    // No header — assume positional: business_name, contact_name, phone, email.
    bizIdx = 0;
    contactIdx = 1;
    phoneIdx = 2;
    emailIdx = 3;
  }

  if (dataLines.length > MAX_ROWS) {
    return NextResponse.json(
      { ok: false, error: "too_many_rows", max: MAX_ROWS },
      { status: 400 },
    );
  }

  const db = getServiceSupabase();

  // Step 1 — Create the new list.
  const { data: listData, error: listErr } = await db
    .from("cold_lead_lists")
    .insert({
      tenant_id: context.tenantId,
      name,
      source: "csv_upload",
      row_count: 0,
      promoted_count: 0,
      created_by_user_id: user.id,
    })
    .select("id")
    .single();

  if (listErr || !listData) {
    return NextResponse.json(
      { ok: false, error: "db_error", detail: listErr?.message },
      { status: 500 },
    );
  }
  const listId = (listData as { id: string }).id;

  // Step 2 — Parse + dedup rows.
  const dedupSet = new Set<string>();
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

  for (const line of dataLines) {
    const cols = parseCsvLine(line);
    const email =
      emailIdx >= 0 && cols[emailIdx]
        ? cols[emailIdx].toLowerCase().trim() || null
        : null;
    const phone =
      phoneIdx >= 0 && cols[phoneIdx] ? cols[phoneIdx].trim() || null : null;

    if (!email && !phone) {
      skipped++;
      continue;
    }

    const dedupKey = `${email ?? ""}||${phone ?? ""}`;
    if (dedupSet.has(dedupKey)) {
      duplicates++;
      continue;
    }
    dedupSet.add(dedupKey);

    // Build raw from remaining columns not mapped to canonical fields.
    const raw: Record<string, unknown> = {};
    const mappedIdxs = new Set([bizIdx, contactIdx, phoneIdx, emailIdx].filter((i) => i >= 0));
    cols.forEach((val, i) => {
      if (!mappedIdxs.has(i) && val) {
        const key = headerCols[i] ?? `col_${i}`;
        raw[key] = val;
      }
    });

    toInsert.push({
      tenant_id: context.tenantId,
      list_id: listId,
      business_name:
        bizIdx >= 0 && cols[bizIdx] ? cols[bizIdx].trim() || null : null,
      contact_name:
        contactIdx >= 0 && cols[contactIdx] ? cols[contactIdx].trim() || null : null,
      phone,
      email,
      raw,
      stage: "imported",
    });
  }

  // Step 3 — Insert in chunks of 500.
  let inserted = 0;
  if (toInsert.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK);
      const { data: insertData, error: insertErr } = await db
        .from("cold_leads")
        .insert(chunk)
        .select("id");
      if (insertErr) {
        if (insertErr.code === "23505") {
          duplicates += chunk.length;
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

  // Step 4 — Update row_count to live count.
  const { count: liveCount } = await db
    .from("cold_leads")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", context.tenantId)
    .eq("list_id", listId);

  await db
    .from("cold_lead_lists")
    .update({ row_count: liveCount ?? inserted })
    .eq("id", listId)
    .eq("tenant_id", context.tenantId);

  return NextResponse.json({ ok: true, list_id: listId, inserted, skipped, duplicates });
}
