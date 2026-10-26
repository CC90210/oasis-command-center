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
 * lib/founders/asset-download). Tenant-scoped (a uuid in the URL proves nothing),
 * any brand: Content Tools downloads live under the `downloads` brand.
 */
import { NextResponse } from "next/server";

import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveFounder } from "@/lib/founders/gate";
import { methodNotHere } from "@/lib/founders/method-guard";
import { downloadFailureHref, downloadFilename, pickDownloadMedia, type DownloadMediaRow } from "@/lib/founders/asset-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

/**
 * A download that cannot be handed over, past the founder gate: back to the
 * Content page it was pressed on, with the reason in ?download= for that page to
 * say (lib/founders/asset-download.ts downloadFailureHref), when it came from
 * one; else the JSON it always answered. Download is a plain link, so JSON here
 * used to replace the page (audit, 2026-10-26).
 */
function failed(req: Request, code: string, status: number) {
  const back = downloadFailureHref(req.headers.get("referer"), req.url, code);
  if (!back) return NextResponse.json({ ok: false, error: code }, { status });
  const res = NextResponse.redirect(new URL(back, req.url), 303);
  res.headers.set("cache-control", "no-store");
  return res;
}

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
    .select("id, title, media_urls")
    .eq("tenant_id", founder.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (asset.error) return failed(req, "read_failed", 500);
  // Tenant-scoped, any brand: saving a file is not publishing it. The Content Tools
  // video extractor writes its downloads under the `downloads` brand (rights unknown,
  // never postable from OASIS's accounts: the publish route keeps its own oasis-ai
  // check), and the whole point of that tool is to hand the file to the operator.
  if (!asset.data) return failed(req, "not_found", 404);

  const media = await db
    .from("marketing_asset_media")
    .select("kind, storage_bucket, storage_path")
    .eq("tenant_id", founder.tenantId)
    .eq("asset_id", id);
  if (media.error) return failed(req, "read_failed", 500);

  const pick = pickDownloadMedia((media.data || []) as DownloadMediaRow[], asset.data.media_urls, slide);
  if (!pick) return failed(req, slide == null ? "no_media_attached" : "no_such_slide", 404);

  const name = downloadFilename(asset.data.title, pick.storage_path, slide);
  // The storage surface can THROW rather than answer an error (no R2 configured:
  // lib/supabase-server.ts refuses .storage on the Turso backend), and a throw
  // here was an uncaught 500 with no word to the operator. Either way it is
  // sign_failed, logged, and the page says so.
  let signed: Awaited<ReturnType<ReturnType<typeof db.storage.from>["createSignedUrl"]>>;
  try {
    signed = await db.storage.from(pick.storage_bucket).createSignedUrl(pick.storage_path, DOWNLOAD_URL_TTL_SEC, { download: name });
  } catch (err) {
    console.warn("[founders:download] sign threw", err instanceof Error ? err.message : String(err));
    return failed(req, "sign_failed", 502);
  }
  if (signed.error || !signed.data?.signedUrl) {
    console.warn("[founders:download] sign failed", signed.error?.message);
    return failed(req, "sign_failed", 502);
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
