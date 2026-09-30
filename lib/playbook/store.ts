/**
 * lib/playbook/store.ts - the stored half of the business documents hub
 * (playbook_docs, playbook_doc_versions, privacy_incidents; bravo__194).
 *
 * TENANT ISOLATION. Every statement names the tenant in its WHERE clause (or
 * its primary key). Callers pass the tenant from the resolved session
 * (lib/playbook/viewer.ts) or, for the harness import, the OASIS tenant the
 * route forces. Nothing here reads a tenant from a request body.
 *
 * VISIBILITY IN THE QUERY. Reads take the viewer's persona and add
 * `visibility IN (...)` (lib/playbook/visibility.ts), so a founders-only row is
 * never fetched for a teammate.
 *
 * NOT YET APPLIED IS NOT "MISSING". Until bravo__194 runs, reads answer
 * `table_missing` and writes answer `table_missing`; the page says storage is
 * not set up. Any other database error propagates (reads return `read_failed`
 * after logging), never "no documents".
 *
 * WRITES ARE ONE BATCH EACH. A document change and its version row commit or
 * roll back together, and every change is conditioned on the version the
 * writer read, so two founders editing at once cannot silently overwrite each
 * other: the second gets `conflict`.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Client, InStatement, ResultSet } from "@libsql/client";
import type { Persona } from "@/lib/role-surfaces";
import type { CatalogDoc } from "./catalog";
import { visibilityClause } from "./visibility";
import { departmentForDocOwner } from "@/lib/os/chat-href";
import { PLACEHOLDER_OPEN } from "./status";

export type StoredDoc = {
  id: string;
  tenant_id: string;
  slug: string;
  kind: string;
  category: string;
  title: string;
  summary: string;
  body_md: string | null;
  status: string;
  visibility: string;
  required: number;
  required_by: string | null;
  owner_department: string;
  source: string;
  source_ref: string | null;
  source_url: string | null;
  source_updated_at: string | null;
  content_sha256: string | null;
  review_every_days: number | null;
  counsel_reviewed_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  version: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type DocVersion = {
  version: number;
  status: string;
  content_sha256: string | null;
  changed_by: string;
  changed_at: string;
  note: string;
};

export type Incident = {
  id: string;
  recorded_at: string;
  recorded_by: string;
  personal_info: string;
  circumstances: string;
  occurred_period: string;
  aware_at: string;
  persons_count: number | null;
  risk_assessment: string;
  serious_risk: number | null;
  cai_notified_at: string | null;
  persons_notified_at: string | null;
  measures: string;
  corrects_id: string | null;
};

export type StoreRead<T> = { ok: true; value: T } | { ok: false; reason: "table_missing" | "read_failed" };

const TABLES = /no such table: (playbook_docs|playbook_doc_versions|privacy_incidents)\b/i;

export function isMissingTable(err: unknown): boolean {
  return TABLES.test(err instanceof Error ? err.message : String(err));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function rowsOf<T>(rs: ResultSet): T[] {
  return rs.rows.map((r) => {
    const o: Record<string, unknown> = {};
    rs.columns.forEach((c, i) => {
      const v = (r as unknown as unknown[])[i];
      o[c] = typeof v === "bigint" ? Number(v) : v;
    });
    return o as T;
  });
}

// libSQL over HTTP can hand integers back as strings; the columns that are
// compared as numbers are normalised here, at the boundary.
function normaliseDoc(d: StoredDoc): StoredDoc {
  return {
    ...d,
    version: Number(d.version),
    required: Number(d.required),
    review_every_days: d.review_every_days === null || d.review_every_days === undefined ? null : Number(d.review_every_days),
  };
}

async function read<T>(where: string, run: () => Promise<T>): Promise<StoreRead<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    if (isMissingTable(err)) return { ok: false, reason: "table_missing" };
    console.error(`[playbook.store.${where}]`, err);
    return { ok: false, reason: "read_failed" };
  }
}

const DOC_COLUMNS =
  "id, tenant_id, slug, kind, category, title, summary, body_md, status, visibility, required, required_by, " +
  "owner_department, source, source_ref, source_url, source_updated_at, content_sha256, review_every_days, " +
  "counsel_reviewed_at, approved_by, approved_at, version, updated_by, created_at, updated_at";

/** Every stored document `persona` may see in `tenantId`. */
export function listStoredDocs(db: Client, tenantId: string, persona: Persona): Promise<StoreRead<StoredDoc[]>> {
  if (!tenantId) throw new Error("listStoredDocs: tenantId is required");
  const vis = visibilityClause(persona);
  return read("list", async () =>
    rowsOf<StoredDoc>(
      await db.execute({
        sql: `SELECT ${DOC_COLUMNS} FROM playbook_docs WHERE tenant_id = ? AND ${vis.sql} ORDER BY slug`,
        args: [tenantId, ...vis.args],
      }),
    ).map(normaliseDoc),
  );
}

/** One stored document, or null when there is none `persona` may see. */
export function getStoredDoc(db: Client, tenantId: string, slug: string, persona: Persona): Promise<StoreRead<StoredDoc | null>> {
  if (!tenantId) throw new Error("getStoredDoc: tenantId is required");
  const vis = visibilityClause(persona);
  return read("get", async () => {
    const rows = rowsOf<StoredDoc>(
      await db.execute({
        sql: `SELECT ${DOC_COLUMNS} FROM playbook_docs WHERE tenant_id = ? AND slug = ? AND ${vis.sql} LIMIT 1`,
        args: [tenantId, slug, ...vis.args],
      }),
    );
    return rows[0] ? normaliseDoc(rows[0]) : null;
  });
}

/** A document's saved versions, newest first. The caller has already checked it may see the document. */
export function listVersions(db: Client, tenantId: string, slug: string): Promise<StoreRead<DocVersion[]>> {
  if (!tenantId) throw new Error("listVersions: tenantId is required");
  return read("versions", async () =>
    rowsOf<DocVersion>(
      await db.execute({
        sql: `SELECT version, status, content_sha256, changed_by, changed_at, note FROM playbook_doc_versions
              WHERE tenant_id = ? AND slug = ? ORDER BY version DESC LIMIT 50`,
        args: [tenantId, slug],
      }),
    ).map((v) => ({ ...v, version: Number(v.version) })),
  );
}

// --- writes ------------------------------------------------------------------

export type WriteResult<T = { version: number }> =
  | ({ ok: true } & T)
  | { ok: false; reason: "table_missing" | "exists" | "conflict" | "not_found" | "placeholders" | "unchanged" | "in_app_owned" };

function versionInsert(docId: string, note: string, changedBy: string, versionId: string): InStatement {
  // Copies the row as it stands after the change, in the same batch. When the
  // change matched nothing (a stale version, or a draft that already existed),
  // either no row has this id, or the row's version already has its version
  // row and the migration's no_replace trigger drops the duplicate. The caller
  // reads rowsAffected of the change itself to report the conflict.
  return {
    sql: `INSERT INTO playbook_doc_versions (id, tenant_id, doc_id, slug, version, status, body_md, content_sha256, changed_by, changed_at, note)
          SELECT ?, tenant_id, id, slug, version, status, body_md, content_sha256, ?, updated_at, ?
          FROM playbook_docs WHERE id = ? AND updated_by = ?`,
    args: [versionId, changedBy, note, docId, changedBy],
  };
}

async function batch(db: Client, stmts: InStatement[]): Promise<ResultSet[] | "table_missing"> {
  try {
    return await db.batch(stmts, "write");
  } catch (err) {
    if (isMissingTable(err)) return "table_missing";
    throw err;
  }
}

async function docIdFor(db: Client, tenantId: string, slug: string): Promise<{ id: string; version: number; source: string; status: string; body_md: string | null; source_url: string | null } | null | "table_missing"> {
  try {
    const rows = rowsOf<{ id: string; version: number; source: string; status: string; body_md: string | null; source_url: string | null }>(
      await db.execute({
        sql: "SELECT id, version, source, status, body_md, source_url FROM playbook_docs WHERE tenant_id = ? AND slug = ? LIMIT 1",
        args: [tenantId, slug],
      }),
    );
    return rows[0] ? { ...rows[0], version: Number(rows[0].version) } : null;
  } catch (err) {
    if (isMissingTable(err)) return "table_missing";
    throw err;
  }
}

/**
 * Create a document's first text (Draft it). Refused with `exists` when the
 * tenant already has a row for this slug: a draft never overwrites.
 */
export async function createDraft(
  db: Client,
  input: { tenantId: string; doc: CatalogDoc; body: string; actor: string; now: string },
): Promise<WriteResult> {
  const { tenantId, doc, body, actor, now } = input;
  if (!tenantId) throw new Error("createDraft: tenantId is required");
  const id = randomUUID();
  const results = await batch(db, [
    {
      sql: `INSERT INTO playbook_docs (id, tenant_id, slug, kind, category, title, summary, body_md, status, visibility, required,
              required_by, owner_department, source, source_ref, source_url, source_updated_at, content_sha256, review_every_days,
              counsel_reviewed_at, approved_by, approved_at, version, updated_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 'in_app', 'template', NULL, NULL, ?, ?, NULL, NULL, NULL, 1, ?, ?, ?)
            ON CONFLICT (tenant_id, slug) DO NOTHING`,
      args: [
        id, tenantId, doc.slug, doc.kind, doc.category, doc.title, doc.summary, body, doc.visibility, doc.required ? 1 : 0,
        doc.requiredBy, departmentForDocOwner(doc.owner), sha256Hex(body), doc.reviewEveryDays, actor, now, now,
      ],
    },
    versionInsert(id, "draft", actor, randomUUID()),
  ]);
  if (results === "table_missing") return { ok: false, reason: "table_missing" };
  if (results[0].rowsAffected !== 1) return { ok: false, reason: "exists" };
  return { ok: true, version: 1 };
}

/**
 * Replace a document's text (a founder's edit). The document becomes a draft
 * again: an edited text needs marking current again. Refused with `conflict`
 * when the document moved past `expectedVersion`, `unchanged` when the text is
 * the same.
 *
 * An edit makes the text the founder's: `source` becomes `in_app` (the
 * migration's "drafted or edited here"), so a later harness import answers
 * `in_app_owned` instead of replacing it. `source_ref` is kept, so where an
 * imported document first came from stays on record.
 */
export async function updateBody(
  db: Client,
  input: { tenantId: string; slug: string; body: string; actor: string; now: string; expectedVersion: number },
): Promise<WriteResult> {
  const { tenantId, slug, body, actor, now, expectedVersion } = input;
  if (!tenantId) throw new Error("updateBody: tenantId is required");
  const cur = await docIdFor(db, tenantId, slug);
  if (cur === "table_missing") return { ok: false, reason: "table_missing" };
  if (!cur) return { ok: false, reason: "not_found" };
  if (cur.version !== expectedVersion) return { ok: false, reason: "conflict" };
  const sha = sha256Hex(body);
  if (cur.body_md !== null && sha256Hex(cur.body_md) === sha) return { ok: false, reason: "unchanged" };
  const results = await batch(db, [
    {
      sql: `UPDATE playbook_docs SET body_md = ?, content_sha256 = ?, status = 'draft', source = 'in_app', approved_by = NULL, approved_at = NULL,
              version = version + 1, updated_by = ?, updated_at = ?
            WHERE tenant_id = ? AND slug = ? AND version = ? AND status != 'superseded'`,
      args: [body, sha, actor, now, tenantId, slug, expectedVersion],
    },
    versionInsert(cur.id, "edit", actor, randomUUID()),
  ]);
  if (results === "table_missing") return { ok: false, reason: "table_missing" };
  if (results[0].rowsAffected !== 1) return { ok: false, reason: "conflict" };
  return { ok: true, version: expectedVersion + 1 };
}

/**
 * Mark a draft current (founders). Refused with `placeholders` while any
 * [[CC to confirm placeholder remains; the SQL repeats that check, so a race
 * with an edit cannot slip a placeholder through.
 */
export async function markCurrent(
  db: Client,
  input: { tenantId: string; slug: string; actor: string; now: string; expectedVersion: number },
): Promise<WriteResult> {
  const { tenantId, slug, actor, now, expectedVersion } = input;
  if (!tenantId) throw new Error("markCurrent: tenantId is required");
  const cur = await docIdFor(db, tenantId, slug);
  if (cur === "table_missing") return { ok: false, reason: "table_missing" };
  if (!cur) return { ok: false, reason: "not_found" };
  if (cur.version !== expectedVersion) return { ok: false, reason: "conflict" };
  if ((cur.body_md || "").includes(PLACEHOLDER_OPEN)) return { ok: false, reason: "placeholders" };
  if (cur.status === "current") return { ok: false, reason: "unchanged" };
  const results = await batch(db, [
    {
      sql: `UPDATE playbook_docs SET status = 'current', approved_by = ?, approved_at = ?, source_updated_at = ?,
              version = version + 1, updated_by = ?, updated_at = ?
            WHERE tenant_id = ? AND slug = ? AND version = ? AND status IN ('draft', 'drafting')
              AND ((body_md IS NOT NULL AND instr(body_md, ?) = 0) OR (body_md IS NULL AND source_url IS NOT NULL))`,
      args: [actor, now, now, actor, now, tenantId, slug, expectedVersion, PLACEHOLDER_OPEN],
    },
    versionInsert(cur.id, "mark_current", actor, randomUUID()),
  ]);
  if (results === "table_missing") return { ok: false, reason: "table_missing" };
  if (results[0].rowsAffected !== 1) return { ok: false, reason: "conflict" };
  return { ok: true, version: expectedVersion + 1 };
}

export type ImportInput = {
  tenantId: string;
  doc: CatalogDoc;
  /** The text, or null for a link-only document (a signed agreement kept where it was signed). */
  body: string | null;
  sourceRef: string;
  sourceUrl: string | null;
  sourceUpdatedAt: string | null;
  actor: string;
  now: string;
};

/**
 * The harness import. A new document lands as a draft; a changed one replaces
 * the text of a document the import owns and returns it to draft. The same
 * hash is `unchanged` (a no-op, no version). A document drafted in the app, or
 * an imported one a founder has since edited (updateBody sets source =
 * 'in_app'), is `in_app_owned`: an import never overwrites a founder's text.
 */
export async function importDoc(db: Client, input: ImportInput): Promise<WriteResult<{ version: number; action: "created" | "updated" }>> {
  const { tenantId, doc, body, sourceRef, sourceUrl, sourceUpdatedAt, actor, now } = input;
  if (!tenantId) throw new Error("importDoc: tenantId is required");
  const sha = sha256Hex(body ?? `link:${sourceUrl ?? ""}`);
  const cur = await docIdFor(db, tenantId, doc.slug);
  if (cur === "table_missing") return { ok: false, reason: "table_missing" };
  if (!cur) {
    const id = randomUUID();
    const results = await batch(db, [
      {
        sql: `INSERT INTO playbook_docs (id, tenant_id, slug, kind, category, title, summary, body_md, status, visibility, required,
                required_by, owner_department, source, source_ref, source_url, source_updated_at, content_sha256, review_every_days,
                counsel_reviewed_at, approved_by, approved_at, version, updated_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 'import', ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, ?, ?, ?)
              ON CONFLICT (tenant_id, slug) DO NOTHING`,
        args: [
          id, tenantId, doc.slug, doc.kind, doc.category, doc.title, doc.summary, body, doc.visibility, doc.required ? 1 : 0,
          doc.requiredBy, departmentForDocOwner(doc.owner), sourceRef, sourceUrl, sourceUpdatedAt, sha, doc.reviewEveryDays, actor, now, now,
        ],
      },
      versionInsert(id, "import", actor, randomUUID()),
    ]);
    if (results === "table_missing") return { ok: false, reason: "table_missing" };
    if (results[0].rowsAffected !== 1) return { ok: false, reason: "conflict" };
    return { ok: true, version: 1, action: "created" };
  }
  if (cur.source !== "import") return { ok: false, reason: "in_app_owned" };
  const existing = await db.execute({
    sql: "SELECT content_sha256 FROM playbook_docs WHERE id = ? AND tenant_id = ?",
    args: [cur.id, tenantId],
  });
  if (String(existing.rows[0]?.[0] ?? "") === sha) return { ok: false, reason: "unchanged" };
  const results = await batch(db, [
    {
      sql: `UPDATE playbook_docs SET body_md = ?, source_ref = ?, source_url = ?, source_updated_at = ?, content_sha256 = ?,
              status = 'draft', approved_by = NULL, approved_at = NULL, version = version + 1, updated_by = ?, updated_at = ?
            WHERE tenant_id = ? AND slug = ? AND version = ? AND source = 'import'`,
      args: [body, sourceRef, sourceUrl, sourceUpdatedAt, sha, actor, now, tenantId, doc.slug, cur.version],
    },
    versionInsert(cur.id, "import", actor, randomUUID()),
  ]);
  if (results === "table_missing") return { ok: false, reason: "table_missing" };
  if (results[0].rowsAffected !== 1) return { ok: false, reason: "conflict" };
  return { ok: true, version: cur.version + 1, action: "updated" };
}

// --- privacy incidents (Law 25 s.3.8) ---------------------------------------

export type IncidentInput = Omit<Incident, "id" | "recorded_at" | "recorded_by">;

export function listIncidents(db: Client, tenantId: string): Promise<StoreRead<Incident[]>> {
  if (!tenantId) throw new Error("listIncidents: tenantId is required");
  return read("incidents", async () =>
    rowsOf<Incident>(
      await db.execute({
        sql: `SELECT id, recorded_at, recorded_by, personal_info, circumstances, occurred_period, aware_at, persons_count,
                risk_assessment, serious_risk, cai_notified_at, persons_notified_at, measures, corrects_id
              FROM privacy_incidents WHERE tenant_id = ? ORDER BY recorded_at DESC LIMIT 500`,
        args: [tenantId],
      }),
    ).map((i) => ({
      ...i,
      persons_count: i.persons_count === null ? null : Number(i.persons_count),
      serious_risk: i.serious_risk === null ? null : Number(i.serious_risk),
    })),
  );
}

/** Append one entry. There is no update and no delete: a correction is a new entry with corrects_id. */
export async function appendIncident(
  db: Client,
  input: { tenantId: string; entry: IncidentInput; actor: string; now: string },
): Promise<{ ok: true; id: string } | { ok: false; reason: "table_missing" | "unknown_correction" }> {
  const { tenantId, entry, actor, now } = input;
  if (!tenantId) throw new Error("appendIncident: tenantId is required");
  const id = randomUUID();
  try {
    if (entry.corrects_id) {
      const found = await db.execute({
        sql: "SELECT 1 FROM privacy_incidents WHERE tenant_id = ? AND id = ? LIMIT 1",
        args: [tenantId, entry.corrects_id],
      });
      if (found.rows.length === 0) return { ok: false, reason: "unknown_correction" };
    }
    await db.execute({
      sql: `INSERT INTO privacy_incidents (id, tenant_id, recorded_at, recorded_by, personal_info, circumstances, occurred_period,
              aware_at, persons_count, risk_assessment, serious_risk, cai_notified_at, persons_notified_at, measures, corrects_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, tenantId, now, actor, entry.personal_info, entry.circumstances, entry.occurred_period, entry.aware_at,
        entry.persons_count, entry.risk_assessment, entry.serious_risk, entry.cai_notified_at, entry.persons_notified_at,
        entry.measures, entry.corrects_id,
      ],
    });
    return { ok: true, id };
  } catch (err) {
    if (isMissingTable(err)) return { ok: false, reason: "table_missing" };
    throw err;
  }
}
