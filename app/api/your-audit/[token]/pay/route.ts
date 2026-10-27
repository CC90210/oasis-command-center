/**
 * POST /api/your-audit/<token>/pay — the client's Pay button (a plain form
 * post from the private audit page).
 *
 * Opens, or reuses, one Stripe Checkout Session for exactly what the approved
 * proposal says is due now (lib/ai-audit/payment.ts createOrReuseCheckout) and
 * answers 303 to it. This is NOT a payment: a payment is counted only when the
 * server re-reads the session from Stripe. Same-origin and rate-capped; every
 * refusal sends the client back to the page with a plain message, and a dead
 * link (missing, expired, revoked or replaced) to the same neutral page the
 * link itself shows.
 * Dry run: LIVE_SEND_STRIPE_CHECKOUT (lib/integrations/send-mode.ts).
 */
import { NextResponse, type NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { fromOwnAuditPage, loadPublicAudit, payUnavailableReason, publicLimited } from "@/lib/ai-audit/public";
import { createOrReuseCheckout } from "@/lib/ai-audit/payment";
import { isPlausibleToken } from "@/lib/ai-audit/link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Ctx = { params: Promise<{ token: string }> };

function back(req: NextRequest, token: string, code: string) {
  const url = new URL(`/your-audit/${encodeURIComponent(token)}`, req.nextUrl.origin);
  url.searchParams.set("pay", code);
  return NextResponse.redirect(url, { status: 303, headers: { "cache-control": "no-store" } });
}

/** The page for a link that no longer opens: one neutral answer for every reason (lib/ai-audit/link.ts). */
function deadLink(req: NextRequest, token: string) {
  return NextResponse.redirect(new URL(`/your-audit/${encodeURIComponent(token)}`, req.nextUrl.origin), { status: 303, headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;
  if (!isPlausibleToken(token)) return deadLink(req, "invalid");
  if (!fromOwnAuditPage(req)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (publicLimited(req, "pay")) return back(req, token, "busy");
  if (!tursoConfigured()) return back(req, token, "unavailable");
  const db = getTursoClient();
  const now = new Date();
  const data = await loadPublicAudit(db, token, now);
  if (!data) return deadLink(req, token);
  if (payUnavailableReason(data, now)) return back(req, token, "closed");
  try {
    const r = await createOrReuseCheckout(db, { link: data.link, now });
    if (r.ok) return NextResponse.redirect(r.url, { status: 303, headers: { "cache-control": "no-store" } });
    console.warn("[your-audit.pay] checkout not opened", { engagementId: data.engagement.id, error: r.error });
    return back(
      req,
      token,
      r.error === "busy" ? "busy" : r.error === "already_paid" || r.error === "not_payable" ? "closed" : r.error === "dry_run" || r.error === "stripe_not_connected" ? "offline" : "unavailable",
    );
  } catch (err) {
    console.error("[your-audit.pay] failed", err instanceof Error ? err.stack : err);
    return back(req, token, "unavailable");
  }
}
