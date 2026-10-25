/**
 * GET /api/ai-audit/<engagementId>/pdf — CC's copy of the current version's
 * stored PDF, to review before approving. Founders only; the bytes must still
 * match the recorded hash.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireAiAuditSession } from "@/lib/ai-audit/access";
import { getEngagement } from "@/lib/ai-audit/store";
import { getAuditVersion } from "@/lib/ai-audit/versions";
import { r2PdfStorage } from "@/lib/ai-audit/pdf";
import { sha256Hex } from "@/lib/ai-audit/hash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ engagementId: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const access = await requireAiAuditSession();
  if (!access.ok) return access.response;
  const { engagementId } = await ctx.params;
  const s = access.session;
  const e = await getEngagement(s.db, s.tenantId, engagementId);
  const audit = e?.current_audit_version_id ? await getAuditVersion(s.db, s.tenantId, e.current_audit_version_id) : null;
  if (!audit?.pdf_path || !audit.pdf_sha256) return NextResponse.json({ ok: false, error: "no_pdf_yet" }, { status: 404 });
  const storage = r2PdfStorage();
  const bytes = storage ? await storage.download(audit.pdf_path) : null;
  if (!bytes || sha256Hex(bytes) !== audit.pdf_sha256) return NextResponse.json({ ok: false, error: "pdf_missing_or_changed" }, { status: 409 });
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="audit-v${audit.version_no}.pdf"`, "cache-control": "no-store" },
  });
}
