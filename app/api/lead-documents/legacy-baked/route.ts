/**
 * GET /api/lead-documents/legacy-baked
 *
 * Worklist of bank statements that were watermarked IN PLACE before the clean-
 * storage fix (`metadata.watermarked_at` set) — their clean originals are gone,
 * so they need a clean re-upload to become toggleable. Tenant-scoped and, when
 * lead scoping is on, filtered to leads the caller can see.
 *
 * Response: { ok:true, count, items:[{lead_id, entity, lead_name, doc_id, filename}] }
 */
import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canViewLead, leadScopingEnabled } from "@/lib/lead-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX = 1000;

function leadName(data: Record<string, unknown>): string {
  for (const k of ["business_name", "legal_name", "dba_name", "dba", "company", "name"]) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "(unnamed lead)";
}

export async function GET(_req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const db = getServiceSupabase();
  const tenantId = sess.tenantId;

  const rows = await db
    .from("lead_documents")
    .select("id, lead_id, filename, metadata")
    .eq("tenant_id", tenantId)
    .eq("doc_type", "bank_statements_3mo")
    .not("metadata->>watermarked_at", "is", null) // legacy baked-in-place
    .is("metadata->>deleted_at", null)
    .order("uploaded_at", { ascending: false })
    .limit(MAX);
  if (rows.error) {
    return NextResponse.json({ ok: false, error: rows.error.message }, { status: 500 });
  }
  const docs = (rows.data || []) as Array<{ id: string; lead_id: string | null; filename: string }>;
  if (docs.length === 0) return NextResponse.json({ ok: true, count: 0, items: [] });

  // Resolve parent lead/application records for names + per-agent scope.
  const leadIds = Array.from(new Set(docs.map((d) => d.lead_id).filter((x): x is string => !!x)));
  const parents = new Map<string, { data: Record<string, unknown>; entity: string }>();
  if (leadIds.length) {
    const pr = await db
      .from("tenant_records")
      .select("id, data, entity_type")
      .eq("tenant_id", tenantId)
      .in("id", leadIds);
    for (const p of (pr.data || []) as Array<{ id: string; data: Record<string, unknown> | null; entity_type: string | null }>) {
      parents.set(p.id, { data: p.data || {}, entity: p.entity_type || "lead" });
    }
  }

  const scoping = leadScopingEnabled();
  const items: Array<{ lead_id: string | null; entity: string; lead_name: string; doc_id: string; filename: string }> = [];
  for (const d of docs) {
    const parent = d.lead_id ? parents.get(d.lead_id) : undefined;
    if (scoping && parent && (parent.entity === "lead" || parent.entity === "application")) {
      if (!canViewLead({ isAdmin: sess.isAdmin, userId: sess.userId }, parent.data, true)) continue;
    }
    items.push({
      lead_id: d.lead_id,
      entity: parent?.entity || "lead",
      lead_name: parent ? leadName(parent.data) : "(unknown lead)",
      doc_id: d.id,
      filename: d.filename,
    });
  }

  return NextResponse.json({ ok: true, count: items.length, items });
}
