/**
 * /api/playbook/docs/[slug]
 *
 * GET  one document for the signed-in OASIS member: its text, derived status,
 *      source and (for stored documents) version history. A document the
 *      reader may not see is the same 404 as one that does not exist.
 * PUT  a founder replaces a stored document's text. Body:
 *      { "body_md": "...", "expected_version": 3 }. The document returns to
 *      Draft (an edited text needs marking current again) and a version row is
 *      written. A stale expected_version is 409, so two founders editing at
 *      once cannot overwrite each other.
 */
import { docsDb, resolveDoc } from "@/lib/playbook/documents";
import { crossOrigin, json, notFoundJson, readJsonObject, requireDocsViewer, sameOrigin, STORAGE_NOT_READY } from "@/lib/playbook/http";
import { STATUS_LABEL, placeholdersIn } from "@/lib/playbook/status";
import { updateBody } from "@/lib/playbook/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

const MAX_BODY_CHARS = 200_000;

export async function GET(_req: Request, { params }: Params) {
  const who = await requireDocsViewer();
  if (!who.ok) return who.response;
  const { slug } = await params;
  const r = await resolveDoc(who.viewer, slug, docsDb(), new Date());
  if (!r) return notFoundJson();
  return json({
    ok: true,
    doc: {
      slug: r.doc.slug,
      title: r.doc.title,
      category: r.doc.category,
      visibility: r.doc.visibility,
      status: r.status,
      status_label: STATUS_LABEL[r.status],
      source: r.sourceLabel,
      source_updated_at: r.sourceDate,
      body_md: r.body,
      body_error: r.bodyError,
      placeholders: placeholdersIn(r.body),
      version: r.stored?.version ?? null,
      storage: r.storage,
      // The source link is founders-only, like the "Open source" button.
      source_url: who.viewer.founder ? r.openHref : null,
      versions: r.versions,
    },
  });
}

export async function PUT(req: Request, { params }: Params) {
  if (!sameOrigin(req)) return crossOrigin();
  const who = await requireDocsViewer();
  if (!who.ok) return who.response;
  const { slug } = await params;
  const db = docsDb();
  const r = await resolveDoc(who.viewer, slug, db, new Date());
  if (!r) return notFoundJson();
  if (!who.viewer.founder) return json({ ok: false, error: "founders_only", message: "Only a founder can edit a business document." }, 403);
  if (r.doc.source.kind !== "stored") {
    return json({ ok: false, error: "live_document", message: "This document renders from the live product; change it at its source." }, 409);
  }
  if (!db || r.storage === "read_failed") return json({ ok: false, error: "storage_unavailable", message: "The document could not be read just now. Try again." }, 503);
  if (r.storage === "table_missing") return json({ ok: false, error: "storage_not_ready", message: STORAGE_NOT_READY }, 503);
  if (!r.stored) return json({ ok: false, error: "not_drafted", message: "Draft this document first." }, 409);

  const body = await readJsonObject(req);
  const text = typeof body?.body_md === "string" ? body.body_md.replace(/\r\n?/g, "\n") : null;
  const expected = Number(body?.expected_version);
  if (text === null || !text.trim()) return json({ ok: false, error: "invalid_body", message: "The document text is empty." }, 400);
  if (text.length > MAX_BODY_CHARS) return json({ ok: false, error: "too_long", message: "The document is longer than 200,000 characters." }, 400);
  if (!Number.isInteger(expected) || expected < 1) return json({ ok: false, error: "invalid_version" }, 400);

  const result = await updateBody(db, {
    tenantId: who.viewer.tenantId,
    slug: r.doc.slug,
    body: text,
    actor: who.viewer.actor,
    now: new Date().toISOString(),
    expectedVersion: expected,
  });
  if (result.ok) return json({ ok: true, version: result.version, status: "draft", placeholders: placeholdersIn(text) });
  if (result.reason === "unchanged") return json({ ok: true, version: expected, unchanged: true });
  if (result.reason === "conflict") {
    return json({ ok: false, error: "conflict", message: "Someone saved this document since you opened it. Reload to see their version." }, 409);
  }
  if (result.reason === "table_missing") return json({ ok: false, error: "storage_not_ready", message: STORAGE_NOT_READY }, 503);
  return notFoundJson();
}
