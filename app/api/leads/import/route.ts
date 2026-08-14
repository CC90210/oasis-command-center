/**
 * POST /api/leads/import
 *
 * Bulk-insert parsed CSV leads/applications into tenant_records.
 * This route expects the client to send already-mapped rows, but it still
 * normalizes stages, money values, dedupe keys, and optional SunBiz fields
 * server-side so pasted messy board exports do not corrupt the pipeline.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { routeSunBizImportStage } from "@/lib/sunbiz-stage-routing";
import { resolveHomeAddress } from "@/lib/address/split-us-address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseMoney(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const raw = String(v)
    .trim()
    .replace(/[,$]/g, "")
    .replace(/[\u2013\u2014]/g, "-")
    .toLowerCase();
  if (!raw) return null;

  const matches = Array.from(raw.matchAll(/(\d+(?:\.\d+)?)\s*([km])?/g));
  if (matches.length === 0) return null;
  const lastSuffix = matches.findLast((m) => m[2])?.[2] || "";
  const values = matches
    .map((m) => {
      const base = Number(m[1]);
      if (!Number.isFinite(base)) return null;
      const suffix = m[2] || lastSuffix;
      if (suffix === "k") return base * 1_000;
      if (suffix === "m") return base * 1_000_000;
      return base;
    })
    .filter((n): n is number => n != null && Number.isFinite(n));

  if (values.length === 0) return null;
  const value =
    values.length > 1 ? values.reduce((sum, n) => sum + n, 0) / values.length : values[0];
  return Number.isFinite(value) ? value : null;
}

function normEmail(s: string | null | undefined): string | null {
  const e = (s || "").trim().toLowerCase();
  return e || null;
}

function normPhone(s: string | null | undefined): string | null {
  const digits = (s || "").replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits || null;
}

function normBusiness(s: string | null | undefined): string | null {
  const v = (s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(llc|inc|corp|corporation|ltd|co|company)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return v || null;
}

function cleanString(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

const MAX_ROWS = 5_000;
const DEDUP_LOOKBACK = 20_000;

type IncomingRow = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  business_name?: string | null;
  contact_name?: string | null;
  source?: string | null;
  notes?: string | null;
  tags?: string[] | null;
  stage?: string | null;
  state?: string | null;
  monthly_revenue?: number | string | null;
  paper_grade?: string | null;
  time_in_business?: string | null;
  assigned_to?: string | null;
  date_submitted?: string | null;
  lender_list?: string | null;
  dba?: string | null;
  business_address?: string | null;
  business_city?: string | null;
  business_zip?: string | null;
  home_address?: string | null;
  home_city?: string | null;
  home_state?: string | null;
  home_zip?: string | null;
  website?: string | null;
  entity_type?: string | null;
  record_type?: string | null;
  industry?: string | null;
  title?: string | null;
  ownership_pct?: string | null;
  product_service?: string | null;
  annual_revenue?: number | string | null;
  requested_amount?: number | string | null;
  application_url?: string | null;
  bank_statement_urls?: string | null;
  dl_vc_urls?: string | null;
};

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const db = getServiceSupabase();
  const profileRes = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profileRes.data as { tenant_id: string | null } | null)?.tenant_id ?? null;
  if (!tenantId) return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 401 });

  let body: { rows?: IncomingRow[]; dedup_by?: string[]; default_source?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) return NextResponse.json({ ok: false, error: "no_rows" }, { status: 400 });
  if (rows.length > MAX_ROWS) {
    return NextResponse.json(
      {
        ok: false,
        error: "too_many_rows",
        message: `Max ${MAX_ROWS.toLocaleString()} rows per import. Split the file.`,
      },
      { status: 413 },
    );
  }

  const dedupBy =
    Array.isArray(body.dedup_by) && body.dedup_by.length > 0
      ? body.dedup_by.filter((k): k is string => typeof k === "string")
      : ["email", "phone", "business"];
  const defaultSource = body.default_source || "csv_import";

  const existingRes = await db
    .from("tenant_records")
    .select("entity_type, data")
    .eq("tenant_id", tenantId)
    .in("entity_type", ["lead", "application", "funded_deal"])
    .order("updated_at", { ascending: false })
    .limit(DEDUP_LOOKBACK);
  if (existingRes.error) {
    return NextResponse.json(
      { ok: false, error: "dedup_lookup_failed", detail: existingRes.error.message },
      { status: 500 },
    );
  }

  const existingEmails = new Set<string>();
  const existingPhones = new Set<string>();
  const existingBusinesses = new Set<string>();
  for (const r of (existingRes.data || []) as Array<{ entity_type: string; data: Record<string, unknown> | null }>) {
    const d = r.data || {};
    const email = normEmail(typeof d.email === "string" ? d.email : null);
    if (email) existingEmails.add(email);
    const phone = normPhone(typeof d.phone === "string" ? d.phone : null);
    if (phone) existingPhones.add(phone);
    const business = normBusiness(
      typeof d.business_name === "string"
        ? d.business_name
        : typeof d.company === "string"
          ? d.company
          : typeof d.name === "string"
            ? d.name
            : null,
    );
    if (business) existingBusinesses.add(business);
  }

  const toInsert: Array<{
    tenant_id: string;
    entity_type: string;
    data: Record<string, unknown>;
  }> = [];
  let skippedDuplicate = 0;
  let skippedMalformed = 0;
  const duplicateKeys: string[] = [];
  const errors: string[] = [];
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();
  const seenBusinesses = new Set<string>();

  for (const [i, raw] of rows.entries()) {
    const name = cleanString(raw.name, 200);
    const email = normEmail(raw.email);
    const phone = normPhone(raw.phone);
    const businessName =
      cleanString(raw.business_name, 200) ||
      cleanString(raw.company, 200) ||
      cleanString(raw.dba, 200) ||
      cleanString(raw.name, 200);
    const contactName = cleanString(raw.contact_name, 200) || cleanString(raw.name, 200);
    const company = cleanString(raw.company, 200) || businessName;
    const notes = cleanString(raw.notes, 2_000);
    const source = cleanString(raw.source, 64) || defaultSource;
    const tags = Array.isArray(raw.tags)
      ? raw.tags.filter((t) => typeof t === "string").slice(0, 12)
      : null;
    const state = cleanString(raw.state, 80);
    const monthlyRevenue = parseMoney(raw.monthly_revenue);
    const paperGrade = cleanString(raw.paper_grade, 8);
    const timeInBusiness = cleanString(raw.time_in_business, 80);
    const assignedTo = cleanString(raw.assigned_to, 120);
    const businessKey = normBusiness(businessName);

    const dateSubmitted = cleanString(raw.date_submitted, 80);
    const lenderList = cleanString(raw.lender_list, 1_000);
    const dba = cleanString(raw.dba, 200);
    const businessAddress = cleanString(raw.business_address, 240);
    const businessCity = cleanString(raw.business_city, 120);
    const businessZip = cleanString(raw.business_zip, 32);
    const home = resolveHomeAddress({
      address: cleanString(raw.home_address, 240),
      city: cleanString(raw.home_city, 120),
      state: cleanString(raw.home_state, 80),
      zip: cleanString(raw.home_zip, 32),
    });
    const website = cleanString(raw.website, 240);
    const entityType = cleanString(raw.entity_type, 80);
    const industry = cleanString(raw.industry, 180);
    const title = cleanString(raw.title, 80);
    const ownershipPct = cleanString(raw.ownership_pct, 32);
    const productService = cleanString(raw.product_service, 240);
    const annualRevenue = parseMoney(raw.annual_revenue);
    const requestedAmount = parseMoney(raw.requested_amount);
    const applicationUrl = cleanString(raw.application_url, 1_000);
    const bankStatementUrls = cleanString(raw.bank_statement_urls, 2_000);
    const dlVcUrls = cleanString(raw.dl_vc_urls, 2_000);
    const originalStage = cleanString(raw.stage, 80);
    const hasApplicationEvidence = Boolean(
      dateSubmitted ||
        lenderList ||
        requestedAmount != null ||
        applicationUrl ||
        bankStatementUrls ||
        dlVcUrls,
    );
    const { stage, entityType: rowEntityType } = routeSunBizImportStage(raw.stage, {
      explicitRecordType: raw.record_type,
      hasApplicationEvidence,
    });

    if (!email && !phone && !name && !businessName) {
      skippedMalformed += 1;
      errors.push(`row ${i + 1}: no name, email, phone, or business_name`);
      continue;
    }

    let isDupe = false;
    let dupeKey = "";
    if (dedupBy.includes("email") && email) {
      if (existingEmails.has(email) || seenEmails.has(email)) {
        isDupe = true;
        dupeKey = email;
      }
    }
    if (!isDupe && dedupBy.includes("phone") && phone) {
      if (existingPhones.has(phone) || seenPhones.has(phone)) {
        isDupe = true;
        dupeKey = phone;
      }
    }
    if (!isDupe && dedupBy.includes("business") && businessKey) {
      if (existingBusinesses.has(businessKey) || seenBusinesses.has(businessKey)) {
        isDupe = true;
        dupeKey = `business:${businessKey}`;
      }
    }
    if (isDupe) {
      skippedDuplicate += 1;
      if (duplicateKeys.length < 50) duplicateKeys.push(dupeKey);
      continue;
    }

    if (email) seenEmails.add(email);
    if (phone) seenPhones.add(phone);
    if (businessKey) seenBusinesses.add(businessKey);

    toInsert.push({
      tenant_id: tenantId,
      entity_type: rowEntityType,
      data: {
        name,
        email,
        phone,
        company,
        source,
        notes,
        business_name: businessName,
        contact_name: contactName,
        ...(state ? { state } : {}),
        ...(monthlyRevenue != null ? { monthly_revenue: monthlyRevenue } : {}),
        ...(paperGrade ? { paper_grade: paperGrade } : {}),
        ...(timeInBusiness ? { time_in_business: timeInBusiness } : {}),
        ...(assignedTo ? { assigned_to: assignedTo } : {}),
        ...(dateSubmitted ? { date_submitted: dateSubmitted, submitted_at: dateSubmitted } : {}),
        ...(lenderList ? { lender_list: lenderList } : {}),
        ...(dba ? { dba } : {}),
        ...(businessAddress ? { business_address: businessAddress } : {}),
        ...(businessCity ? { business_city: businessCity } : {}),
        ...(businessZip ? { business_zip: businessZip } : {}),
        ...home.data,
        ...(website ? { website } : {}),
        ...(entityType ? { entity_type: entityType } : {}),
        ...(industry ? { industry } : {}),
        ...(title ? { title } : {}),
        ...(ownershipPct ? { ownership_pct: ownershipPct } : {}),
        ...(productService ? { product_service: productService } : {}),
        ...(annualRevenue != null ? { annual_revenue: annualRevenue } : {}),
        ...(requestedAmount != null ? { requested_amount: requestedAmount } : {}),
        ...(applicationUrl ? { application_url: applicationUrl } : {}),
        ...(bankStatementUrls ? { bank_statement_urls: bankStatementUrls } : {}),
        ...(dlVcUrls ? { dl_vc_urls: dlVcUrls } : {}),
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(originalStage ? { original_stage: originalStage } : {}),
        stage,
        status: rowEntityType === "application" ? stage : "new",
        score: 0,
      },
    });
  }

  let inserted = 0;
  if (toInsert.length > 0) {
    const insRes = await db.from("tenant_records").insert(toInsert).select("id");
    if (insRes.error) {
      return NextResponse.json(
        {
          ok: false,
          error: "insert_failed",
          detail: insRes.error.message,
          would_have_inserted: toInsert.length,
          skipped_duplicate: skippedDuplicate,
          skipped_malformed: skippedMalformed,
        },
        { status: 500 },
      );
    }
    inserted = (insRes.data || []).length;
  }

  return NextResponse.json({
    ok: true,
    inserted,
    skipped_duplicate: skippedDuplicate,
    skipped_malformed: skippedMalformed,
    duplicate_keys: duplicateKeys,
    errors: errors.slice(0, 20),
  });
}
