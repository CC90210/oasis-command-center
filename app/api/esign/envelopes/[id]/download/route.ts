/**
 * /api/esign/envelopes/[id]/download?variant=signed|source — stream the
 * PDF bytes for the console's detail-drawer download buttons. Tenant-
 * scoped, creator-or-admin only (same reasoning as void: these are the
 * legally-relevant original + completed documents).
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getEnvelopeById } from "@/lib/esign/db";
import { downloadEsignPdf } from "@/lib/esign/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });

  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });

  const envRes = await getEnvelopeById(sess.tenantId, id);
  if (!envRes.ok) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const envelope = envRes.envelope;

  if (!sess.isAdmin && envelope.created_by !== sess.userId) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const variant = (req.nextUrl.searchParams.get("variant") || "signed").toLowerCase();
  const storageKey = variant === "source" ? envelope.source_storage_key : envelope.signed_storage_key;
  if (!storageKey) {
    return NextResponse.json({ ok: false, error: variant === "source" ? "no_source" : "not_completed" }, { status: 404 });
  }

  const dl = await downloadEsignPdf(storageKey);
  if (!dl.ok) return NextResponse.json({ ok: false, error: "download_failed" }, { status: 500 });

  const filename = `${envelope.title.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 80) || "document"}_${variant}.pdf`;
  return new NextResponse(new Uint8Array(dl.bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
