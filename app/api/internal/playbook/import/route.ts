/**
 * POST /api/internal/playbook/import - the harness copies allowlisted document
 * text into OASIS's business documents hub (lib/playbook/import.ts has the
 * rules: operator proxy bearer, tenant forced to OASIS, catalog "stored"
 * documents only, credentials refused, same hash a no-op).
 *
 * Body: { "docs": [ { "slug": "decisions-log", "body_md": "...",
 *   "source_ref": "BEA memory/DECISIONS.md", "source_updated_at": "2026-09-29" },
 *   { "slug": "founders-agreement", "source_ref": "Drive",
 *     "source_url": "https://docs.google.com/..." } ] }  (at most 50)
 *
 * Answers per item: created | updated | unchanged | skipped (a founder's in-app
 * text is never overwritten) | rejected (with the reason). Nothing here marks a
 * document current: a founder does that in the app.
 *
 * Runs only after CC consents to copying document text into Turso (US region).
 */
import { NextResponse } from "next/server";
import { docsDb } from "@/lib/playbook/documents";
import { IMPORT_BEARER_ENV, IMPORT_MAX_DOCS, importBearerOk, parseImportItem } from "@/lib/playbook/import";
import { importDoc } from "@/lib/playbook/store";
import { OASIS_DOCS_TENANT_ID } from "@/lib/playbook/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMPORT_ACTOR = "import:harness";

function reply(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const expected = (process.env[IMPORT_BEARER_ENV] || "").trim();
  if (expected.length < 24) {
    return reply({ ok: false, error: "import_not_configured", detail: `${IMPORT_BEARER_ENV} is not set (min 24 chars).` }, 503);
  }
  if (!importBearerOk(req.headers.get("authorization"), expected)) return reply({ ok: false, error: "unauthorized" }, 401);

  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 12_000_000) return reply({ ok: false, error: "too_large" }, 413);
    body = JSON.parse(text);
  } catch {
    return reply({ ok: false, error: "invalid_json" }, 400);
  }
  const docs = (body as { docs?: unknown })?.docs;
  if (!Array.isArray(docs) || docs.length === 0) return reply({ ok: false, error: "docs_required" }, 400);
  if (docs.length > IMPORT_MAX_DOCS) return reply({ ok: false, error: "too_many_docs", max: IMPORT_MAX_DOCS }, 400);

  const db = docsDb();
  if (!db) return reply({ ok: false, error: "storage_unavailable" }, 503);
  const now = new Date().toISOString();
  const results: Array<Record<string, unknown>> = [];
  for (let i = 0; i < docs.length; i += 1) {
    const parsed = parseImportItem(docs[i], i);
    if (!parsed.ok) {
      results.push({ index: i, slug: parsed.rejection.slug, status: "rejected", error: parsed.rejection.error });
      continue;
    }
    const { item } = parsed;
    const r = await importDoc(db, {
      tenantId: OASIS_DOCS_TENANT_ID,
      doc: item.doc,
      body: item.body,
      sourceRef: item.sourceRef,
      sourceUrl: item.sourceUrl,
      sourceUpdatedAt: item.sourceUpdatedAt,
      actor: IMPORT_ACTOR,
      now,
    });
    if (r.ok) results.push({ index: i, slug: item.doc.slug, status: r.action, version: r.version });
    else if (r.reason === "table_missing") return reply({ ok: false, error: "storage_not_ready", results }, 503);
    else if (r.reason === "unchanged") results.push({ index: i, slug: item.doc.slug, status: "unchanged" });
    else if (r.reason === "in_app_owned") results.push({ index: i, slug: item.doc.slug, status: "skipped", error: "edited_in_app" });
    else results.push({ index: i, slug: item.doc.slug, status: "rejected", error: r.reason });
  }
  const count = (s: string) => results.filter((r) => r.status === s).length;
  return reply({
    ok: true,
    created: count("created"),
    updated: count("updated"),
    unchanged: count("unchanged"),
    skipped: count("skipped"),
    rejected: count("rejected"),
    results,
  });
}
