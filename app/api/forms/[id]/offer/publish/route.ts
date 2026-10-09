/**
 * POST /api/forms/[id]/offer/publish  { version }
 *
 * Makes the draft the owner checked the public page at /f/<workspace>/<slug>.
 *
 * THE CLAIMS GATE (design section 3.5, lib/offer-pages/claims.ts). 409
 * publish_blocked with a plain list of what blocks it, until every result has
 * evidence, permission and an owner's confirmation; every value and the
 * guarantee were confirmed by an owner; every flagged sentence carries an
 * owner's tick; every video carries its rights confirmation; the page has a
 * headline; and the form is switched on.
 *
 * WHAT GOES LIVE is exactly draft `version`: the publish is a compare-and-swap
 * on it, so an edit that lands between the owner's check and the click is not
 * published unseen (409 draft_conflict). The brief (the owner's notes for the
 * copywriter) never goes live.
 *
 * WHO: owners and admins of the session's own workspace (formsSession edit).
 */
import { NextRequest, NextResponse } from "next/server";
import { formsSession } from "@/lib/forms/access";
import { publishGate } from "@/lib/offer-pages/claims";
import { offerPagesDb, publishDraft, readOfferRow } from "@/lib/offer-pages/store";
import { editableForm, fallbackHeadline, offerView } from "@/lib/offer-pages/operator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await formsSession({ edit: true });
  if (!auth.ok) return auth.response;
  const tenantId = auth.session.tenantId;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { version?: unknown };

  const db = offerPagesDb();
  if (!db) return NextResponse.json({ ok: false, error: "offer_pages_unavailable" }, { status: 503 });
  const form = await editableForm(db, tenantId, id);
  if (!form) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const read = await readOfferRow(db, tenantId, id);
  if (read.state === "unavailable") return NextResponse.json({ ok: false, error: "offer_pages_unavailable" }, { status: 503 });
  if (read.state === "none") return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const row = read.row;
  if (!row.draft) {
    return NextResponse.json(
      { ok: false, error: "publish_blocked", blockers: ["The saved draft can't be read. Make a change and save it again."] },
      { status: 409 },
    );
  }
  const version = Number(body.version);
  if (!Number.isInteger(version) || version !== row.draftVersion) {
    return NextResponse.json(
      {
        ok: false,
        error: "draft_conflict",
        current_version: row.draftVersion,
        message: "The page changed since you checked it. Review it again, then publish.",
      },
      { status: 409 },
    );
  }

  const gate = publishGate(row.draft, row.claims, { formEnabled: form.enabled, fallbackHeadline: fallbackHeadline(form) });
  if (gate.blockers.length) {
    return NextResponse.json({ ok: false, error: "publish_blocked", blockers: gate.blockers, warnings: gate.warnings }, { status: 409 });
  }

  const now = new Date().toISOString();
  const published = await publishDraft(db, { tenantId, formId: id, draft: row.draft, draftVersion: version, actor: auth.session.userId, now });
  if (!published.ok) {
    if (published.error === "conflict") {
      return NextResponse.json(
        { ok: false, error: "draft_conflict", current_version: published.currentVersion, message: "The page changed while publishing. Review it again." },
        { status: 409 },
      );
    }
    if (published.error === "unavailable") return NextResponse.json({ ok: false, error: "offer_pages_unavailable" }, { status: 503 });
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const after = await readOfferRow(db, tenantId, id);
  return NextResponse.json({
    ok: true,
    published_version: published.publishedVersion,
    warnings: gate.warnings,
    offer: after.state === "row" ? offerView(after.row, form) : null,
  });
}
