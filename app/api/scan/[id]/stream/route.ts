/**
 * GET /api/scan/:id/stream?after=<event id> — watch a scan live (lib/site-scan/stream.ts).
 *
 * Public, like the scan itself (the /api/scan prefix in middleware). The first connection to a
 * scan still waiting for its Tier 0 claims it and runs it here, inside this connection: while the
 * visitor watches, the read is not held to the ~30 s the platform gives work after a response
 * (lib/os/runs/keepalive.ts). Every other connection only follows. POST /api/scan runs Tier 0 itself
 * only when no stream claimed it within a few seconds (a browser without EventSource).
 */
import { NextResponse, type NextRequest } from "next/server";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { keepAlive } from "@/lib/os/runs/keepalive";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { runTier0Live } from "@/lib/site-scan/run";
import { claimTier0, siteScanTablesInstalled } from "@/lib/site-scan/store";
import { followScan, resumeAfter, scanStreamResponse } from "@/lib/site-scan/stream";
import { currentScan } from "@/lib/site-scan/sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404, headers: NO_STORE });
  if (!tursoConfigured()) return NextResponse.json({ ok: false, error: "not_installed" }, { status: 503, headers: NO_STORE });
  try {
    const db = getTursoClient();
    if (!(await siteScanTablesInstalled(db))) return NextResponse.json({ ok: false, error: "not_installed" }, { status: 503, headers: NO_STORE });
    const row = await currentScan(db, AI_AUDIT_TENANT_ID, id, new Date());
    if (!row) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404, headers: NO_STORE });

    let driving = false;
    let gone = false;
    if (row.status === "reading" && (await claimTier0(db, { tenantId: AI_AUDIT_TENANT_ID, id, now: new Date() })) === "claimed") {
      driving = true;
      const work = runTier0Live(db, { tenantId: AI_AUDIT_TENANT_ID, scanId: id }).finally(() => {
        driving = false;
      });
      // While connected the request holds the work; if the visitor leaves, the platform's grace does.
      void keepAlive(work, `site-scan:${id}`);
    }
    const frames = followScan({
      db,
      tenantId: AI_AUDIT_TENANT_ID,
      scanId: id,
      afterId: resumeAfter(req.nextUrl.searchParams.get("after"), req.headers.get("last-event-id")),
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      gone: () => gone,
      driving: () => driving,
    });
    return scanStreamResponse(frames, () => {
      gone = true;
    });
  } catch (err) {
    console.error("[site-scan.stream] failed", { scanId: id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    return NextResponse.json({ ok: false, error: "stream_failed" }, { status: 500, headers: NO_STORE });
  }
}
