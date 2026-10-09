/**
 * POST /api/forms/[id]/offer/video-link  { url }
 *
 * The builder's "Paste a link" (design section 4.2). A YouTube, Vimeo or Loom
 * link becomes a video ref the page can play: the id is parsed and checked
 * (lib/offer-pages/providers.ts refuses every other host, scheme and shape),
 * the provider's oEmbed gives the title, thumbnail and (Vimeo) length, and the
 * thumbnail is COPIED into the workspace's public tenant-assets prefix, so the
 * public page makes no third-party request before a visitor taps play.
 *
 * Best effort past the parse: a provider that does not answer still gives a
 * playable ref, shown with a plain play button.
 *
 * WHO: owners and admins of the session's own workspace (formsSession edit).
 * The returned ref carries no rights confirmation: the builder asks for the
 * "I have the right to show this video publicly" tick before it is attached.
 */
import { NextRequest, NextResponse } from "next/server";
import { formsSession } from "@/lib/forms/access";
import { getServiceSupabase } from "@/lib/supabase-server";
import { parseVideoLink } from "@/lib/offer-pages/providers";
import { copyThumbnail, fetchLinkMetadata } from "@/lib/offer-pages/video";
import { offerPagesDb } from "@/lib/offer-pages/store";
import { editableForm } from "@/lib/offer-pages/operator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await formsSession({ edit: true });
  if (!auth.ok) return auth.response;
  const tenantId = auth.session.tenantId;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
  const parsed = parseVideoLink(typeof body?.url === "string" ? body.url : "");
  if (!parsed.ok) return NextResponse.json({ ok: false, error: "invalid_link", message: parsed.reason }, { status: 400 });

  const db = offerPagesDb();
  if (!db) return NextResponse.json({ ok: false, error: "offer_pages_unavailable" }, { status: 503 });
  if (!(await editableForm(db, tenantId, id))) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const meta = await fetchLinkMetadata(parsed);
  let thumbPath: string | null = null;
  let thumbUrl: string | null = null;
  if (meta.thumbnailUrl) {
    const storage = getServiceSupabase().storage;
    thumbPath = await copyThumbnail({
      thumbnailUrl: meta.thumbnailUrl,
      tenantId,
      ref: parsed,
      upload: async (path, bytes, contentType) => {
        const up = await storage.from("tenant-assets").upload(path, bytes, { contentType, upsert: true });
        return !up.error;
      },
    });
    if (thumbPath) thumbUrl = storage.from("tenant-assets").getPublicUrl(thumbPath).data.publicUrl || null;
  }
  return NextResponse.json({
    ok: true,
    video: {
      source: parsed.source,
      id: parsed.id,
      ...(parsed.hash ? { hash: parsed.hash } : {}),
      ...(meta.title ? { title: meta.title } : {}),
      ...(thumbPath ? { thumb_path: thumbPath } : {}),
      ...(meta.durationS ? { duration_s: meta.durationS } : {}),
      aspect: parsed.vertical ? "9:16" : "16:9",
    },
    preview_url: thumbUrl,
  });
}
