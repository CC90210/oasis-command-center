/**
 * Error -> HTTP mapping shared by every Finances route. Input problems are
 * 400 with the message (it is written for a founder to read); a refused or
 * missing entity is 404 (never 403 — a 403 confirms the other person's book
 * exists); configuration gaps are 409/503 with a code; a Stripe API failure is
 * a 502 with one plain sentence (stripeErrorSentence) and Stripe's own message
 * in the server log only; anything else is a 500 with the detail in the server
 * log, not in the response.
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
    // Stripe's own wording (endpoint, key fragment, permission name) stays in the server log.
    console.error(`[finances:${context}]`, e.status, e.stripeCode ?? "", e.message);
    return NextResponse.json({ ok: false, error: "stripe_error", message: stripeErrorSentence(e.status) }, { status: 502 });
  }
  console.error(`[finances:${context}]`, e);
  return NextResponse.json({ ok: false, error: "internal_error", message: "Something failed on the server; the detail is in the server log." }, { status: 500 });
}

/**
 * A Stripe API failure as one plain-English sentence a founder can act on:
 * what failed, why in everyday words, and what to do. Stripe's raw message is
 * never part of it — the caller logs that. `failed` names what failed ("The
 * retainer's card link couldn't be set up"), `retry` the verb to repeat
 * ("send again"), `tail` anything to add after ("Nothing was emailed.").
 */
export function stripeErrorSentence(status: number, opts: { failed?: string; retry?: string; tail?: string } = {}): string {
  const failed = opts.failed ?? "The request to Stripe failed";
  const retry = opts.retry ?? "try again";
  let why: string;
  if (status === 401) {
    why = `because Stripe rejected the OASIS Stripe key (it was revoked, rolled or mistyped): replace it with a current restricted key from Stripe → Developers → API keys, then ${retry}.`;
  } else if (status === 403) {
    why = `because the OASIS Stripe key isn't allowed to do this: give the restricted key the missing permission in Stripe → Developers → API keys, then ${retry}.`;
  } else if (status === 404) {
    why = `because Stripe couldn't find what it was asked for (usually the key belongs to another Stripe account, or to test mode): check the key is OASIS's live key in Finances → Settings → Stripe, then ${retry}.`;
  } else if (status === 409) {
    why = `because Stripe was still busy with another request for the same thing: wait a few seconds, then ${retry}.`;
  } else if (status === 429) {
    why = `because Stripe is limiting how fast this app can make requests: wait a minute, then ${retry}.`;
  } else if (status >= 500) {
    why = `because Stripe had a problem on its side: ${retry} in a few minutes (status.stripe.com shows when Stripe is down).`;
  } else {
    why = `because Stripe said the request was invalid: check the amounts and details, then ${retry}; if it fails again, the server log has Stripe's reason.`;
  }
  return `${failed} ${why}${opts.tail ? ` ${opts.tail}` : ""}`;
}

export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
