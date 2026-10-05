/**
 * POST /api/internal/finance/invoices/remind-overdue
 * Returns the overdue reminders it WOULD send. Sends them only when the body
 * is exactly { "send": true } — a missing or truthy-but-not-true value is a
 * dry run. Invoices reminded in the last 3 days are skipped either way.
 * Bearer FINANCE_AGENT_TOKEN.
 */
import { NextResponse } from "next/server";
import { checkFinanceAgentAuth } from "@/lib/founders-finances/internal-auth";
import { financeErrorResponse, readJsonObject } from "@/lib/founders-finances/http";
import { remindOverdue } from "@/lib/founders-finances/invoices-io";
import type { FinanceViewer } from "@/lib/founders-finances/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ATLAS: FinanceViewer = { kind: "agent", name: "atlas" };

export async function POST(req: Request) {
  const denied = checkFinanceAgentAuth(req);
  if (denied) return denied;
  const body = (await readJsonObject(req)) || {};
  const send = body.send === true;
  try {
    const plans = await remindOverdue(ATLAS, { send });
    return NextResponse.json({
      ok: true,
      mode: send ? "sent" : "dry_run",
      count: plans.length,
      failed: plans.filter((p) => p.action === "failed").length,
      reminders: plans,
    });
  } catch (e) {
    return financeErrorResponse(e, "internal:remind-overdue");
  }
}
