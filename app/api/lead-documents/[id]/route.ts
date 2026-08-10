/**
 * GET /api/lead-documents/[id]
 *
 * Returns stable same-origin content URLs after authorizing the document. The
 * byte endpoint repeats the authorization before streaming, so these URLs are
 * safe to keep open and never expose private Supabase signed URLs to clients.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getAuthorizedLeadDocument } from "@/lib/lead-document-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const access = await getAuthorizedLeadDocument(sess, id);
  if (!access.ok) {
    return NextResponse.json({ ok: false, error: access.error }, { status: access.status });
  }
  const doc = access.document;
  const base = `/api/lead-documents/${encodeURIComponent(doc.id)}/content`;
  return NextResponse.json({
    ok: true,
    url: base,
    download_url: `${base}?download=1`,
    filename: doc.filename,
    mime_type: doc.mime_type,
    active_variant: doc.activeVariant,
    is_watermarked: doc.isWatermarked,
    clean_available: doc.cleanAvailable,
    raster: doc.raster,
  });
}
