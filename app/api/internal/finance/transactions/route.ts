/**
 * POST /api/internal/finance/transactions — Atlas submits DRAFT transactions
 * (e.g. receipts it extracted from email) to the BUSINESS book for a founder
 * to review. Nothing is posted to the ledger until a founder approves it.
 * Bearer FINANCE_AGENT_TOKEN.
 *
 * Body: { "transactions": [ { "date": "2026-09-10", "description": "Figma",
 *   "amount": "-15.00", "currency": "USD", "account_code": "2100",
 *   "category": "Software & subscriptions", "external_ref": "gmail:18c..." } ] }
 * amount is signed (negative = money out). Validated by the same pure rules
 * the UI uses (validation.ts). Max 200 per call. external_ref makes a resend
 * of the same receipt a no-op.
 */
import { NextResponse } from "next/server";
import { checkFinanceAgentAuth } from "@/lib/founders-finances/internal-auth";
import { financeErrorResponse, readJsonObject } from "@/lib/founders-finances/http";
import { validateBulkTransactions } from "@/lib/founders-finances/validation";
import { insertDraftTransactions } from "@/lib/founders-finances/transactions-io";
import { requireBusinessEntity } from "@/lib/founders-finances/access-io";
import type { FinanceViewer } from "@/lib/founders-finances/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ATLAS: FinanceViewer = { kind: "agent", name: "atlas" };

export async function POST(req: Request) {
  const denied = checkFinanceAgentAuth(req);
  if (denied) return denied;
  const body = await readJsonObject(req);
  if (!body) return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  const v = validateBulkTransactions(body.transactions);
  if (v.fatal) return NextResponse.json({ ok: false, error: "invalid_input", message: v.fatal }, { status: 400 });
  try {
    const entity = await requireBusinessEntity(ATLAS);
    const results = v.valid.length ? await insertDraftTransactions(ATLAS, entity, v.valid) : [];
    const all = [
      ...results,
      ...v.errors.map((e) => ({ index: e.index, id: null, status: "rejected" as const, error: e.error })),
    ].sort((a, b) => a.index - b.index);
    return NextResponse.json({
      ok: true,
      inserted: all.filter((r) => r.status === "inserted").length,
      duplicates: all.filter((r) => r.status === "duplicate").length,
      rejected: all.filter((r) => r.status === "rejected").length,
      results: all,
    });
  } catch (e) {
    return financeErrorResponse(e, "internal:transactions");
  }
}
