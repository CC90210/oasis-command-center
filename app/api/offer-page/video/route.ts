/**
 * POST /api/offer-page/video  {form_id, ref}  ->  {ok, url, expires_in}
 *
 * A visitor tapped play on a Library video (design section 4.1). The page's
 * HTML held only the poster; this signs the video file itself, for two hours
 * plus the presign window, and only when ALL of these hold for `ref`:
 *   - the form exists and is switched on,
 *   - its offer page is live,
 *   - `ref` is in the PUBLISHED copy (a ref only in the draft is refused),
 *   - the asset is in the form's own workspace, OASIS's own brand, a released
 *     cut (approved, scheduled or published: one pulled back to review stops
 *     playing at once), and the media row is that asset's video.
 * Every other answer is the same 404. The bucket stays private: only the one
 * attached object is ever signed (lib/offer-pages/video.ts).
 *
 * Public (no visitor has a session): same-origin, a 1 KB body cap, a rate cap
 * per address, strict ids. middleware PUBLIC_PATH_PREFIXES "/api/offer-page/".
 */
import { NextResponse } from "next/server";
import { offerPagesDb } from "@/lib/offer-pages/store";
import { PLAY_TTL_SEC, mediaKey, resolvePublishedVideo } from "@/lib/offer-pages/video";
import { NOT_FOUND, limited, readCappedJson, sameOrigin, validIds } from "@/lib/offer-pages/public-http";
import { signMediaUrls } from "@/lib/founders/marketing-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024;

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (limited(req, "video")) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  const body = await readCappedJson(req, MAX_BODY_BYTES);
  if (!body) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  const ids = validIds(body.form_id, body.ref);
  if (!ids) return NOT_FOUND();

  const db = offerPagesDb();
  if (!db) return NOT_FOUND();
  let hit;
  try {
    hit = await resolvePublishedVideo(db, ids.formId, ids.ref);
  } catch (err) {
    console.error("[offer-pages.video] resolve failed", { form_id: ids.formId, error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  if (!hit.ok) return NOT_FOUND();

  const { storage_bucket: bucket, storage_path: path } = hit.resolved.video;
  const urls = await signMediaUrls([{ bucket, path }], PLAY_TTL_SEC);
  const url = urls.get(mediaKey(bucket, path));
  if (!url) {
    console.error("[offer-pages.video] could not sign", { form_id: ids.formId, ref: ids.ref });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, url, expires_in: PLAY_TTL_SEC }, { headers: { "cache-control": "no-store" } });
}
