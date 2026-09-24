/**
 * POST /api/leads/import
 *
 * Bulk-insert parsed CSV leads/applications into tenant_records.
 * This route expects the client to send already-mapped rows, but it still
 * normalizes stages, money values, dedupe keys, and optional SunBiz fields
 * server-side so pasted messy board exports do not corrupt the pipeline.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canWriteCrm } from "@/lib/role-gates";
import { routeSunBizImportStage } from "@/lib/sunbiz-stage-routing";
import {
  isWebsiteSalesTenantSlug,
  OASIS_COLD_OUTBOUND_MOTION,
  OASIS_WEBSITE_SALES_PROGRAM,
  stampSalesProgramForTenant,
  stageForWebsiteSalesLead,
} from "@/lib/leads/canonical-lead-fields";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { getOasisPipelineAssignmentRoster } from "@/lib/team";
import { resolveAssignableTarget } from "@/lib/web-leads/assign-target";
import { pipelineCycleAssignmentFacts } from "@/lib/pipeline-cycle";
import { createImportAssigneeCheck, type ImportAssigneeCheck } from "@/lib/leads-import-service";

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
  website?: string | null;
  website_condition?: string | null;
  audit_findings?: string | null;
  icp_track?: string | null;
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
  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!canWriteCrm(sess.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't import leads." },
      { status: 403 },
    );
  }
  const db = getServiceSupabase();
  const tenantId = sess.tenantId;
  // Which pipeline is this import FOR? A website column is ordinary detail on
  // a funding application, so the program stamp below is gated on the tenant
  // running that program — not on the row happening to carry a URL.
  const importTenantSlug = await resolveOwnedSlug(tenantId);
  if (!importTenantSlug) {
    return NextResponse.json(
      { ok: false, error: "tenant_scope_unresolved" },
      { status: 503 },
    );
  }
  let assignmentRoster: Awaited<ReturnType<typeof getOasisPipelineAssignmentRoster>> | null = null;
  if (isWebsiteSalesTenantSlug(importTenantSlug)) {
    try {
      assignmentRoster = await getOasisPipelineAssignmentRoster(tenantId);
    } catch (error) {
      console.error("[leads.import] OASIS assignment roster could not be verified", {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { ok: false, error: "sales_roster_unavailable", message: "The CC + Adon assignment roster could not be verified." },
        { status: 503 },
      );
    }
  }

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
  const importedAt = new Date().toISOString();
  const checkAssignee = createImportAssigneeCheck(tenantId);

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
    const website = cleanString(raw.website, 240);
    // The parser has recognised these headers since the website-sales engine
    // shipped, but this route dropped them on the floor — so a CSV of
    // researched sites imported as bare contacts, un-stamped and therefore
    // invisible on the OASIS board. lib/leads-import-service.ts (the chat
    // importer) carried them all along; this is the same mapping.
    const websiteCondition = cleanString(raw.website_condition, 240);
    const auditFindings = cleanString(raw.audit_findings, 2_000);
    const icpTrack = cleanString(raw.icp_track, 120);
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
    const routedStage = routeSunBizImportStage(raw.stage, {
      explicitRecordType: raw.record_type,
      hasApplicationEvidence,
    });
    // This endpoint is shared with SunBiz, whose lead CSV can intentionally
    // become an application. OASIS imports are the current sales pipeline:
    // retain the original stage as metadata, but never route those rows into
    // SunBiz's application entity or they disappear from the OASIS board.
    const stage = routedStage.stage;
    const rowEntityType = assignmentRoster ? "lead" : routedStage.entityType;

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

    // A row carrying website research belongs to the OASIS website-sales
    // board, which filters on sales_program and speaks a different stage
    // vocabulary than SunBiz. Without the stamp the row is invisible there;
    // with a SunBiz stage it has no column to sit in. Decide both here.
    const websiteFields = {
      ...(website ? { website } : {}),
      ...(websiteCondition ? { website_condition: websiteCondition } : {}),
      ...(auditFindings ? { audit_findings: auditFindings } : {}),
      ...(icpTrack ? { icp_track: icpTrack } : {}),
    };
    const programStamp =
      rowEntityType === "lead" ? stampSalesProgramForTenant(websiteFields, importTenantSlug) : {};
    const isWebsiteSalesRow = Boolean(programStamp.sales_program);
    const rowStage = isWebsiteSalesRow ? stageForWebsiteSalesLead(originalStage) : stage;
    let assignmentFacts: Record<string, string> = assignedTo ? { assigned_to: assignedTo } : {};
    if (assignmentRoster) {
      if (!assignedTo) {
        return NextResponse.json(
          {
            ok: false,
            error: "assignee_required",
            message: `Row ${i + 1} needs CC or Adon as owner. No rows were imported.`,
          },
          { status: 422 },
        );
      }
      const resolved = resolveAssignableTarget(assignmentRoster, assignedTo);
      if (!resolved) {
        return NextResponse.json(
          {
            ok: false,
            error: "target_not_on_sales_roster",
            message: `Row ${i + 1} names an owner outside the CC + Adon assignment roster. No rows were imported.`,
          },
          { status: 422 },
        );
      }
      assignmentFacts = {
        ...pipelineCycleAssignmentFacts(resolved, importedAt),
        claimed_at: importedAt,
        ...(rowEntityType === "lead"
          ? {
              sales_program: OASIS_WEBSITE_SALES_PROGRAM,
              sales_motion: OASIS_COLD_OUTBOUND_MOTION,
              stage_entered_at: importedAt,
            }
          : {}),
      };
    } else if (assignedTo) {
      // Non-OASIS: the row's owner must be an ACTIVE member of this tenant,
      // checked before anything is written so a refusal imports nothing.
      let owner: ImportAssigneeCheck;
      try {
        owner = await checkAssignee(assignedTo, i + 1);
      } catch (error) {
        // Fail closed: an owner that could not be verified never gets new leads.
        console.error("[leads.import] row owner could not be verified", {
          tenantId,
          row: i + 1,
          error: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json(
          {
            ok: false,
            error: "member_check_failed",
            message: `Row ${i + 1}'s owner couldn't be verified right now. No rows were imported. Try again in a moment.`,
            row: i + 1,
          },
          { status: 503 },
        );
      }
      if (!owner.ok) return NextResponse.json(owner, { status: 422 });
      assignmentFacts = { assigned_to: owner.authUserId };
    }

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
        ...assignmentFacts,
        ...(dateSubmitted ? { date_submitted: dateSubmitted, submitted_at: dateSubmitted } : {}),
        ...(lenderList ? { lender_list: lenderList } : {}),
        ...(dba ? { dba } : {}),
        ...(businessAddress ? { business_address: businessAddress } : {}),
        ...(businessCity ? { business_city: businessCity } : {}),
        ...(businessZip ? { business_zip: businessZip } : {}),
        ...websiteFields,
        ...programStamp,
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
        stage: assignmentRoster && rowEntityType === "lead" ? "assigned" : rowStage,
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
