/**
 * POST /api/internal/finance/stripe-reconcile — backfill the last N days of
 * payments, refunds and (all) subscriptions from OASIS's Stripe account.
 * Bearer FINANCE_AGENT_TOKEN. Body: { "days": 30 } (1-400, default 30).
 * Idempotent: a re-run records nothing it already has.
 */
import { NextResponse } from "next/server";
import { checkFinanceAgentAuth } from "@/lib/founders-finances/internal-auth";
import { reconcileStripe } from "@/lib/founders-finances/stripe-ingest";
import { financeErrorResponse, readJsonObject } from "@/lib/founders-finances/http";
import { ensureFinanceSeed } from "@/lib/founders-finances/seed-io";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const denied = checkFinanceAgentAuth(req);
  if (denied) return denied;
  const body = (await readJsonObject(req)) || {};
  const days = typeof body.days === "number" ? body.days : 30;
  try {
    await ensureFinanceSeed();
    const summary = await reconcileStripe({ days });
    return NextResponse.json({ ok: true, summary });
  } catch (e) {
    return financeErrorResponse(e, "internal:stripe-reconcile");
  }
}
