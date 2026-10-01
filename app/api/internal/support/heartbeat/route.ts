/**
 * POST /api/internal/support/heartbeat - the support@ reader's status after a
 * sweep. Kept in support_mailbox_status; the SLA cron alerts when support@
 * has not been read for 20 minutes. HMAC-authenticated inside the handler
 * (lib/delivery/support-ingest-auth.ts); see lib/delivery/support-inbox-health.ts.
 */
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { handleSupportHeartbeat } from "@/lib/delivery/support-inbox-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!tursoConfigured()) {
    return Response.json({ ok: false, error: "not_installed", detail: "database_not_configured" }, { status: 503 });
  }
  try {
    return await handleSupportHeartbeat(req, { db: getTursoClient(), env: process.env, now: new Date() });
  } catch (err) {
    console.error("[support.heartbeat] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "heartbeat_failed" }, { status: 500 });
  }
}
