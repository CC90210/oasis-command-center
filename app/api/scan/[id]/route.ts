/**
 * GET /api/scan/:id — the scan as the public page draws it. The live page follows
 * /api/scan/:id/stream; this is the plain read (a permalink, a browser without EventSource, the
 * final report). Stuck scans are closed here exactly as the stream closes them
 * (lib/site-scan/sweep.ts).
 */
import { NextResponse } from "next/server";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { siteScanTablesInstalled } from "@/lib/site-scan/store";
import { currentScan } from "@/lib/site-scan/sweep";
import { toView } from "@/lib/site-scan/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "cache-control": "no-store" };

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404, headers: NO_STORE });
  if (!tursoConfigured()) return NextResponse.json({ ok: false, error: "not_installed" }, { status: 503, headers: NO_STORE });
  const db = getTursoClient();
  if (!(await siteScanTablesInstalled(db))) return NextResponse.json({ ok: false, error: "not_installed" }, { status: 503, headers: NO_STORE });
  const now = new Date();
  const row = await currentScan(db, AI_AUDIT_TENANT_ID, id, now);
  if (!row) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404, headers: NO_STORE });
  return NextResponse.json({ ok: true, scan: toView(row, now) }, { status: 200, headers: NO_STORE });
}
