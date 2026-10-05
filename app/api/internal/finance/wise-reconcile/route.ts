/**
 * POST /api/internal/finance/wise-reconcile — match incoming Wise deposits to
 * open invoices. Bearer FINANCE_AGENT_TOKEN.
 * Body: { "days": 30, "dry_run": true } (days 1-120, default 30).
 *
 * DRY RUN BY DEFAULT: it records only when the body says "dry_run": false.
 * Even then only EXACT matches are recorded (the payer's reference names one
 * open invoice and the amount and currency settle it); everything else comes
 * back under needs_confirmation for a founder to confirm in Finances.
 * Idempotent on Wise's transaction reference: a re-run records nothing twice.
 */
import { NextResponse } from "next/server";
import { checkFinanceAgentAuth } from "@/lib/founders-finances/internal-auth";
import { financeErrorResponse, readJsonObject } from "@/lib/founders-finances/http";
import { ensureFinanceSeed } from "@/lib/founders-finances/seed-io";
import { reconcileWise } from "@/lib/founders-finances/wise-reconcile";
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
    const result = await reconcileWise(ATLAS, { days: body.days, dryRun: body.dry_run !== false });
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    if (e instanceof WiseNotReady) {
      return NextResponse.json({ ok: false, error: e.code, message: e.message }, { status: e.code === "wise_not_configured" ? 503 : 502 });
    }
    return financeErrorResponse(e, "internal:wise-reconcile");
  }
}
