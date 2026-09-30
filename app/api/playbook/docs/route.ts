/**
 * GET /api/playbook/docs - the business documents the signed-in OASIS member
 * may see, with each one's derived status and source.
 *
 * OASIS workspaces only (404 for anyone else), filtered by persona
 * (lib/playbook/visibility.ts): a teammate never receives a founders-only row.
 */
import { docsDb, listDocs } from "@/lib/playbook/documents";
import { json, requireDocsViewer } from "@/lib/playbook/http";
import { STATUS_LABEL } from "@/lib/playbook/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const who = await requireDocsViewer();
  if (!who.ok) return who.response;
  const { rows, storage } = await listDocs(who.viewer, docsDb(), new Date());
  return json({
    ok: true,
    storage,
    docs: rows.map((r) => ({
      slug: r.doc.slug,
      title: r.doc.title,
      category: r.doc.category,
      visibility: r.doc.visibility,
      required: r.doc.required,
      status: r.status,
      status_label: STATUS_LABEL[r.status],
      source: r.sourceLabel,
      source_updated_at: r.sourceDate,
    })),
  });
}
