/**
 * lib/playbook/documents.ts - one document, or the whole list, resolved for a
 * reader: the catalog row, its text from its source, and its derived status.
 * The pages and the API routes share this, so the list, the viewer, Copy and
 * Download can never disagree about a document.
 *
 * Visibility is enforced here before any source is read: a document the
 * reader may not see resolves to null, which every caller answers with a 404.
 */

import "server-only";
import type { Client } from "@libsql/client";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { loadPlaybook } from "@/lib/playbooks";
import { CATALOG, catalogDoc, type CatalogDoc } from "./catalog";
import { LIVE_META, LiveSourceError, readGstQst, renderLiveSource } from "./live-sources";
import { deriveStatus, type DocStatus } from "./status";
import { getStoredDoc, listStoredDocs, listVersions, type DocVersion, type StoredDoc } from "./store";
import { hasTemplate } from "./templates";
import { mayViewVisibility, visibleCatalog } from "./visibility";
import type { DocsViewer } from "./viewer";

export type StorageState = "ok" | "table_missing" | "read_failed";

export type DocSummary = {
  doc: CatalogDoc;
  status: DocStatus;
  sourceLabel: string;
  sourceDate: string | null;
};

export type ResolvedDoc = DocSummary & {
  /** The markdown to show, copy and download. Null when there is none to show. */
  body: string | null;
  /** Why the body could not be produced (a live source that failed to read). */
  bodyError: string | null;
  /** Where the source is, for founders ("Open source"). */
  openHref: string | null;
  stored: StoredDoc | null;
  /** How the stored half answered. "ok" for a document that stores nothing. */
  storage: StorageState;
  versions: DocVersion[] | null;
  /** A founder may press Draft it: stored kind, nothing stored yet, a template exists, storage ready. */
  canDraft: boolean;
};

/** The database, or null when none is configured (the page then says storage is unavailable). */
export function docsDb(): Client | null {
  return tursoConfigured() ? getTursoClient() : null;
}

function storedSource(row: StoredDoc): { label: string; date: string | null } {
  if (row.source === "import") return { label: `Imported (${row.source_ref || "harness"})`, date: row.source_updated_at ?? row.updated_at };
  return { label: "Written in the app", date: row.approved_at ?? row.updated_at };
}

function bundledSource(doc: CatalogDoc & { source: { kind: "bundled" } }): { label: string; date: string | null; body: string } {
  const file = loadPlaybook(doc.source.playbookSlug);
  return { label: `Operating manual (${file.slug}.md)`, date: file.updated, body: file.body };
}

/** Every document the reader may see, with its status. One stored read for the whole list. */
export async function listDocs(viewer: DocsViewer, db: Client | null, now: Date): Promise<{ rows: DocSummary[]; storage: StorageState }> {
  const docs = visibleCatalog(viewer.persona, CATALOG);
  let storage: StorageState = "ok";
  let stored = new Map<string, StoredDoc>();
  if (!db) storage = "read_failed";
  else {
    const read = await listStoredDocs(db, viewer.tenantId, viewer.persona);
    if (read.ok) stored = new Map(read.value.map((r) => [r.slug, r]));
    else storage = read.reason;
  }

  // GST/QST is the one live source that needs a read; only founders see it.
  let gst: { date: string | null } | "unreadable" | null = null;
  if (docs.some((d) => d.source.kind === "app_live" && d.source.live === "gst_qst_status")) {
    try {
      gst = db ? { date: (await readGstQst(db)).updatedAt || null } : "unreadable";
    } catch (err) {
      if (!(err instanceof LiveSourceError)) throw err;
      gst = "unreadable";
    }
  }

  const rows: DocSummary[] = docs.map((doc) => {
    if (doc.source.kind === "app_live") {
      const meta = LIVE_META[doc.source.live];
      if (doc.source.live === "gst_qst_status") {
        if (gst === "unreadable" || gst === null) return { doc, status: "unknown" as DocStatus, sourceLabel: meta.sourceLabel, sourceDate: null };
        return { doc, status: deriveStatus(doc, { kind: "live", sourceDate: gst.date }, now), sourceLabel: meta.sourceLabel, sourceDate: gst.date };
      }
      return { doc, status: deriveStatus(doc, { kind: "live", sourceDate: meta.staticDate }, now), sourceLabel: meta.sourceLabel, sourceDate: meta.staticDate };
    }
    if (doc.source.kind === "bundled") {
      const b = bundledSource(doc as CatalogDoc & { source: { kind: "bundled" } });
      return { doc, status: deriveStatus(doc, { kind: "live", sourceDate: b.date }, now), sourceLabel: b.label, sourceDate: b.date };
    }
    if (storage === "read_failed") return { doc, status: "unknown" as DocStatus, sourceLabel: "Stored document", sourceDate: null };
    const row = stored.get(doc.slug) ?? null;
    // A row whose own visibility the reader may not see was not fetched: it
    // reads as missing to them, never as a hint that it exists.
    const s = row ? storedSource(row) : { label: "Not written yet", date: null };
    return { doc, status: deriveStatus(doc, { kind: "stored", row }, now), sourceLabel: s.label, sourceDate: s.date };
  });
  return { rows, storage };
}

/**
 * One document for the reader, or null when there is no such document or the
 * reader may not see it (the caller answers both with the same 404).
 */
export async function resolveDoc(viewer: DocsViewer, slug: string, db: Client | null, now: Date): Promise<ResolvedDoc | null> {
  const doc = catalogDoc(slug);
  if (!doc || !mayViewVisibility(viewer.persona, doc.visibility)) return null;

  if (doc.source.kind === "app_live") {
    const meta = LIVE_META[doc.source.live];
    const base = { doc, stored: null, storage: "ok" as StorageState, versions: null, canDraft: false, openHref: meta.openHref };
    try {
      const live = await renderLiveSource(doc.source.live, db);
      return {
        ...base,
        status: deriveStatus(doc, { kind: "live", sourceDate: live.sourceDate }, now),
        sourceLabel: live.sourceLabel,
        sourceDate: live.sourceDate,
        body: live.markdown,
        bodyError: null,
      };
    } catch (err) {
      if (!(err instanceof LiveSourceError)) throw err;
      return { ...base, status: "unknown", sourceLabel: meta.sourceLabel, sourceDate: null, body: null, bodyError: err.message };
    }
  }

  if (doc.source.kind === "bundled") {
    const b = bundledSource(doc as CatalogDoc & { source: { kind: "bundled" } });
    return {
      doc,
      status: deriveStatus(doc, { kind: "live", sourceDate: b.date }, now),
      sourceLabel: b.label,
      sourceDate: b.date,
      body: b.body,
      bodyError: null,
      openHref: `/playbook/${doc.source.playbookSlug}`,
      stored: null,
      storage: "ok",
      versions: null,
      canDraft: false,
    };
  }

  if (!db) {
    return {
      doc, status: "unknown", sourceLabel: "Stored document", sourceDate: null, body: null,
      bodyError: "The database is not configured, so this document could not be read.",
      openHref: null, stored: null, storage: "read_failed", versions: null, canDraft: false,
    };
  }
  const read = await getStoredDoc(db, viewer.tenantId, doc.slug, viewer.persona);
  if (!read.ok && read.reason === "read_failed") {
    return {
      doc, status: "unknown", sourceLabel: "Stored document", sourceDate: null, body: null,
      bodyError: "The stored document could not be read just now. Refresh to try again.",
      openHref: null, stored: null, storage: "read_failed", versions: null, canDraft: false,
    };
  }
  const row = read.ok ? read.value : null;
  const storage: StorageState = read.ok ? "ok" : "table_missing";
  let versions: DocVersion[] | null = null;
  if (row) {
    const v = await listVersions(db, viewer.tenantId, doc.slug);
    versions = v.ok ? v.value : null;
  }
  const s = row ? storedSource(row) : { label: "Not written yet", date: null };
  return {
    doc,
    status: deriveStatus(doc, { kind: "stored", row }, now),
    sourceLabel: s.label,
    sourceDate: s.date,
    body: row?.body_md ?? null,
    bodyError: null,
    openHref: row?.source_url ?? null,
    stored: row,
    storage,
    versions,
    canDraft: viewer.founder && !row && storage === "ok" && hasTemplate(doc.slug),
  };
}

/** The file name a download is saved under. */
export function downloadFileName(doc: CatalogDoc): string {
  return `oasis-${doc.slug}.md`;
}
