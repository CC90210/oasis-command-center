/**
 * GET /api/forms/[id]/offer/library-videos
 *
 * The builder's "Choose from Library" (design section 4.1): videos the page may
 * show, with their posters signed for the picker. Only:
 *   - this workspace's own assets (every statement binds the session's tenant),
 *   - OASIS's OWN brand (a client brand's asset is never offered: MKT-01),
 *   - format video, status approved or published, not archived,
 *   - with a video file on record.
 * The Library is OASIS's only for now (MKT-12): any other workspace gets
 * { available: false } and attaches video by link.
 *
 * WHO: owners and admins of the session's own workspace (formsSession edit).
 */
import { NextRequest, NextResponse } from "next/server";
import { formsSession } from "@/lib/forms/access";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import { FOUNDERS_OWN_BRAND } from "@/lib/founders-marketing-core";
import { signMediaUrls } from "@/lib/founders/marketing-queries";
import { offerPagesDb } from "@/lib/offer-pages/store";
import { editableForm } from "@/lib/offer-pages/operator";
import { POSTER_TTL_SEC, mediaKey } from "@/lib/offer-pages/video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PICKER_LIMIT = 60;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await formsSession({ edit: true });
  if (!auth.ok) return auth.response;
  const tenantId = auth.session.tenantId;
  const { id } = await ctx.params;
  const db = offerPagesDb();
  if (!db) return NextResponse.json({ ok: false, error: "offer_pages_unavailable" }, { status: 503 });
  if (!(await editableForm(db, tenantId, id))) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!isOasisInternalTenant(tenantId)) return NextResponse.json({ ok: true, available: false, videos: [] });

  let assets: Array<Record<string, unknown>>;
  let media: Array<Record<string, unknown>>;
  try {
    const a = await db.execute({
      sql: `SELECT id, title, aspect, duration_s FROM marketing_asset
            WHERE tenant_id = ? AND brand_slug = ? AND format = 'video' AND status IN ('approved', 'published')
            ORDER BY updated_at DESC LIMIT ?`,
      args: [tenantId, FOUNDERS_OWN_BRAND, PICKER_LIMIT],
    });
    assets = a.rows as unknown as Array<Record<string, unknown>>;
    if (!assets.length) return NextResponse.json({ ok: true, available: true, videos: [] });
    const ids = assets.map((r) => String(r.id));
    const m = await db.execute({
      sql: `SELECT id, asset_id, kind, storage_bucket, storage_path, width, height FROM marketing_asset_media
            WHERE tenant_id = ? AND asset_id IN (${ids.map(() => "?").join(", ")})`,
      args: [tenantId, ...ids],
    });
    media = m.rows as unknown as Array<Record<string, unknown>>;
  } catch (err) {
    if (/no such table:\s*"?marketing_asset/i.test(err instanceof Error ? err.message : String(err))) {
      return NextResponse.json({ ok: true, available: true, videos: [] });
    }
    throw err;
  }

  const byAsset = new Map<string, Array<Record<string, unknown>>>();
  for (const row of media) {
    const list = byAsset.get(String(row.asset_id)) ?? [];
    list.push(row);
    byAsset.set(String(row.asset_id), list);
  }
  const pick = (rows: Array<Record<string, unknown>>, kinds: string[]) =>
    kinds.map((k) => rows.find((r) => r.kind === k)).find(Boolean) ?? null;
  const candidates = assets
    .map((a) => {
      const rows = byAsset.get(String(a.id)) ?? [];
      const video = pick(rows, ["video"]);
      if (!video) return null;
      return { a, video, poster: pick(rows, ["poster", "thumb", "preview", "image"]), caption: pick(rows, ["caption"]) };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
  const posters = await signMediaUrls(
    candidates.filter((c) => c.poster).map((c) => ({ bucket: String(c.poster!.storage_bucket), path: String(c.poster!.storage_path) })),
    POSTER_TTL_SEC,
  );
  return NextResponse.json({
    ok: true,
    available: true,
    videos: candidates.map(({ a, video, poster, caption }) => ({
      asset_id: String(a.id),
      title: String(a.title ?? ""),
      aspect: a.aspect == null ? null : String(a.aspect),
      duration_s: a.duration_s == null ? null : Number(a.duration_s),
      video_media_id: String(video.id),
      poster_media_id: poster ? String(poster.id) : null,
      caption_media_id: caption ? String(caption.id) : null,
      poster_url: poster ? (posters.get(mediaKey(String(poster.storage_bucket), String(poster.storage_path))) ?? null) : null,
    })),
  });
}
