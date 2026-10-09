/**
 * /api/forms/[id]/offer/preview-video - the builder's Preview tab plays the
 * DRAFT's Library videos (design 2.2, step 6). The public routes never sign
 * them: they read only the published copy of a live page, so without this a
 * VSL could not be watched until it was live.
 *
 *   POST { ref }   -> { ok, url, expires_in }   the video file, signed briefly
 *   GET  ?ref=     -> text/vtt                   its captions
 *
 * WHO: formsSession({ edit: true }) (lib/forms/access.ts), the rule every forms
 * write uses: an owner or admin of the session's own workspace, never in a
 * retired one (403). Another workspace's form id matches nothing (404).
 *
 * WHAT: only a Library ref in this form's saved DRAFT that resolves exactly as
 * the public page's would (lib/offer-pages/video.ts resolveLibrary): this
 * workspace's own asset, OASIS's own brand, a released cut, the media row that
 * asset's own. Everything else is the same 404. Nothing here changes the page
 * or reaches a visitor.
 */
import { NextRequest, NextResponse } from "next/server";
import { formsSession } from "@/lib/forms/access";
import { signMediaUrls } from "@/lib/founders/marketing-queries";
import { findVideoRef, VIDEO_REF_RE } from "@/lib/offer-pages/providers";
import { offerPagesDb, readOfferRow } from "@/lib/offer-pages/store";
import { editableForm } from "@/lib/offer-pages/operator";
import { mediaKey, resolveLibrary, type ResolvedVideo } from "@/lib/offer-pages/video";
import { NOT_FOUND } from "@/lib/offer-pages/public-http";
import { captionsResponse } from "@/lib/offer-pages/captions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A preview is watched now: half an hour, plus the presign window. */
const PREVIEW_TTL_SEC = 30 * 60;

type Found = { ok: true; video: ResolvedVideo } | { ok: false; response: Response };

/** The Library video at `ref` in this form's draft, for the session's own workspace. */
async function draftVideo(tenantId: string, formId: string, ref: unknown): Promise<Found> {
  if (typeof ref !== "string" || !VIDEO_REF_RE.test(ref)) return { ok: false, response: NOT_FOUND() };
  const db = offerPagesDb();
  if (!db) return { ok: false, response: NextResponse.json({ ok: false, error: "offer_pages_unavailable" }, { status: 503 }) };
  try {
    if (!(await editableForm(db, tenantId, formId))) return { ok: false, response: NOT_FOUND() };
    const read = await readOfferRow(db, tenantId, formId);
    if (read.state !== "row" || !read.row.draft) return { ok: false, response: NOT_FOUND() };
    const video = findVideoRef(read.row.draft, ref);
    if (!video || video.source !== "library") return { ok: false, response: NOT_FOUND() };
    const hit = (await resolveLibrary(db, tenantId, [{ ref, video }])).videos.get(ref);
    return hit ? { ok: true, video: hit } : { ok: false, response: NOT_FOUND() };
  } catch (err) {
    console.error("[offer-pages.preview-video] resolve failed", { form_id: formId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, response: NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 }) };
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await formsSession({ edit: true });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { ref?: unknown };
  const found = await draftVideo(auth.session.tenantId, id, body?.ref);
  if (!found.ok) return found.response;
  const { storage_bucket: bucket, storage_path: path } = found.video.video;
  const url = (await signMediaUrls([{ bucket, path }], PREVIEW_TTL_SEC)).get(mediaKey(bucket, path));
  if (!url) {
    console.error("[offer-pages.preview-video] could not sign", { form_id: id });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, url, expires_in: PREVIEW_TTL_SEC }, { headers: { "cache-control": "no-store" } });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await formsSession({ edit: true });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const ref = req.nextUrl.searchParams.get("ref");
  const found = await draftVideo(auth.session.tenantId, id, ref);
  if (!found.ok) return found.response;
  if (!found.video.caption) return NOT_FOUND();
  return captionsResponse(found.video.caption, { where: "offer-pages.preview-captions", formId: id, ref: String(ref), cacheControl: "no-store" });
}
