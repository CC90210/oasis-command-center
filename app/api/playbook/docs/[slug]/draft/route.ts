/**
 * POST /api/playbook/docs/[slug]/draft - "Draft it" (founders).
 *
 * Renders the document's deterministic template (lib/playbook/templates),
 * filled only from verified constants and tables read now; every unknown is a
 * [[CC to confirm: ...]] placeholder. Saves it as a Draft with version 1. No AI
 * model is involved, so it answers in well under a second.
 *
 * Refused: for a document the reader may not see (404), for a teammate (403),
 * for a live or bundled document (409), when a text already exists (409: a
 * draft never overwrites), and while storage is not set up (503).
 */
import { docsDb, resolveDoc } from "@/lib/playbook/documents";
import { crossOrigin, json, notFoundJson, requireDocsViewer, sameOrigin, STORAGE_NOT_READY } from "@/lib/playbook/http";
import { placeholdersIn } from "@/lib/playbook/status";
import { createDraft } from "@/lib/playbook/store";
import { hasTemplate, loadTemplateContext, renderTemplate } from "@/lib/playbook/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!sameOrigin(req)) return crossOrigin();
  const who = await requireDocsViewer();
  if (!who.ok) return who.response;
  const { slug } = await params;
  const db = docsDb();
  const now = new Date();
  const r = await resolveDoc(who.viewer, slug, db, now);
  if (!r) return notFoundJson();
  if (!who.viewer.founder) return json({ ok: false, error: "founders_only", message: "Only a founder can draft a business document." }, 403);
  if (r.doc.source.kind !== "stored" || !hasTemplate(r.doc.slug)) {
    return json({ ok: false, error: "not_draftable", message: "This document renders from its live source; there is nothing to draft." }, 409);
  }
  if (!db || r.storage === "read_failed") return json({ ok: false, error: "storage_unavailable", message: "The document could not be read just now. Try again." }, 503);
  if (r.storage === "table_missing") return json({ ok: false, error: "storage_not_ready", message: STORAGE_NOT_READY }, 503);
  if (r.stored) return json({ ok: false, error: "exists", message: "This document already has a text. Open it to edit." }, 409);

  const ctx = await loadTemplateContext(db, who.viewer.tenantId, now);
  const body = renderTemplate(r.doc, ctx);
  const result = await createDraft(db, { tenantId: who.viewer.tenantId, doc: r.doc, body, actor: who.viewer.actor, now: now.toISOString() });
  if (result.ok) return json({ ok: true, status: "draft", version: result.version, placeholders: placeholdersIn(body) });
  if (result.reason === "exists") return json({ ok: false, error: "exists", message: "This document already has a text. Open it to edit." }, 409);
  if (result.reason === "table_missing") return json({ ok: false, error: "storage_not_ready", message: STORAGE_NOT_READY }, 503);
  return json({ ok: false, error: result.reason }, 409);
}
