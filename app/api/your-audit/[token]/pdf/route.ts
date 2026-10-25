/**
 * GET /api/your-audit/<token>/pdf — the stored PDF of the delivered audit.
 * Private R2 object (lib/ai-audit/pdf.ts), served only to a live link. One
 * generic 404 for everything else.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { loadPublicAudit, publicLimited } from "@/lib/ai-audit/public";
import { r2PdfStorage } from "@/lib/ai-audit/pdf";
import { sha256Hex } from "@/lib/ai-audit/hash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });

function fileName(business: string): string {
  const clean = business.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "client";
  return `OASIS-Free-AI-Audit-${clean}.pdf`;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;
  if (publicLimited(req, "pdf")) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  if (!tursoConfigured()) return notFound();
  const data = await loadPublicAudit(getTursoClient(), token, new Date());
  if (!data || !data.audit.pdf_path || !data.audit.pdf_sha256) return notFound();
  const storage = r2PdfStorage();
  if (!storage) return notFound();
  const bytes = await storage.download(data.audit.pdf_path);
  // The file must still be the one CC approved.
  if (!bytes || sha256Hex(bytes) !== data.audit.pdf_sha256) {
    console.error("[your-audit.pdf] the stored PDF is missing or does not match its recorded hash", { versionId: data.audit.id });
    return notFound();
  }
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${fileName(data.audit.doc.business.name)}"`,
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow, noarchive",
    },
  });
}
