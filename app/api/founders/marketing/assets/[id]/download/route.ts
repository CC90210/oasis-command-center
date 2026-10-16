/**
 * GET /api/founders/marketing/assets/:id/download[?slide=N]
 *
 * Saves the asset's original file to the operator's computer. CC, 2026-10-16:
 * "I want to be able to download the actual videos to my computer ... all the
 * videos in the library section in content."
 *
 * The bytes never pass through this Worker: it answers with a redirect to a
 * five-minute R2 URL signed with `Content-Disposition: attachment`, so R2 serves
 * the file and the browser saves it under a readable name (see
 * lib/founders/asset-download). Tenant-scoped and own-brand only, exactly like
 * the publish route beside it: a uuid in the URL proves nothing.
 */
import { NextResponse } from "next/server";

import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveFounder } from "@/lib/founders/gate";
import { methodNotHere } from "@/lib/founders/method-guard";
import { downloadFilename, pickDownloadMedia, type DownloadMediaRow } from "@/lib/founders/asset-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

/** Long enough to start a large download on a slow link, short enough to be useless if shared. */
const DOWNLOAD_URL_TTL_SEC = 300;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const founder = await resolveFounder();
  if (!founder) return notFound();
  const { id } = await ctx.params;

  const slideParam = new URL(req.url).searchParams.get("slide");
  const slide = slideParam == null ? null : Number(slideParam);

  const db = getServiceSupabase();
  const asset = await db
    .from("marketing_asset")
    .select("id, title, brand_slug, media_urls")
    .eq("tenant_id", founder.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (asset.error) {
    return NextResponse.json({ ok: false, error: "read_failed" }, { status: 500 });
  }
  if (!asset.data || asset.data.brand_slug !== "oasis-ai") return notFound();

  const media = await db
    .from("marketing_asset_media")
    .select("kind, storage_bucket, storage_path")
    .eq("tenant_id", founder.tenantId)
    .eq("asset_id", id);
  if (media.error) {
    return NextResponse.json({ ok: false, error: "read_failed" }, { status: 500 });
  }

  const pick = pickDownloadMedia((media.data || []) as DownloadMediaRow[], asset.data.media_urls, slide);
  if (!pick) {
    return NextResponse.json(
      { ok: false, error: slide == null ? "no_media_attached" : "no_such_slide" },
      { status: 404 },
    );
  }

  const name = downloadFilename(asset.data.title, pick.storage_path, slide);
  const signed = await db.storage
    .from(pick.storage_bucket)
    .createSignedUrl(pick.storage_path, DOWNLOAD_URL_TTL_SEC, { download: name });
  if (signed.error || !signed.data?.signedUrl) {
    console.warn("[founders:download] sign failed", signed.error?.message);
    return NextResponse.json({ ok: false, error: "sign_failed" }, { status: 502 });
  }

  const res = NextResponse.redirect(signed.data.signedUrl, 302);
  res.headers.set("cache-control", "no-store");
  return res;
}

// Verbs this route does not implement answer 404, not the framework's 405 (see
// lib/founders/method-guard.ts).
export const POST = methodNotHere;
export const PUT = methodNotHere;
export const PATCH = methodNotHere;
export const DELETE = methodNotHere;
