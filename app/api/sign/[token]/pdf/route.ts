/**
 * GET /api/sign/[token]/pdf — stream the source PDF for the signing page to
 * iframe. Public + token-gated (same 32-byte token as the signing page; the
 * `/api/sign/` prefix is already in middleware's PUBLIC_PATH_PREFIXES).
 *
 * Why this exists: rendering the document from a client-built blob:/data: URL
 * was unreliable across browsers (blank iframe). Serving the bytes from a real
 * URL with `Content-Type: application/pdf` lets the browser's native PDF
 * viewer load it directly — the robust way to iframe a PDF.
 *
 * Fail-closed: any bad/expired/unknown token collapses to a generic 404 (no
 * enumeration). Signed/declined signers can still VIEW their document, so this
 * only rejects on expiry or a missing token, not on signer status.
 */

import { NextResponse, type NextRequest } from "next/server";
import { hashIncomingToken } from "@/lib/esign/tokens";
import { getSignerByTokenHash } from "@/lib/esign/db";
import { downloadEsignPdf } from "@/lib/esign/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notFound() {
  return new NextResponse("Not found", { status: 404 });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const lookup = await getSignerByTokenHash(hashIncomingToken(token));
  if (!lookup.ok) return notFound();
  const { signer, envelope } = lookup;
  if (new Date(signer.expires_at).getTime() < Date.now()) return notFound();

  const src = await downloadEsignPdf(envelope.source_storage_key);
  if (!src.ok) return notFound();

  return new NextResponse(new Uint8Array(src.bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="document.pdf"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
