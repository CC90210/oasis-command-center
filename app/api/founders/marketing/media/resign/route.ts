/**
 * POST /api/founders/marketing/media/resign  { url }
 *
 * One fresh signed link for a Library media object whose link stopped working
 * (an expired signature in a tab left open; CC via Maven, 2026-10-19). The tile
 * calls it once on an image or video error and retries with what comes back
 * (components/founders/SignedMedia.tsx); why, and what may be signed, is in
 * lib/founders/media-resign.ts.
 *
 * GUARDS, in order:
 *   1. Founders portal only: resolveFounder(), the gate every Library route uses.
 *      Anyone else gets 404, never 403 (lib/founders/gate.ts).
 *   2. A small JSON body whose `url` parses back to one of this Worker's signed
 *      R2 links (400 otherwise).
 *   3. The object is media of one of THIS workspace's Library assets, read with
 *      tenant_id on every query; anything else is 404, so the route says nothing
 *      about objects outside the workspace.
 *
 * Reads only: it writes nothing and moves no bytes.
 */
import { NextResponse } from "next/server";

import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient } from "@/lib/turso";
import { resolveFounder } from "@/lib/founders/gate";
import { methodNotHere } from "@/lib/founders/method-guard";
import {
  isTenantLibraryMedia,
  MAX_SIGNED_URL_CHARS,
  mediaRefFromSignedUrl,
  RESIGN_TTL_SEC,
} from "@/lib/founders/media-resign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
const badRequest = (error: string) => NextResponse.json({ ok: false, error }, { status: 400 });

export async function POST(req: Request) {
  const founder = await resolveFounder();
  if (!founder) return notFound();

  const text = await req.text();
  if (text.length > MAX_SIGNED_URL_CHARS + 64) return badRequest("too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return badRequest("invalid_json");
  }
  const raw = body && typeof body === "object" ? (body as { url?: unknown }).url : undefined;
  const ref = mediaRefFromSignedUrl(raw, process.env.R2_BUCKET);
  if (!ref) return badRequest("not_a_media_link");

  try {
    if (!(await isTenantLibraryMedia(getTursoClient(), founder.tenantId, ref))) return notFound();
  } catch (error) {
    console.error("[founders:media.resign] media read failed", error);
    return NextResponse.json({ ok: false, error: "read_failed" }, { status: 500 });
  }

  const signed = await getServiceSupabase().storage.from(ref.bucket).createSignedUrl(ref.path, RESIGN_TTL_SEC);
  if (signed.error || !signed.data?.signedUrl) {
    console.warn("[founders:media.resign] sign failed", signed.error?.message);
    return NextResponse.json({ ok: false, error: "sign_failed" }, { status: 502 });
  }
  const res = NextResponse.json({ ok: true, url: signed.data.signedUrl });
  res.headers.set("cache-control", "no-store");
  return res;
}

// Verbs this route does not implement answer 404, not the framework's 405 (see
// lib/founders/method-guard.ts).
export const GET = methodNotHere;
export const PUT = methodNotHere;
export const PATCH = methodNotHere;
export const DELETE = methodNotHere;
