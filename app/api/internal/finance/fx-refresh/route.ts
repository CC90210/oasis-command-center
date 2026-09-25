/**
 * POST /api/internal/finance/fx-refresh — pull Bank of Canada FXUSDCAD daily
 * rates into fin_fx_rates. Bearer FINANCE_AGENT_TOKEN.
 * Body: { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" } (default: last 30 days,
 * max 400 days).
 */
import { NextResponse } from "next/server";
import { checkFinanceAgentAuth } from "@/lib/founders-finances/internal-auth";
import { refreshFxRates } from "@/lib/founders-finances/fx-io";
import { addDays, isIsoDate, torontoToday } from "@/lib/founders-finances/fx";
import { financeErrorResponse, readJsonObject } from "@/lib/founders-finances/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = checkFinanceAgentAuth(req);
  if (denied) return denied;
  const body = (await readJsonObject(req)) || {};
  const to = typeof body.to === "string" && isIsoDate(body.to) ? body.to : torontoToday();
  const from = typeof body.from === "string" && isIsoDate(body.from) ? body.from : addDays(to, -30);
  if (from > to) return NextResponse.json({ ok: false, error: "invalid_input", message: "from must be on or before to" }, { status: 400 });
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 400 * 86_400_000) {
    return NextResponse.json({ ok: false, error: "invalid_input", message: "at most 400 days per call" }, { status: 400 });
  }
  try {
    const result = await refreshFxRates(from, to);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return financeErrorResponse(e, "internal:fx-refresh");
  }
}
