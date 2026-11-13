/**
 * GET /api/scan/:id/screenshot — the picture of a scanned home page (lib/site-scan/screenshot.ts),
 * as public as the scan itself. Only a stored JPEG is ever sent, as image/jpeg with nosniff.
 */
import { NextResponse } from "next/server";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { isJpeg, readScreenshot } from "@/lib/site-scan/screenshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id) || !tursoConfigured()) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  try {
    const bytes = await readScreenshot(getTursoClient(), { tenantId: AI_AUDIT_TENANT_ID, scanId: id });
    if (!bytes || !isJpeg(bytes)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": String(bytes.length), "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" },
    });
  } catch (err) {
    // A database without the column (before bravo__261) has no pictures to give.
    if (err instanceof Error && /no such column: screenshot_jpeg/i.test(err.message)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
    console.error("[site-scan.screenshot] read failed", { scanId: id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    return NextResponse.json({ ok: false, error: "read_failed" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
