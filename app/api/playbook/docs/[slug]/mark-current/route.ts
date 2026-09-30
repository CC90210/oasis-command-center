/**
 * POST /api/playbook/docs/[slug]/mark-current - a founder confirms a draft is
 * the current version. Body: { "expected_version": 2 }.
 *
 * Refused with one sentence while any [[CC to confirm placeholder remains: a
 * document with an open question is not current. On success the document is
 * Current, approved_by / approved_at are the founder and now, and a version
 * row is written.
 *
 * This is not an approval card (lib/os/approvals belongs to another track):
 * the founder IS the approver, and the click is the approval.
 */
import { docsDb, resolveDoc } from "@/lib/playbook/documents";
import { crossOrigin, json, notFoundJson, readJsonObject, requireDocsViewer, sameOrigin, STORAGE_NOT_READY } from "@/lib/playbook/http";
import { hasPlaceholders, PLACEHOLDER_REFUSAL, placeholdersIn } from "@/lib/playbook/status";
import { markCurrent } from "@/lib/playbook/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!sameOrigin(req)) return crossOrigin();
  const who = await requireDocsViewer();
  if (!who.ok) return who.response;
  const { slug } = await params;
  const db = docsDb();
  const r = await resolveDoc(who.viewer, slug, db, new Date());
  if (!r) return notFoundJson();
  if (!who.viewer.founder) return json({ ok: false, error: "founders_only", message: "Only a founder can mark a document current." }, 403);
  if (r.doc.source.kind !== "stored") {
    return json({ ok: false, error: "live_document", message: "This document renders from the live product and is always its current version." }, 409);
  }
  if (!db || r.storage === "read_failed") return json({ ok: false, error: "storage_unavailable", message: "The document could not be read just now. Try again." }, 503);
  if (r.storage === "table_missing") return json({ ok: false, error: "storage_not_ready", message: STORAGE_NOT_READY }, 503);
  if (!r.stored) return json({ ok: false, error: "not_drafted", message: "Draft this document first." }, 409);
  if (hasPlaceholders(r.stored.body_md)) {
    return json({ ok: false, error: "placeholders", message: PLACEHOLDER_REFUSAL, placeholders: placeholdersIn(r.stored.body_md) }, 409);
  }

  const body = await readJsonObject(req, 10_000);
  const expected = Number(body?.expected_version);
  if (!Number.isInteger(expected) || expected < 1) return json({ ok: false, error: "invalid_version" }, 400);

  const result = await markCurrent(db, {
    tenantId: who.viewer.tenantId,
    slug: r.doc.slug,
    actor: who.viewer.actor,
    now: new Date().toISOString(),
    expectedVersion: expected,
  });
  if (result.ok) return json({ ok: true, status: "current", version: result.version });
  if (result.reason === "placeholders") return json({ ok: false, error: "placeholders", message: PLACEHOLDER_REFUSAL }, 409);
  if (result.reason === "unchanged") return json({ ok: true, status: "current", version: expected, unchanged: true });
  if (result.reason === "conflict") {
    return json({ ok: false, error: "conflict", message: "This document changed since you opened it. Reload and check it again." }, 409);
  }
  if (result.reason === "table_missing") return json({ ok: false, error: "storage_not_ready", message: STORAGE_NOT_READY }, 503);
  return notFoundJson();
}
