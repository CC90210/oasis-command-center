/**
 * GET /api/ai-audit/settings/fx — the Bank of Canada's latest USD/CAD rate, for the settings form's "Use the Bank of
 * Canada rate" button. Owner only, like saving settings. It saves nothing: the owner reads it, then saves.
 */
import { NextResponse } from "next/server";
import { requireAiAuditSession } from "@/lib/ai-audit/access";
import { fetchBankOfCanadaRate } from "@/lib/ai-audit/fx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const access = await requireAiAuditSession({ ownerOnly: true });
  if (!access.ok) return access.response;
  const r = await fetchBankOfCanadaRate();
  return NextResponse.json(r.ok ? { ok: true, rate: r.rate } : { ok: false, error: r.error === "unreachable" ? "fx_unreachable" : "fx_unreadable" }, {
    status: r.ok ? 200 : 502,
    headers: { "cache-control": "no-store" },
  });
}
