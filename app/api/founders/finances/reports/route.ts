/**
 * GET /api/founders/finances/reports?entity=&kind=pnl|balance|trial|cashflow|ledger|aging&from=&to=&account=
 * CSV export of a statement. Entity-gated like every Finances read.
 */
import { NextResponse } from "next/server";
import { methodNotHere } from "@/lib/founders/method-guard";
import { resolveFinanceViewer } from "@/lib/founders-finances/access-io";
import { financeErrorResponse } from "@/lib/founders-finances/http";
import { REPORT_KINDS, runReport, type ReportKind } from "@/lib/founders-finances/reports-io";
import { toCsv } from "@/lib/founders-finances/reports";
import { agingRows, balanceRows, cashFlowRows, ledgerRows, pnlRows, trialRows } from "@/lib/founders-finances/report-csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const viewer = await resolveFinanceViewer().catch(() => null);
  if (!viewer) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const sp = new URL(req.url).searchParams;
  const kind = sp.get("kind") as ReportKind;
  if (!REPORT_KINDS.includes(kind)) return NextResponse.json({ ok: false, error: "invalid_input", message: "unknown report" }, { status: 400 });
  try {
    const r = await runReport(viewer, sp.get("entity") || "oasis", kind, {
      from: sp.get("from") || undefined,
      to: sp.get("to") || undefined,
      accountId: sp.get("account"),
    });
    let rows;
    switch (r.kind) {
      case "pnl":
        rows = pnlRows(r.data);
        break;
      case "balance":
        rows = balanceRows(r.data);
        break;
      case "trial":
        rows = trialRows(r.data);
        break;
      case "cashflow":
        rows = cashFlowRows(r.data);
        break;
      case "ledger":
        rows = ledgerRows(r.data);
        break;
      default:
        rows = agingRows(r.data);
    }
    const header = [[`${r.entity.name}`], [`${kind} ${r.from} to ${r.to} (exclusive)`], []];
    const csv = "﻿" + toCsv([...header, ...rows]);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${r.entity.slug}-${kind}-${r.from}-${r.to}.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return financeErrorResponse(e, "reports:csv");
  }
}

export const POST = methodNotHere;
export const PUT = methodNotHere;
export const PATCH = methodNotHere;
export const DELETE = methodNotHere;
