/**
 * GET /api/offer-page/captions?form_id=&ref=  ->  text/vtt
 *
 * A Library video's captions, served from our own domain (design section 4.4),
 * so the <track> needs no CORS on the private bucket and the <video> needs no
 * crossorigin attribute. Checked exactly as /api/offer-page/video checks the
 * video: only a ref in the PUBLISHED copy of a live offer page on an enabled
 * form, resolving to a caption of an asset in the form's own workspace.
 * Everything else is 404.
 *
 * The browser requests this only after a tap, when the <video> and its <track>
 * exist. No same-origin gate here: a <track> load sends no Origin header and a
 * privacy setting may strip Referer, and captions of a PUBLISHED page are not
 * secret. The rate cap and the published-only rule still hold, and the file's
 * size is checked before it is read (lib/offer-pages/captions.ts).
 */
import { NextResponse } from "next/server";
import { offerPagesDb } from "@/lib/offer-pages/store";
import { resolvePublishedVideo } from "@/lib/offer-pages/video";
import { NOT_FOUND, limited, validIds } from "@/lib/offer-pages/public-http";
import { captionsResponse } from "@/lib/offer-pages/captions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (limited(req, "captions")) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  const url = new URL(req.url);
  const ids = validIds(url.searchParams.get("form_id"), url.searchParams.get("ref"));
  if (!ids) return NOT_FOUND();
  const db = offerPagesDb();
  if (!db) return NOT_FOUND();
  let hit;
  try {
    hit = await resolvePublishedVideo(db, ids.formId, ids.ref);
  } catch (err) {
    console.error("[offer-pages.captions] resolve failed", { form_id: ids.formId, error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  if (!hit.ok || !hit.resolved.caption) return NOT_FOUND();
  return captionsResponse(hit.resolved.caption, {
    where: "offer-pages.captions",
    formId: ids.formId,
    ref: ids.ref,
    cacheControl: "private, max-age=600",
  });
}
