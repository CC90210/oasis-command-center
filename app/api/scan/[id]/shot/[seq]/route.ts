/**
 * GET /api/scan/:id/shot/:seq — one picture of the runner's walk through a scanned site
 * (lib/site-scan/screenshot.ts, bravo__262), as public as the scan itself. Only a stored JPEG is
 * ever sent, as image/jpeg with nosniff.
 */
import { NextResponse } from "next/server";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { MAX_SHOTS, isJpeg, readShot, shotsTableMissing } from "@/lib/site-scan/screenshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; seq: string }> }): Promise<Response> {
  const { id, seq } = await ctx.params;
  const n = /^\d{1,2}$/.test(seq) ? Number(seq) : -1;
  if (!UUID_RE.test(id) || n < 0 || n >= MAX_SHOTS || !tursoConfigured()) return notFound();
  try {
    const bytes = await readShot(getTursoClient(), { tenantId: AI_AUDIT_TENANT_ID, scanId: id, seq: n });
    if (!bytes || !isJpeg(bytes)) return notFound();
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": String(bytes.length), "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" },
    });
  } catch (err) {
    if (shotsTableMissing(err)) return notFound();
    console.error("[site-scan.shot] read failed", { scanId: id, seq: n, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    return NextResponse.json({ ok: false, error: "read_failed" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
