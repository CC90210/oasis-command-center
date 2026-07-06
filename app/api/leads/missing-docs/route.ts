import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Batched "what docs is each deal missing" for the Missing Info pipeline filter.
 * POST { lead_ids: string[] } → { ok, missing: { [lead_id]: string[] } }.
 * "missing" = EXPECTED_DOC_TYPES minus the doc_types present in lead_documents.
 * Scoped to the caller's tenant (ids validated against tenant_records); returns
 * only doc-presence booleans, never document contents.
 */
const EXPECTED_DOC_TYPES = [
  "bank_statements_3mo",
  "drivers_license",
  "void_cheque",
  "proof_of_ownership",
  "business_license",
  "tax_returns",
];

export async function POST(req: Request) {
  const ctx = await resolveSessionContext();
  if (!ctx.ok || !ctx.tenantId) {
    return NextResponse.json({ ok: false, error: "no_session" }, { status: 401 });
  }

  let body: { lead_ids?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body → no ids */
  }
  const rawIds = Array.isArray(body.lead_ids) ? body.lead_ids : [];
  const leadIds = [...new Set(rawIds.map((x) => String(x || "")).filter(Boolean))].slice(0, 500);
  if (!leadIds.length) {
    return NextResponse.json({ ok: true, missing: {}, doc_types: EXPECTED_DOC_TYPES });
  }

  const db = getServiceSupabase();

  // 1. Scope to this tenant's own records (prevents cross-tenant doc probing).
  const { data: valid, error: vErr } = await db
    .from("tenant_records")
    .select("id")
    .eq("tenant_id", ctx.tenantId)
    .in("id", leadIds);
  if (vErr) {
    return NextResponse.json({ ok: false, error: "scope_failed" }, { status: 500 });
  }
  const validIds = (valid || []).map((r: { id: string }) => r.id);
  if (!validIds.length) {
    return NextResponse.json({ ok: true, missing: {}, doc_types: EXPECTED_DOC_TYPES });
  }

  // 2. Present doc types per lead (skip soft-deleted).
  const { data: docs, error: dErr } = await db
    .from("lead_documents")
    .select("lead_id, doc_type, metadata")
    .in("lead_id", validIds);
  if (dErr) {
    return NextResponse.json({ ok: false, error: "docs_failed" }, { status: 500 });
  }
  const presentByLead: Record<string, Set<string>> = {};
  for (const d of docs || []) {
    const md = (d as { metadata?: Record<string, unknown> | null }).metadata;
    if (md && md.deleted_at) continue;
    const lid = String((d as { lead_id?: string }).lead_id || "");
    const dt = String((d as { doc_type?: string }).doc_type || "");
    if (!lid || !dt) continue;
    (presentByLead[lid] ||= new Set()).add(dt);
  }

  // 3. missing = expected − present (a lead with no docs is missing everything).
  const missing: Record<string, string[]> = {};
  for (const lid of validIds) {
    const present = presentByLead[lid] || new Set<string>();
    missing[lid] = EXPECTED_DOC_TYPES.filter((t) => !present.has(t));
  }

  return NextResponse.json({ ok: true, missing, doc_types: EXPECTED_DOC_TYPES });
}
