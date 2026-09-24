/**
 * Error -> HTTP mapping shared by every Finances route. Input problems are
 * 400 with the message (it is written for a founder to read); a refused or
 * missing entity is 404 (never 403 — a 403 confirms the other person's book
 * exists); configuration gaps are 409/503 with a code; anything else is a 500
 * with the detail in the server log, not in the response.
 */
import "server-only";

import { NextResponse } from "next/server";
import { FinanceInputError, FinanceNotFound } from "./access-io";
import { LedgerError } from "./ledger";
import { InvoiceError } from "./invoice";
import { StripeApiError, StripeNotReady } from "./stripe-io";
import { InvoiceMailerNotConfigured } from "./invoice-email";

export function financeErrorResponse(e: unknown, context: string): NextResponse {
  if (e instanceof FinanceNotFound) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (e instanceof FinanceInputError || e instanceof InvoiceError) {
    return NextResponse.json({ ok: false, error: "invalid_input", message: e.message }, { status: 400 });
  }
  if (e instanceof LedgerError) {
    return NextResponse.json({ ok: false, error: `ledger_${e.code}`, message: e.message }, { status: 400 });
  }
  if (e instanceof StripeNotReady) {
    return NextResponse.json({ ok: false, error: e.code, message: e.message, account: e.accountId }, { status: 409 });
  }
  if (e instanceof InvoiceMailerNotConfigured) {
    return NextResponse.json({ ok: false, error: "invoice_mailer_not_configured", message: e.message }, { status: 503 });
  }
  if (e instanceof StripeApiError) {
    console.error(`[finances:${context}]`, e.message);
    return NextResponse.json({ ok: false, error: "stripe_error", message: e.message }, { status: 502 });
  }
  console.error(`[finances:${context}]`, e);
  return NextResponse.json({ ok: false, error: "internal_error", message: "Something failed on the server; the detail is in the server log." }, { status: 500 });
}

export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
