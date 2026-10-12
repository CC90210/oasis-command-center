/**
 * POST /api/forms/[id]/offer/video-upload/confirm  { upload_token }
 *
 * Verifies the object the matching POST .../video-upload just got a presigned
 * PUT for: the token names exactly one object, bound to this tenant AND this
 * form, briefly (lib/offer-pages/upload.ts confirmOfferUpload); then the real
 * object is HEAD-checked (exists, real size within its kind's cap, a
 * content-type that kind allows). Returns the verified piece the builder
 * assembles into a VideoRef and saves through the ordinary
 * PUT /api/forms/[id]/offer, which re-verifies it once more before attaching
 * it to the draft.
 *
 * WHO: formsSession({ edit: true }), same as the mint route. A token minted
 * under another workspace's session, or for another form, is refused exactly
 * like a missing object: this route never confirms whether a given object
 * exists to someone who cannot already prove they minted its token.
 */
import { NextRequest, NextResponse } from "next/server";
import { formsSession } from "@/lib/forms/access";
import { offerPagesDb } from "@/lib/offer-pages/store";
import { editableForm } from "@/lib/offer-pages/operator";
import { confirmOfferUpload, offerUploadStorage } from "@/lib/offer-pages/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS: Record<string, number> = {
  invalid_token: 400,
  token_expired: 400,
  invalid_path: 400,
  not_found: 404,
  too_large: 400,
  wrong_type: 400,
  swapped: 409,
  storage_unavailable: 503,
  key_unavailable: 503,
};

/** key_unavailable is reported under the plain-language code the review asked for; everything else keeps its own reason. */
function errorBody(error: string): { ok: false; error: string } {
  return { ok: false, error: error === "key_unavailable" ? "upload_unavailable" : error };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await formsSession({ edit: true });
  if (!auth.ok) return auth.response;
  const tenantId = auth.session.tenantId;
  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const db = offerPagesDb();
  if (!db) return NextResponse.json({ ok: false, error: "offer_pages_unavailable" }, { status: 503 });
  if (!(await editableForm(db, tenantId, id))) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const storage = offerUploadStorage();
  const result = await confirmOfferUpload({ db, tenantId, formId: id, uploadToken: body.upload_token, storage });
  if (!result.ok) {
    if (result.error === "key_unavailable") console.error("[offer-pages.video-upload.confirm] signing key unavailable");
    return NextResponse.json(errorBody(result.error), { status: STATUS[result.error] ?? 400, headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json(
    { ok: true, kind: result.upload.kind, path: result.upload.path, bytes: result.upload.bytes, mime: result.upload.mime },
    { headers: { "cache-control": "no-store" } },
  );
}
