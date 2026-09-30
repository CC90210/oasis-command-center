/**
 * GET /api/playbook/docs/[slug]/download - the document as a .md file
 * (text/markdown, Content-Disposition: attachment).
 *
 * The same visibility rule as the page: a document the reader may not see is
 * a 404, identical to one that does not exist. A document with no text yet
 * (Missing) or a live source that could not be read is 409 with the reason,
 * never an empty file.
 */
import { docsDb, downloadFileName, resolveDoc } from "@/lib/playbook/documents";
import { json, notFoundJson, requireDocsViewer } from "@/lib/playbook/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const who = await requireDocsViewer();
  if (!who.ok) return who.response;
  const { slug } = await params;
  const r = await resolveDoc(who.viewer, slug, docsDb(), new Date());
  if (!r) return notFoundJson();
  if (r.body === null) {
    return json(
      { ok: false, error: r.bodyError ? "source_unreadable" : "no_text", message: r.bodyError ?? "This document has no text yet. Draft it first." },
      409,
    );
  }
  const name = downloadFileName(r.doc);
  return new Response(r.body, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
