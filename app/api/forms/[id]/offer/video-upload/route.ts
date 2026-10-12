/**
 * POST /api/forms/[id]/offer/video-upload  { kind, filename, mime_type, size_bytes }
 *
 * The builder's "Upload a video" (design section 4, slice V3): a presigned R2
 * PUT for one new object under THIS workspace's own tenant prefix, for
 * kind "video" | "poster" | "caption". Declared type and size are the first
 * gate (lib/offer-pages/upload.ts mintOfferUpload); nothing here is trusted
 * again after this - the confirm step re-reads the real object.
 *
 * WHO: formsSession({ edit: true }) (lib/forms/access.ts) - an owner or admin
 * of the session's own workspace, never in a retired one (403). Another
 * workspace's form id is 404; the tenant a path is minted under is the
 * SESSION's, never the body's.
 */
import { NextRequest, NextResponse } from "next/server";
import { formsSession } from "@/lib/forms/access";
import { offerPagesDb } from "@/lib/offer-pages/store";
import { editableForm } from "@/lib/offer-pages/operator";
import { mintOfferUpload, offerUploadStorage } from "@/lib/offer-pages/upload";
import { MAX_UPLOAD_BYTES, UPLOAD_MIME, type UploadKind } from "@/lib/offer-pages/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNAVAILABLE = () => NextResponse.json({ ok: false, error: "offer_pages_unavailable" }, { status: 503 });

function isUploadKind(v: unknown): v is UploadKind {
  return v === "video" || v === "poster" || v === "caption";
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
  if (!isUploadKind(body.kind)) {
    return NextResponse.json({ ok: false, error: "kind_required", message: "kind must be video, poster or caption" }, { status: 400 });
  }
  const mimeType = typeof body.mime_type === "string" ? body.mime_type.trim().toLowerCase() : "";
  const sizeBytes = typeof body.size_bytes === "number" ? body.size_bytes : NaN;
  if (!mimeType || !(mimeType in UPLOAD_MIME[body.kind])) {
    const names = Object.keys(UPLOAD_MIME[body.kind]).join(", ");
    return NextResponse.json({ ok: false, error: "unsupported_type", message: `That file type isn't allowed. Use ${names}.` }, { status: 400 });
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_UPLOAD_BYTES[body.kind]) {
    return NextResponse.json(
      { ok: false, error: "too_large", max_bytes: MAX_UPLOAD_BYTES[body.kind], message: "That file is larger than this upload allows." },
      { status: 400 },
    );
  }

  const db = offerPagesDb();
  if (!db) return UNAVAILABLE();
  if (!(await editableForm(db, tenantId, id))) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const storage = offerUploadStorage();
  const minted = await mintOfferUpload({ tenantId, formId: id, kind: body.kind, mimeType, sizeBytes, storage });
  if (!minted.ok) {
    if (minted.error === "storage_unavailable") return UNAVAILABLE();
    const status = minted.error === "too_large" ? 400 : 400;
    return NextResponse.json({ ok: false, error: minted.error }, { status });
  }
  return NextResponse.json(
    {
      ok: true,
      storage_path: minted.storagePath,
      signed_url: minted.signedUrl,
      upload_token: minted.uploadToken,
      expires_in: minted.expiresIn,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
