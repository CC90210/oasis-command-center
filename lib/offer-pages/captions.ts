/**
 * lib/offer-pages/captions.ts - a Library video's WebVTT captions as a
 * response (design section 4.4), for the public captions route
 * (app/api/offer-page/captions) and the owner's preview route
 * (app/api/forms/[id]/offer/preview-video). Each route decides WHICH caption
 * row may be read; this only serves it.
 *
 * SIZE FIRST. The object store reads a whole object into memory
 * (lib/r2-storage.ts download), so the size on record (marketing_asset_media
 * .bytes) is checked before anything is downloaded, and the downloaded size
 * again before it is decoded. A WebVTT file is small; anything over the cap is
 * not a caption file and gets the same 404 as any refused ref.
 *
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */
import "server-only";
import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { NOT_FOUND } from "./public-http";
import type { MediaRow } from "./video";

/** WebVTT files are small; anything larger is not a caption file. */
export const MAX_VTT_BYTES = 512 * 1024;

export async function captionsResponse(
  caption: MediaRow,
  ctx: { where: string; formId: string; ref: string; cacheControl: string },
): Promise<Response> {
  if (caption.bytes != null && caption.bytes > MAX_VTT_BYTES) return NOT_FOUND();
  let got: { data: Blob | null; error: unknown };
  try {
    got = await getServiceSupabase().storage.from(caption.storage_bucket).download(caption.storage_path);
  } catch (err) {
    // No object store configured (or it threw): an honest 503, never a crash.
    console.error(`[${ctx.where}] object store unavailable`, { form_id: ctx.formId, error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  if (got.error || !got.data) {
    console.error(`[${ctx.where}] download failed`, { form_id: ctx.formId, ref: ctx.ref });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  if (got.data.size > MAX_VTT_BYTES) return NOT_FOUND();
  const text = new TextDecoder("utf-8").decode(new Uint8Array(await got.data.arrayBuffer()));
  if (!text.startsWith("WEBVTT") && !text.startsWith("﻿WEBVTT")) return NOT_FOUND();
  return new NextResponse(text, {
    status: 200,
    headers: {
      "content-type": "text/vtt; charset=utf-8",
      "cache-control": ctx.cacheControl,
      "x-content-type-options": "nosniff",
    },
  });
}
