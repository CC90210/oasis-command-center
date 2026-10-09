/**
 * POST /api/forms/[id]/offer/unpublish
 *
 * Takes the offer page down at once: /f/<workspace>/<slug> is the plain form
 * again on the next request. Never gated (design section 3.5): taking a page
 * down must always be possible. The draft and the last published copy are
 * kept, so publishing again needs no rework.
 *
 * WHO: owners and admins of the session's own workspace (formsSession edit).
 */
import { NextResponse } from "next/server";
import { formsSession } from "@/lib/forms/access";
import { offerPagesDb, readOfferRow, unpublishOffer } from "@/lib/offer-pages/store";
import { editableForm, offerView } from "@/lib/offer-pages/operator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await formsSession({ edit: true });
  if (!auth.ok) return auth.response;
  const tenantId = auth.session.tenantId;
  const { id } = await ctx.params;
  const db = offerPagesDb();
  if (!db) return NextResponse.json({ ok: false, error: "offer_pages_unavailable" }, { status: 503 });
  const form = await editableForm(db, tenantId, id);
  if (!form) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const done = await unpublishOffer(db, { tenantId, formId: id, now: new Date().toISOString() });
  if (!done.ok) {
    if (done.error === "unavailable") return NextResponse.json({ ok: false, error: "offer_pages_unavailable" }, { status: 503 });
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const after = await readOfferRow(db, tenantId, id);
  return NextResponse.json({ ok: true, offer: after.state === "row" ? offerView(after.row, form) : null });
}
