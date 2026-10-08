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
 * secret. The rate cap and the published-only rule still hold.
 */
import { NextResponse } from "next/server";
import { offerPagesDb } from "@/lib/offer-pages/store";
import { resolvePublishedVideo } from "@/lib/offer-pages/video";
import { NOT_FOUND, limited, validIds } from "@/lib/offer-pages/public-http";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** WebVTT files are small; anything larger is not a caption file. */
const MAX_VTT_BYTES = 512 * 1024;

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

  const { storage_bucket: bucket, storage_path: path } = hit.resolved.caption;
  let got: { data: Blob | null; error: unknown };
  try {
    got = await getServiceSupabase().storage.from(bucket).download(path);
  } catch (err) {
    // No object store configured (or it threw): an honest 503, never a crash.
    console.error("[offer-pages.captions] object store unavailable", { form_id: ids.formId, error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  if (got.error || !got.data) {
    console.error("[offer-pages.captions] download failed", { form_id: ids.formId, ref: ids.ref });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  const bytes = new Uint8Array(await got.data.arrayBuffer());
  if (bytes.byteLength > MAX_VTT_BYTES) return NOT_FOUND();
  const text = new TextDecoder("utf-8").decode(bytes);
  if (!text.startsWith("WEBVTT") && !text.startsWith("\uFEFFWEBVTT")) return NOT_FOUND();
  return new NextResponse(text, {
    status: 200,
    headers: {
      "content-type": "text/vtt; charset=utf-8",
      "cache-control": "private, max-age=600",
      "x-content-type-options": "nosniff",
    },
  });
}
