/**
 * POST /api/internal/finance/wise-sync — import Wise balance activity (CAD and
 * USD) into the business book's register on 1000 Business chequing. Bearer
 * FINANCE_AGENT_TOKEN.
 * Body: { "days": 30 } or { "since": "2026-09-01" }, plus "dry_run" (days
 * 1-460, default 30).
 *
 * DRY RUN BY DEFAULT: it writes only when the body says "dry_run": false. The
 * import is the statement upload's own (dedupe on Wise's transaction id,
 * categorisation rules), so a re-run inserts nothing. The opening balance is
 * NOT here: it is a founder action in Finances, never an agent's.
 */
import { NextResponse } from "next/server";
import { checkFinanceAgentAuth } from "@/lib/founders-finances/internal-auth";
import { financeErrorResponse, readJsonObject } from "@/lib/founders-finances/http";
import { ensureFinanceSeed } from "@/lib/founders-finances/seed-io";
import { syncWiseFeed } from "@/lib/founders-finances/wise-feed-io";
import { WiseNotReady } from "@/lib/founders-finances/wise-io";
import type { FinanceViewer } from "@/lib/founders-finances/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ATLAS: FinanceViewer = { kind: "agent", name: "atlas" };

export async function POST(req: Request) {
  const denied = checkFinanceAgentAuth(req);
  if (denied) return denied;
  const body = (await readJsonObject(req)) || {};
  try {
    await ensureFinanceSeed();
    const result = await syncWiseFeed(ATLAS, body, { dryRun: body.dry_run !== false });
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    if (e instanceof WiseNotReady) {
      return NextResponse.json({ ok: false, error: e.code, message: e.message }, { status: e.code === "wise_not_configured" ? 503 : 502 });
    }
    return financeErrorResponse(e, "internal:wise-sync");
  }
}
