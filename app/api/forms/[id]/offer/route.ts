/**
 * /api/forms/[id]/offer - a form's offer page, for the builder.
 *
 * GET -> the draft, its status, what blocks Publish, who hears of a new lead.
 * PUT -> either
 *        { template }                       give this form an offer page (New
 *                                           offer, Turn into an offer); a
 *                                           support desk's form answers 409
 *        { draft, version,                  save the draft, compare-and-swap
 *          confirm_claims?, unconfirm_claims? }  on `version` (409 draft_conflict
 *                                           when someone else saved first)
 *
 * WHO: formsSession({ edit: true }) (lib/forms/access.ts), the rule every forms
 * write uses: an owner or admin of the session's own workspace, never in a
 * retired one (403, with its sentence). Another workspace's form id is 404.
 *
 * WHAT IS STORED: the parsed document only (lib/offer-pages/types.ts refuses
 * unknown keys, markup and over-long copy, naming the path). Every owner
 * confirmation in it is re-stamped with the saving owner and the time unless
 * it is already on record for the same content, and a claim tick is kept only
 * for a sentence the draft really flags. Nothing here reaches the public page:
 * only Publish does.
 */
import { NextRequest, NextResponse } from "next/server";
import { formsSession } from "@/lib/forms/access";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import {
  OfferPageError,
  TEMPLATE_KEYS,
  parseOfferPageDoc,
  type LibraryVideoRef,
  type TemplateKey,
  type VideoRef,
} from "@/lib/offer-pages/types";
import { videoRefs } from "@/lib/offer-pages/providers";
import { imageKey, imageRefs, resolveLibrary } from "@/lib/offer-pages/video";
import { emptyDocForTemplate } from "@/lib/offer-pages/templates";
import { applyClaimTicks, lintDoc, stampConfirmations } from "@/lib/offer-pages/claims";
import { createOfferRow, isSupportDeskForm, offerPagesDb, readOfferRow, saveDraft } from "@/lib/offer-pages/store";
import { editableForm, fallbackHeadline, offerView } from "@/lib/offer-pages/operator";
import { offerAlertStatus } from "@/lib/offer-pages/alert-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNAVAILABLE = () =>
  NextResponse.json(
    { ok: false, error: "offer_pages_unavailable", message: "Offer pages aren't switched on yet. Try again after the next update." },
    { status: 503 },
  );

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await formsSession({ edit: true });
  if (!auth.ok) return auth.response;
  const tenantId = auth.session.tenantId;
  const { id } = await ctx.params;
  const db = offerPagesDb();
  if (!db) return UNAVAILABLE();
  const form = await editableForm(db, tenantId, id);
  if (!form) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const read = await readOfferRow(db, tenantId, id);
  if (read.state === "unavailable") return UNAVAILABLE();
  const alert = await offerAlertStatus(tenantId);
  return NextResponse.json({
    ok: true,
    offer: read.state === "row" ? offerView(read.row, form) : null,
    offerable: !(await isSupportDeskForm(db, tenantId, form)),
    alert,
    library_available: isOasisInternalTenant(tenantId),
    form: { id: form.id, slug: form.slug, name: form.name, enabled: form.enabled },
  });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await formsSession({ edit: true });
  if (!auth.ok) return auth.response;
  const tenantId = auth.session.tenantId;
  const actor = auth.session.userId;
  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const db = offerPagesDb();
  if (!db) return UNAVAILABLE();
  const form = await editableForm(db, tenantId, id);
  if (!form) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const now = new Date().toISOString();
  const read = await readOfferRow(db, tenantId, id);
  if (read.state === "unavailable") return UNAVAILABLE();

  // -- Give the form an offer page -------------------------------------------
  if (read.state === "none") {
    const template = body.template;
    if (typeof template !== "string" || !TEMPLATE_KEYS.includes(template as TemplateKey)) {
      return NextResponse.json({ ok: false, error: "template_required" }, { status: 400 });
    }
    if (await isSupportDeskForm(db, tenantId, form)) {
      return NextResponse.json(
        {
          ok: false,
          error: "support_desk_form",
          message: "This form is your support desk's intake. It files tickets for clients, so it can't become a sales page.",
        },
        { status: 409 },
      );
    }
    // The only words a new page starts with are the ones the form already shows.
    const draft = emptyDocForTemplate(template as TemplateKey, {
      headline: form.branding.headline,
      subheadline: form.branding.subheadline,
    });
    const created = await createOfferRow(db, { tenantId, formId: id, template: template as TemplateKey, draft, actor, now });
    if (!created.ok) {
      if (created.error === "unavailable") return UNAVAILABLE();
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    const after = await readOfferRow(db, tenantId, id);
    if (after.state !== "row") return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, created: created.created, offer: offerView(after.row, form) });
  }

  // -- Save the draft --------------------------------------------------------
  const row = read.row;
  const version = Number(body.version);
  if (!Number.isInteger(version) || version < 0) {
    return NextResponse.json({ ok: false, error: "version_required" }, { status: 400 });
  }
  let parsed;
  try {
    parsed = parseOfferPageDoc(body.draft);
  } catch (err) {
    if (err instanceof OfferPageError) {
      return NextResponse.json({ ok: false, error: "invalid_page", path: err.path, reason: err.reason }, { status: 400 });
    }
    throw err;
  }
  if (parsed.template !== row.template) {
    return NextResponse.json({ ok: false, error: "invalid_page", path: "$.template", reason: "the template is set when the page is made" }, { status: 400 });
  }
  // A Library video NEWLY attached must be one this workspace may show: its
  // own asset, OASIS's own brand, approved or published, with its video file.
  // The picker offers nothing else; this is the same rule for a hand-made body.
  // (Refs already on record are not re-judged here: an asset archived later is
  // simply not drawn, and must not make the rest of the page unsaveable.)
  const known = new Set(
    [row.draft, row.published]
      .flatMap((d) => (d ? videoRefs(d) : []))
      .map(({ video }) => (video.source === "library" ? `${video.asset_id}|${video.video_media_id}` : "")),
  );
  const fresh = videoRefs(parsed).filter(
    (v): v is { ref: string; video: VideoRef & LibraryVideoRef } =>
      v.video.source === "library" && !known.has(`${v.video.asset_id}|${v.video.video_media_id}`),
  );
  if (fresh.length) {
    const resolved = await resolveLibrary(db, tenantId, fresh);
    // The picker's rule: approved or published (the play-time rule adds
    // scheduled, the step after approved, so an asset that moves on stays
    // playable; lib/offer-pages/video.ts).
    const bad = fresh.find((v) => {
      const hit = resolved.videos.get(v.ref);
      return !hit || !["approved", "published"].includes(hit.asset.status);
    });
    if (bad) {
      return NextResponse.json(
        { ok: false, error: "invalid_page", path: bad.ref, reason: "not a Library video this workspace may show" },
        { status: 400 },
      );
    }
  }
  // The same for a Library IMAGE newly in the page (a result's screenshot or
  // proof, the link-preview image): it must resolve as the page would draw it,
  // this workspace's own, OASIS's own brand, a released cut. The builder
  // attaches none yet; this holds a hand-made body to the rule.
  const knownImages = new Set([row.draft, row.published].flatMap((d) => (d ? imageRefs(d) : [])).map(({ image }) => imageKey(image)));
  const freshImages = imageRefs(parsed).filter(({ image }) => !knownImages.has(imageKey(image)));
  if (freshImages.length) {
    const resolved = await resolveLibrary(db, tenantId, [], freshImages.map(({ image }) => image));
    const bad = freshImages.find(({ image }) => !resolved.images.has(imageKey(image)));
    if (bad) {
      return NextResponse.json(
        { ok: false, error: "invalid_page", path: bad.path, reason: "not a Library image this workspace may show" },
        { status: 400 },
      );
    }
  }
  const draft = stampConfirmations(parsed, [row.draft, row.published], actor, now);
  const hashes = (v: unknown) => (Array.isArray(v) ? v.filter((h): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) : []);
  const headline = fallbackHeadline(form);
  const claims = applyClaimTicks({
    existing: row.claims,
    confirm: hashes(body.confirm_claims),
    unconfirm: hashes(body.unconfirm_claims),
    draftHits: lintDoc(draft, { fallbackHeadline: headline }),
    publishedHits: row.published ? lintDoc(row.published, { fallbackHeadline: headline }) : [],
    actor,
    now,
  });
  const saved = await saveDraft(db, { tenantId, formId: id, draft, expectedVersion: version, claims, actor, now });
  if (!saved.ok) {
    if (saved.error === "unavailable") return UNAVAILABLE();
    if (saved.error === "conflict") {
      return NextResponse.json(
        {
          ok: false,
          error: "draft_conflict",
          current_version: saved.currentVersion,
          message: "Someone else saved this page a moment ago. Reload to see their changes.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const after = await readOfferRow(db, tenantId, id);
  if (after.state !== "row") return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, offer: offerView(after.row, form) });
}
