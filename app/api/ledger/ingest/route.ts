/**
 * POST /api/ledger/ingest — the Business Ledger's door for the Python
 * harnesses (BEA, Maven, Atlas). Authenticates by a per-producer HMAC inside
 * the handler, not by a session, so middleware.ts lists this exact path as
 * public (like /api/webhooks/). Everything else, including the contract and
 * every status code, is in lib/ledger/ingest.ts.
 */
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { handleLedgerIngest } from "@/lib/ledger/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!tursoConfigured()) {
    return Response.json({ ok: false, error: "database_not_configured" }, { status: 503 });
  }
  try {
    return await handleLedgerIngest(req, { db: getTursoClient(), env: process.env, now: new Date() });
  } catch (err) {
    // A 500 makes the producer keep the events and retry. The accepted rows and
    // the dead letters share one batch, and every event is idempotent on
    // (tenant, key), so a retry never writes anything twice.
    console.error("[ledger.ingest] failed", err);
    return Response.json({ ok: false, error: "ingest_failed" }, { status: 500 });
  }
}
