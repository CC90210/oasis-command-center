/**
 * lib/offer-pages/store.ts - form_offer_pages (migration bravo__203): read,
 * save the draft, publish, unpublish, delete with the form.
 *
 * THE TABLE MAY NOT EXIST YET. The code ships before Bravo applies the
 * migration, so every read treats "no such table: form_offer_pages" as "this
 * form has no offer page": the public page renders today's form, the list
 * shows every form as an intake form, and the line "[offer-pages] table
 * missing" is logged once per isolate. The forms DELETE route has done the
 * same for support_desks since bravo__188. Writes refuse with `unavailable`.
 *
 * EVERY STATEMENT CARRIES tenant_id. The session's workspace is the
 * authorisation boundary; Turso has no row-level security, so a form id from
 * another workspace matches nothing.
 *
 * CONCURRENT EDITORS. The draft is saved compare-and-swap on draft_version: a
 * save that read version 4 lands only while the row is still at 4, and
 * otherwise answers `conflict` with the version that won. Publish is the same
 * swap, so what goes live is exactly the draft the owner checked.
 *
 * No `server-only`: tests drive this against a local libSQL file, and the seed
 * script runs it from a terminal. ASCII only.
 */
import type { Client, InStatement, ResultSet } from "@libsql/client";
import type { OfferPageDoc, TemplateKey } from "./types";
import { parseOfferPageDoc, OfferPageError, TEMPLATE_KEYS, withoutBrief } from "./types";
import { parseClaimTicks, type ClaimTick } from "./claims";
import { SUPPORT_FORM_SLUG, SUPPORT_FORM_TENANT_ID } from "@/lib/delivery/support-form";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

/**
 * The database offer pages live in: the Turso data plane, the one every forms
 * read uses in production (lib/supabase-server.ts routes .from() there under
 * EMPIRE_DATA_BACKEND=turso_cloud). null anywhere else, which reads as "no
 * offer pages": every form renders as it always has.
 */
export function offerPagesDb(): Client | null {
  if (process.env.EMPIRE_DATA_BACKEND !== "turso_cloud" || !tursoConfigured()) return null;
  try {
    return getTursoClient();
  } catch (err) {
    console.error("[offer-pages] database unavailable", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export type OfferRow = {
  formId: string;
  tenantId: string;
  template: TemplateKey;
  /** null when the stored draft no longer parses (shown to the owner, never rendered). */
  draft: OfferPageDoc | null;
  draftError: string | null;
  draftVersion: number;
  draftUpdatedAt: string | null;
  draftUpdatedBy: string | null;
  published: OfferPageDoc | null;
  publishedVersion: number;
  publishedAt: string | null;
  publishedBy: string | null;
  live: boolean;
  claims: ClaimTick[];
};

/** What the Offers list shows in its Page column. */
export type OfferPageStatus = "live" | "live_with_changes" | "draft";

export type ReadResult = { state: "none" } | { state: "row"; row: OfferRow } | { state: "unavailable" };

function rowsOf(rs: ResultSet): Array<Record<string, unknown>> {
  return rs.rows.map((r) => {
    const o: Record<string, unknown> = {};
    rs.columns.forEach((c, i) => {
      o[c] = (r as unknown as unknown[])[i];
    });
    return o;
  });
}

/** "form_offer_pages does not exist yet": bravo__203 has not been applied here. */
export function isMissingOfferTable(err: unknown): boolean {
  return /no such table:\s*"?form_offer_pages\b/i.test(err instanceof Error ? err.message : String(err));
}

let missingLogged = false;
/** Logged once per isolate (a settled boolean, never a promise). */
export function noteOfferTableMissing(where: string): void {
  if (missingLogged) return;
  missingLogged = true;
  console.error(`[offer-pages] table missing (${where}): migration bravo__203 not applied, every form renders as before`);
}

const COLUMNS =
  "form_id, tenant_id, template_key, draft, draft_version, draft_updated_at, draft_updated_by, " +
  "published, published_version, published_at, published_by, live, claims_confirmed";

function toRow(r: Record<string, unknown>): OfferRow {
  let draft: OfferPageDoc | null = null;
  let draftError: string | null = null;
  try {
    draft = parseOfferPageDoc(String(r.draft ?? "{}"));
  } catch (err) {
    draftError = err instanceof OfferPageError ? `${err.path}: ${err.reason}` : String(err);
  }
  let published: OfferPageDoc | null = null;
  if (r.published != null) {
    try {
      published = parseOfferPageDoc(String(r.published));
    } catch (err) {
      console.error("[offer-pages] published copy no longer parses", { form_id: r.form_id, error: String(err) });
    }
  }
  const template = TEMPLATE_KEYS.includes(String(r.template_key) as TemplateKey) ? (String(r.template_key) as TemplateKey) : "book_call";
  return {
    formId: String(r.form_id),
    tenantId: String(r.tenant_id),
    template,
    draft,
    draftError,
    draftVersion: Number(r.draft_version ?? 0),
    draftUpdatedAt: r.draft_updated_at == null ? null : String(r.draft_updated_at),
    draftUpdatedBy: r.draft_updated_by == null ? null : String(r.draft_updated_by),
    published,
    publishedVersion: Number(r.published_version ?? 0),
    publishedAt: r.published_at == null ? null : String(r.published_at),
    publishedBy: r.published_by == null ? null : String(r.published_by),
    live: Number(r.live ?? 0) === 1,
    claims: parseClaimTicks(r.claims_confirmed),
  };
}

/** This form's offer page row, scoped to the workspace. */
export async function readOfferRow(db: Client, tenantId: string, formId: string): Promise<ReadResult> {
  try {
    const rs = await db.execute({
      sql: `SELECT ${COLUMNS} FROM form_offer_pages WHERE tenant_id = ? AND form_id = ? LIMIT 1`,
      args: [tenantId, formId],
    });
    const r = rowsOf(rs)[0];
    return r ? { state: "row", row: toRow(r) } : { state: "none" };
  } catch (err) {
    if (!isMissingOfferTable(err)) throw err;
    noteOfferTableMissing("read");
    return { state: "unavailable" };
  }
}

/** What /f/ needs to know about a form's offer page. */
export type PublicOfferState = {
  /** The form has an offer page row, live or not. */
  hasRow: boolean;
  /** Its PUBLISHED copy while it is live, otherwise null (today's form). */
  live: OfferPageDoc | null;
};

/**
 * The page /f/ should draw for this form, and whether the form is an offer at
 * all, in one read. An offer's name is internal (New offer says so), so while
 * no page is live its plain form is titled with the workspace's name, never
 * the form's (app/f/[tenant_slug]/[form_slug]/page.tsx). Never throws: a
 * broken page layer must cost a visitor the landing page, never the form.
 */
export async function readPublicOfferState(db: Client, tenantId: string, formId: string): Promise<PublicOfferState> {
  const unreadable = (err: unknown) =>
    console.error("[offer-pages] live page unreadable, rendering the form", {
      form_id: formId,
      error: err instanceof Error ? err.message : String(err),
    });
  let r: Record<string, unknown> | undefined;
  try {
    const rs = await db.execute({
      sql: "SELECT live, published FROM form_offer_pages WHERE tenant_id = ? AND form_id = ? LIMIT 1",
      args: [tenantId, formId],
    });
    r = rowsOf(rs)[0];
  } catch (err) {
    if (isMissingOfferTable(err)) noteOfferTableMissing("live");
    else unreadable(err);
    return { hasRow: false, live: null };
  }
  if (!r) return { hasRow: false, live: null };
  if (Number(r.live ?? 0) !== 1 || r.published == null) return { hasRow: true, live: null };
  try {
    return { hasRow: true, live: parseOfferPageDoc(String(r.published)) };
  } catch (err) {
    unreadable(err);
    return { hasRow: true, live: null };
  }
}

/** Does this form have an offer page (live or not)? false when the table is missing. */
export async function hasOfferPage(db: Client, tenantId: string, formId: string): Promise<boolean> {
  try {
    const rs = await db.execute({
      sql: "SELECT 1 AS one FROM form_offer_pages WHERE tenant_id = ? AND form_id = ? LIMIT 1",
      args: [tenantId, formId],
    });
    return rs.rows.length > 0;
  } catch (err) {
    if (isMissingOfferTable(err)) {
      noteOfferTableMissing("has");
      return false;
    }
    throw err;
  }
}

/** Live, live with unpublished changes, or a draft nobody can see yet. */
export function statusOf(row: Pick<OfferRow, "live" | "published" | "draft">): OfferPageStatus {
  if (!row.live || !row.published) return "draft";
  const same = row.draft ? JSON.stringify(withoutBrief(row.draft)) === JSON.stringify(row.published) : true;
  return same ? "live" : "live_with_changes";
}

/** Each form's page status for the Offers list; null when the table is missing. */
export async function listOfferStatuses(
  db: Client,
  tenantId: string,
): Promise<Map<string, { status: OfferPageStatus; publishedVersion: number }> | null> {
  try {
    const rs = await db.execute({
      sql: "SELECT form_id, draft, published, live, draft_version, published_version FROM form_offer_pages WHERE tenant_id = ?",
      args: [tenantId],
    });
    const out = new Map<string, { status: OfferPageStatus; publishedVersion: number }>();
    for (const r of rowsOf(rs)) {
      let draft: OfferPageDoc | null = null;
      let published: OfferPageDoc | null = null;
      try {
        draft = parseOfferPageDoc(String(r.draft ?? "{}"));
      } catch {
        draft = null;
      }
      try {
        published = r.published == null ? null : parseOfferPageDoc(String(r.published));
      } catch {
        published = null;
      }
      const row = {
        live: Number(r.live) === 1,
        published,
        draft,
        draftVersion: Number(r.draft_version ?? 0),
        publishedVersion: Number(r.published_version ?? 0),
      };
      out.set(String(r.form_id), { status: statusOf(row), publishedVersion: row.publishedVersion });
    }
    return out;
  } catch (err) {
    if (isMissingOfferTable(err)) {
      noteOfferTableMissing("list");
      return null;
    }
    throw err;
  }
}

export type WriteResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: "unavailable" | "not_found" | "conflict"; currentVersion?: number };

/**
 * Give a form its offer page (New offer, Turn into an offer). Only for a form
 * of this workspace; a second call for the same form changes nothing.
 */
export async function createOfferRow(
  db: Client,
  input: { tenantId: string; formId: string; template: TemplateKey; draft: OfferPageDoc; actor: string | null; now: string },
): Promise<WriteResult<{ created: boolean }>> {
  try {
    const rs = await db.execute({
      sql: `INSERT INTO form_offer_pages (form_id, tenant_id, template_key, draft, draft_version, draft_updated_at, draft_updated_by, created_at, updated_at)
            SELECT ?, ?, ?, ?, 0, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM forms WHERE id = ? AND tenant_id = ?)
            ON CONFLICT (form_id) DO NOTHING`,
      args: [
        input.formId,
        input.tenantId,
        input.template,
        JSON.stringify(input.draft),
        input.now,
        input.actor,
        input.now,
        input.now,
        input.formId,
        input.tenantId,
      ],
    });
    if (rs.rowsAffected === 1) return { ok: true, created: true };
    const now = await readOfferRow(db, input.tenantId, input.formId);
    if (now.state === "row") return { ok: true, created: false };
    return { ok: false, error: "not_found" };
  } catch (err) {
    if (!isMissingOfferTable(err)) throw err;
    noteOfferTableMissing("create");
    return { ok: false, error: "unavailable" };
  }
}

async function currentVersion(db: Client, tenantId: string, formId: string): Promise<number | null> {
  const rs = await db.execute({
    sql: "SELECT draft_version FROM form_offer_pages WHERE tenant_id = ? AND form_id = ? LIMIT 1",
    args: [tenantId, formId],
  });
  const r = rowsOf(rs)[0];
  return r ? Number(r.draft_version ?? 0) : null;
}

/** Save the draft, compare-and-swap on the version the editor read. */
export async function saveDraft(
  db: Client,
  input: {
    tenantId: string;
    formId: string;
    draft: OfferPageDoc;
    expectedVersion: number;
    claims: ClaimTick[];
    actor: string | null;
    now: string;
  },
): Promise<WriteResult<{ version: number }>> {
  try {
    const rs = await db.execute({
      sql: `UPDATE form_offer_pages
            SET draft = ?, draft_version = draft_version + 1, draft_updated_at = ?, draft_updated_by = ?,
                claims_confirmed = ?, updated_at = ?
            WHERE tenant_id = ? AND form_id = ? AND draft_version = ?`,
      args: [
        JSON.stringify(input.draft),
        input.now,
        input.actor,
        JSON.stringify(input.claims),
        input.now,
        input.tenantId,
        input.formId,
        input.expectedVersion,
      ],
    });
    if (rs.rowsAffected === 1) return { ok: true, version: input.expectedVersion + 1 };
    const v = await currentVersion(db, input.tenantId, input.formId);
    if (v === null) return { ok: false, error: "not_found" };
    return { ok: false, error: "conflict", currentVersion: v };
  } catch (err) {
    if (!isMissingOfferTable(err)) throw err;
    noteOfferTableMissing("save");
    return { ok: false, error: "unavailable" };
  }
}

/**
 * Publish the draft the owner checked: its copy (brief stripped) becomes the
 * live page in one statement, and only while the draft is still the version
 * they checked.
 */
export async function publishDraft(
  db: Client,
  input: { tenantId: string; formId: string; draft: OfferPageDoc; draftVersion: number; actor: string | null; now: string },
): Promise<WriteResult<{ publishedVersion: number }>> {
  try {
    const rs = await db.execute({
      sql: `UPDATE form_offer_pages
            SET published = ?, published_version = published_version + 1, published_at = ?, published_by = ?,
                live = 1, updated_at = ?
            WHERE tenant_id = ? AND form_id = ? AND draft_version = ?
            RETURNING published_version`,
      args: [
        JSON.stringify(withoutBrief(input.draft)),
        input.now,
        input.actor,
        input.now,
        input.tenantId,
        input.formId,
        input.draftVersion,
      ],
    });
    const r = rowsOf(rs)[0];
    if (r) return { ok: true, publishedVersion: Number(r.published_version) };
    const v = await currentVersion(db, input.tenantId, input.formId);
    if (v === null) return { ok: false, error: "not_found" };
    return { ok: false, error: "conflict", currentVersion: v };
  } catch (err) {
    if (!isMissingOfferTable(err)) throw err;
    noteOfferTableMissing("publish");
    return { ok: false, error: "unavailable" };
  }
}

/** Unpublish: the URL is the plain form again at once. No gate. */
export async function unpublishOffer(
  db: Client,
  input: { tenantId: string; formId: string; now: string },
): Promise<WriteResult<Record<never, never>>> {
  try {
    const rs = await db.execute({
      sql: "UPDATE form_offer_pages SET live = 0, updated_at = ? WHERE tenant_id = ? AND form_id = ?",
      args: [input.now, input.tenantId, input.formId],
    });
    return rs.rowsAffected === 1 ? { ok: true } : { ok: false, error: "not_found" };
  } catch (err) {
    if (!isMissingOfferTable(err)) throw err;
    noteOfferTableMissing("unpublish");
    return { ok: false, error: "unavailable" };
  }
}

/**
 * Delete a form and its offer page in ONE batch, so nothing depends on SQLite
 * enforcing the foreign key. Returns how many forms rows went (0 = not this
 * workspace's form). Before bravo__203 there is no offer row to delete, and the
 * form goes alone exactly as it did.
 */
export async function deleteFormWithOfferPage(db: Client, tenantId: string, formId: string): Promise<number> {
  const deleteForm: InStatement = { sql: "DELETE FROM forms WHERE id = ? AND tenant_id = ?", args: [formId, tenantId] };
  try {
    const out = await db.batch(
      [{ sql: "DELETE FROM form_offer_pages WHERE tenant_id = ? AND form_id = ?", args: [tenantId, formId] }, deleteForm],
      "write",
    );
    return out[1].rowsAffected;
  } catch (err) {
    if (!isMissingOfferTable(err)) throw err;
    noteOfferTableMissing("delete");
    return (await db.execute(deleteForm)).rowsAffected;
  }
}

/**
 * Is this form a support desk's intake? Such a form files tickets for paying
 * clients and never creates a lead, so it is never turned into a sales page:
 * OASIS's own (/f/oasis-ai-cc/support, recognised by tenant and slug, as the
 * submit route does) and every desk registered in support_desks.
 */
export async function isSupportDeskForm(db: Client, tenantId: string, form: { id: string; slug: string }): Promise<boolean> {
  if (tenantId === SUPPORT_FORM_TENANT_ID && form.slug === SUPPORT_FORM_SLUG) return true;
  try {
    const rs = await db.execute({
      sql: "SELECT 1 AS one FROM support_desks WHERE tenant_id = ? AND form_id = ? LIMIT 1",
      args: [tenantId, form.id],
    });
    return rs.rows.length > 0;
  } catch (err) {
    if (/no such table:\s*"?support_desks\b/i.test(err instanceof Error ? err.message : String(err))) return false;
    throw err;
  }
}

/**
 * New leads per form over a window: distinct leads with a first-step
 * submission since `sinceIso`. null when it could not be read (shown as "-",
 * never as 0).
 */
export async function countRecentLeads(
  db: Client,
  tenantId: string,
  formIds: string[],
  sinceIso: string,
): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = Object.fromEntries(formIds.map((id) => [id, 0]));
  if (!formIds.length) return out;
  try {
    const marks = formIds.map(() => "?").join(", ");
    const rs = await db.execute({
      sql: `SELECT form_id, COUNT(DISTINCT lead_id) AS n FROM form_submissions
            WHERE tenant_id = ? AND step_index = 0 AND submitted_at >= ? AND form_id IN (${marks})
            GROUP BY form_id`,
      args: [tenantId, sinceIso, ...formIds],
    });
    for (const r of rowsOf(rs)) out[String(r.form_id)] = Number(r.n ?? 0);
    return out;
  } catch (err) {
    console.error("[offer-pages] recent leads unreadable", { tenantId, error: err instanceof Error ? err.message : String(err) });
    return Object.fromEntries(formIds.map((id) => [id, null]));
  }
}
