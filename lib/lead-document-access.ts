import "server-only";

import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveActiveStoragePath } from "@/lib/lead-documents";
import { normalizeLeadDocumentStoragePath } from "@/lib/lead-document-path";
import { getReadableLeadTargetForSession } from "@/lib/lead-access";

export type DocumentSession = {
  tenantId: string;
  teamRole: string;
  isAdmin: boolean;
  userId: string | null;
};

export type AuthorizedLeadDocument = {
  id: string;
  tenant_id: string;
  lead_id: string | null;
  filename: string;
  storage_path: string;
  mime_type: string | null;
  metadata: Record<string, unknown> | null;
  activePath: string;
  activeVariant: "clean" | "watermarked";
  isWatermarked: boolean;
  raster: boolean;
  cleanAvailable: boolean;
};

/** One authorization path shared by document metadata and byte delivery. */
export async function getAuthorizedLeadDocument(
  session: DocumentSession,
  id: string,
): Promise<{ ok: true; document: AuthorizedLeadDocument } | { ok: false; status: number; error: string }> {
  const db = getServiceSupabase();
  const row = await db
    .from("lead_documents")
    .select("id, tenant_id, lead_id, filename, storage_path, mime_type, metadata")
    .eq("id", id)
    .eq("tenant_id", session.tenantId)
    .is("metadata->>deleted_at", null)
    .maybeSingle();
  const doc = row.data as Omit<AuthorizedLeadDocument, "activePath" | "activeVariant" | "isWatermarked" | "raster" | "cleanAvailable"> | null;
  if (!doc) return { ok: false, status: 404, error: "not_found" };
  if (!doc.lead_id && !session.isAdmin) {
    return { ok: false, status: 404, error: "not_found" };
  }

  if (doc.lead_id) {
    const parent = await db
      .from("tenant_records")
      .select("data, entity_type")
      .eq("tenant_id", session.tenantId)
      .eq("id", doc.lead_id)
      .maybeSingle();
    const record = parent.data as { data?: Record<string, unknown> | null; entity_type?: string | null } | null;
    if (!record || (record.entity_type !== "lead" && record.entity_type !== "application")) {
      return { ok: false, status: 404, error: "not_found" };
    }
    const parentTarget = await getReadableLeadTargetForSession(session, {
      tenantId: session.tenantId,
      id: doc.lead_id,
      entityParam: record.entity_type,
    });
    if (!parentTarget) return { ok: false, status: 404, error: "not_found" };
  }

  const storagePath = normalizeLeadDocumentStoragePath(
    doc.storage_path,
    doc.tenant_id,
    process.env.R2_PUBLIC_BASE_URL,
  );
  if (!storagePath) {
    return { ok: false, status: 403, error: "storage_path_mismatch" };
  }
  const active = resolveActiveStoragePath({ storage_path: storagePath, metadata: doc.metadata });
  const activePath = normalizeLeadDocumentStoragePath(
    active.path,
    doc.tenant_id,
    process.env.R2_PUBLIC_BASE_URL,
  );
  if (!activePath) {
    return { ok: false, status: 403, error: "storage_path_mismatch" };
  }

  return {
    ok: true,
    document: {
      ...doc,
      storage_path: storagePath,
      activePath,
      activeVariant: active.variant,
      isWatermarked: active.is_watermarked,
      raster: active.raster,
      cleanAvailable: !(doc.metadata || {}).watermarked_at,
    },
  };
}
