/**
 * GET /api/scan/:id — the scan as the public page draws it. Polled every two seconds while a
 * stage is running. A read that died (the Worker was recycled mid-run) is failed here after three
 * minutes so the page never spins forever; an enrichment the runner never delivered is closed
 * after ENRICH_WAIT_MINUTES and the Worker's own report stands.
 */
import { NextResponse } from "next/server";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { enrichRunnerLive } from "@/lib/site-scan/run";
import { getScan, setStatus, siteScanTablesInstalled } from "@/lib/site-scan/store";
import { enrichOverdue, readOverdue, toView } from "@/lib/site-scan/view";

/** How long a queued enrichment may wait before the view checks whether any runner is alive at all. */
const NO_RUNNER_GRACE_MS = 90_000;

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
  let row = await getScan(db, AI_AUDIT_TENANT_ID, id);
  if (!row) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404, headers: NO_STORE });
  if (readOverdue(row, now)) {
    await setStatus(db, { tenantId: AI_AUDIT_TENANT_ID, id, status: "failed", stage: "read", errorCode: "read_timeout", now, onlyFrom: ["reading", "queued"] });
    row = (await getScan(db, AI_AUDIT_TENANT_ID, id)) ?? row;
  } else if (enrichOverdue(row, now)) {
    await setStatus(db, { tenantId: AI_AUDIT_TENANT_ID, id, status: "done", stage: "done", errorCode: "enrich_overdue", now, onlyFrom: ["enriching"] });
    row = (await getScan(db, AI_AUDIT_TENANT_ID, id)) ?? row;
  } else if (row.status === "enriching" && now.getTime() - new Date(row.updatedAt).getTime() > NO_RUNNER_GRACE_MS && !(await enrichRunnerLive(db, AI_AUDIT_TENANT_ID, now))) {
    // Nothing is listening for the enrichment job: hand the visitor the Worker's report now rather
    // than a spinner. The job stays queued; a runner that comes back fills the permalink in.
    await setStatus(db, { tenantId: AI_AUDIT_TENANT_ID, id, status: "done", stage: "done", errorCode: "enrich_no_runner", now, onlyFrom: ["enriching"] });
    row = (await getScan(db, AI_AUDIT_TENANT_ID, id)) ?? row;
  }
  return NextResponse.json({ ok: true, scan: toView(row, now) }, { status: 200, headers: NO_STORE });
}
