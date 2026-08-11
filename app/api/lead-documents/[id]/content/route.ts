import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getAuthorizedLeadDocument } from "@/lib/lead-document-access";
import {
  documentPreviewKind,
  imageNeedsBrowserSafeConversion,
  normalizedDocumentMime,
} from "@/lib/document-preview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function contentDisposition(filename: string, attachment: boolean): string {
  const ascii = (filename || "document").replace(/[^\x20-\x7E]+/g, "_").replace(/["\\]/g, "_");
  return `${attachment ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename || "document")}`;
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const access = await getAuthorizedLeadDocument(sess, id);
  if (!access.ok) {
    return NextResponse.json({ ok: false, error: access.error }, { status: access.status });
  }

  const doc = access.document;
  const mime = normalizedDocumentMime(doc.filename, doc.mime_type);
  const kind = documentPreviewKind(doc.filename, doc.mime_type);
  const forceDownload = req.nextUrl.searchParams.get("download") === "1" || kind === "download";
  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Disposition": contentDisposition(doc.filename, forceDownload),
    "X-Content-Type-Options": "nosniff",
  });

  // HEIC/HEIF/TIFF/BMP and other uncommon image formats are valid intake
  // formats but not consistently browser-renderable. Convert only the inline
  // preview; downloads retain the exact original bytes.
  if (!forceDownload && kind === "image" && imageNeedsBrowserSafeConversion(mime)) {
    const db = getServiceSupabase();
    const downloaded = await db.storage.from("lead-documents").download(doc.activePath);
    if (downloaded.error || !downloaded.data) {
      return NextResponse.json(
        { ok: false, error: downloaded.error?.message || "storage_download_failed" },
        { status: 502 },
      );
    }
    try {
      const sharp = (await import("sharp")).default;
      const source = Buffer.from(await downloaded.data.arrayBuffer());
      const preview = await sharp(source).rotate().jpeg({ quality: 90 }).toBuffer();
      headers.set("Content-Type", "image/jpeg");
      headers.set("Content-Length", String(preview.length));
      return new NextResponse(new Uint8Array(preview), { status: 200, headers });
    } catch {
      return NextResponse.json({ ok: false, error: "image_preview_conversion_failed" }, { status: 422 });
    }
  }

  const db = getServiceSupabase();
  const signed = await db.storage.from("lead-documents").createSignedUrl(doc.activePath, 60);
  if (signed.error || !signed.data?.signedUrl) {
    return NextResponse.json({ ok: false, error: signed.error?.message || "sign_failed" }, { status: 502 });
  }
  const upstreamHeaders = new Headers();
  const range = req.headers.get("range");
  if (range) upstreamHeaders.set("Range", range);
  const upstream = await fetch(signed.data.signedUrl, { headers: upstreamHeaders, cache: "no-store" });
  if (!upstream.ok && upstream.status !== 206) {
    return NextResponse.json({ ok: false, error: `storage_http_${upstream.status}` }, { status: 502 });
  }

  headers.set("Content-Type", mime);
  for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}
