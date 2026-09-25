/**
 * /api/founders/finances/wise — the founders' Wise surface (WiseCard, and the
 * invoice editor's payment-method choice). Business book only.
 *
 * GET                               status: connected?, profile, balances,
 *                                   receiving details (account numbers masked)
 * GET ?view=editor&currency=CAD     is a bank-transfer invoice possible in that
 *     [&invoice_id=inv_…]           currency (and why not), plus the invoice's
 *                                   stored method when editing one
 * POST { action: "check", days? }   read Wise deposits; record EXACT matches,
 *                                   return fuzzy ones to confirm
 * POST { action: "confirm", wise_ref, invoice_id }
 * POST { action: "dismiss", wise_ref, invoice_id }
 * POST { action: "sync", since }    import Wise activity into Transactions
 *                                   (1000 Business chequing)
 * POST { action: "opening_preview", date }   Wise vs the books on that day
 * POST { action: "opening_post", date }      post the difference (explicit;
 *                                   nothing else ever posts an opening balance)
 *
 * Same gate as every Finances route: a caller who does not resolve as a
 * finance owner gets 404, never 403.
 */
import { NextResponse } from "next/server";
import { methodNotHere } from "@/lib/founders/method-guard";
import { requireEntity, requireRowEntity, resolveFinanceViewer } from "@/lib/founders-finances/access-io";
import { financeErrorResponse, readJsonObject } from "@/lib/founders-finances/http";
import { BUSINESS_ENTITY_ID } from "@/lib/founders-finances/chart";
import { loadInvoice, paymentMethodColumnReady } from "@/lib/founders-finances/invoice-store";
import { maskAccountNumber, storedPaymentMethod, type WiseReceivingDetails } from "@/lib/founders-finances/wise";
import { receivingDetailsOrReason, wiseStatus, WiseNotReady } from "@/lib/founders-finances/wise-io";
import { confirmWiseMatch, dismissWiseMatch, reconcileWise } from "@/lib/founders-finances/wise-reconcile";
import { postWiseOpeningBalance, syncWiseFeed } from "@/lib/founders-finances/wise-feed-io";
import { formatCents } from "@/lib/founders-finances/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Screens show the last 4 of an account number; the PDF a client receives prints it whole. */
function masked(d: WiseReceivingDetails | null) {
  if (!d) return null;
  return { ...d, fields: d.fields.map((f) => (/account/i.test(f.label) ? { ...f, value: maskAccountNumber(f.value) } : f)) };
}

export async function GET(req: Request) {
  const viewer = await resolveFinanceViewer().catch(() => null);
  if (!viewer) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const url = new URL(req.url);
  try {
    await requireEntity(viewer, BUSINESS_ENTITY_ID);
    const methodSupported = await paymentMethodColumnReady();
    if (url.searchParams.get("view") === "editor") {
      const currency = (url.searchParams.get("currency") || "CAD").toUpperCase() === "USD" ? "USD" : "CAD";
      const invoiceId = url.searchParams.get("invoice_id") || "";
      let invoicePaymentMethod: string | null = null;
      if (invoiceId) {
        await requireRowEntity(viewer, "fin_invoices", invoiceId);
        invoicePaymentMethod = storedPaymentMethod((await loadInvoice(invoiceId))?.payment_method);
      }
      const r = await receivingDetailsOrReason(currency);
      return NextResponse.json({
        ok: true,
        method_supported: methodSupported,
        invoice_payment_method: invoicePaymentMethod,
        wise: r.ok ? { available: true, reason: null } : { available: false, reason: r.reason },
      });
    }
    const status = await wiseStatus();
    return NextResponse.json({
      ok: true,
      method_supported: methodSupported,
      status: {
        ...status,
        balances: status.balances.map((b) => ({ ...b, display: formatCents(b.cents, b.currency) })),
        details: Object.fromEntries(Object.entries(status.details).map(([k, v]) => [k, masked(v)])),
      },
    });
  } catch (e) {
    return financeErrorResponse(e, "wise:status");
  }
}

export async function POST(req: Request) {
  const viewer = await resolveFinanceViewer().catch(() => null);
  if (!viewer) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const body = await readJsonObject(req);
  if (!body) return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  try {
    if (body.action === "check") {
      const result = await reconcileWise(viewer, { days: body.days, dryRun: false });
      const parts = [
        `${result.recorded} payment(s) recorded`,
        `${result.needs_confirmation.length} to confirm`,
        result.errors.length ? `${result.errors.length} could not be recorded` : "",
      ].filter(Boolean);
      return NextResponse.json({ ok: true, result, message: `Checked ${result.deposits_seen} Wise deposit(s) over ${result.days} days: ${parts.join(", ")}.` });
    }
    if (body.action === "confirm") {
      const r = await confirmWiseMatch(viewer, body);
      return NextResponse.json({ ok: true, ...r, message: r.full ? "Payment recorded; the invoice is paid." : "Partial payment recorded." });
    }
    if (body.action === "dismiss") {
      await dismissWiseMatch(viewer, body);
      return NextResponse.json({ ok: true, message: "Suggestion dismissed." });
    }
    if (body.action === "sync") {
      const result = await syncWiseFeed(viewer, { since: body.since, days: body.days }, { dryRun: false });
      const added = result.currencies.reduce((a, c) => a + c.inserted, 0);
      const posted = result.currencies.reduce((a, c) => a + c.posted, 0);
      const message =
        added === 0
          ? `Wise is up to date since ${result.since}: nothing new.`
          : `Imported ${added} Wise transaction(s) since ${result.since}; ${posted} categorised by your rules, the rest are waiting in Transactions.`;
      return NextResponse.json({ ok: true, result, message: [message, ...result.notes].join(" ") });
    }
    if (body.action === "opening_preview" || body.action === "opening_post") {
      const result = await postWiseOpeningBalance(viewer, { date: body.date }, { dryRun: body.action !== "opening_post" });
      const posted = result.lines.filter((l) => l.entry_id).length;
      return NextResponse.json({
        ok: true,
        result,
        message: result.dry_run ? null : posted === 0 ? `Business chequing already matches Wise on ${result.date}.` : `Opening balance posted for ${result.date}.`,
      });
    }
    return NextResponse.json({ ok: false, error: "unknown_action" }, { status: 400 });
  } catch (e) {
    if (e instanceof WiseNotReady) return NextResponse.json({ ok: false, error: e.code, message: e.message }, { status: 409 });
    return financeErrorResponse(e, `wise:${String(body.action)}`);
  }
}

export const PUT = methodNotHere;
export const PATCH = methodNotHere;
export const DELETE = methodNotHere;
