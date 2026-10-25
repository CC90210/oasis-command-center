/**
 * lib/ai-audit/catalogue-store.ts — the service catalogue's rows.
 *
 * A price is usable only while its item version is CONFIRMED, and only the
 * workspace owner confirms (the route checks; this module assumes it was).
 * Confirming a version retires the SKU's previously confirmed version in the
 * same batch, so exactly one confirmed price per SKU exists at any moment
 * (bravo__237 ai_service_catalogue_one_confirmed_idx enforces it too).
 */
import "server-only";
import type { Client, Row } from "@libsql/client";
import { newId } from "@/lib/ai-audit/hash";
import {
  CATALOGUE_SEED,
  FIXTURE_CATALOGUE_ITEM,
  confirmBlocker,
  type CatalogueDraft,
  type CatalogueItem,
  type CatalogueSourceRef,
} from "@/lib/ai-audit/catalogue";
import {
  CATALOGUE_CATEGORIES,
  CATALOGUE_STATUSES,
  CATALOGUE_UNITS,
  isOneOf,
} from "@/lib/ai-audit/rules";
import { int, parseObject, requireTenant, text } from "@/lib/ai-audit/store";

const COLUMNS =
  "id, tenant_id, sku, item_version, status, name, description, category, unit, unit_label, price_cents, currency, " +
  "deliverables, onboarding_requirements, source_ref, is_fixture, created_by, created_at, updated_at, confirmed_by, confirmed_at, retired_by, retired_at";

function list(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const p = JSON.parse(v) as unknown;
    return Array.isArray(p) ? p.map((x) => String(x)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function mapCatalogueItem(r: Row): CatalogueItem {
  const status = String(r.status);
  const category = String(r.category);
  const unit = String(r.unit);
  const ref = parseObject(r.source_ref);
  const sourceRef: CatalogueSourceRef = {
    file: typeof ref.file === "string" ? ref.file : "",
    ...(Number.isSafeInteger(ref.line) ? { line: Number(ref.line) } : {}),
    ...(typeof ref.note === "string" && ref.note ? { note: ref.note } : {}),
  };
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    sku: String(r.sku),
    item_version: int(r.item_version, 1),
    status: isOneOf(CATALOGUE_STATUSES, status) ? status : "retired",
    name: String(r.name),
    description: String(r.description ?? ""),
    category: isOneOf(CATALOGUE_CATEGORIES, category) ? category : "implementation",
    unit: isOneOf(CATALOGUE_UNITS, unit) ? unit : "fixed",
    ...(text(r.unit_label) ? { unit_label: String(r.unit_label) } : {}),
    price_cents: r.price_cents === null || r.price_cents === undefined ? null : int(r.price_cents),
    currency: String(r.currency) === "USD" ? "USD" : "CAD",
    deliverables: list(r.deliverables),
    onboarding_requirements: list(r.onboarding_requirements),
    source_ref: sourceRef,
    is_fixture: int(r.is_fixture) === 1,
    created_by: text(r.created_by),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    confirmed_by: text(r.confirmed_by),
    confirmed_at: text(r.confirmed_at),
    retired_by: text(r.retired_by),
    retired_at: text(r.retired_at),
  };
}

export async function listCatalogue(db: Client, tenantId: string, opts: { includeFixture?: boolean } = {}): Promise<CatalogueItem[]> {
  const rs = await db.execute({
    sql: `SELECT ${COLUMNS} FROM ai_service_catalogue_items WHERE tenant_id = ? ${opts.includeFixture ? "" : "AND is_fixture = 0"}
          ORDER BY category, sku, item_version DESC`,
    args: [requireTenant(tenantId)],
  });
  return rs.rows.map(mapCatalogueItem);
}

export async function getCatalogueItem(db: Client, tenantId: string, id: string): Promise<CatalogueItem | null> {
  const rs = await db.execute({
    sql: `SELECT ${COLUMNS} FROM ai_service_catalogue_items WHERE tenant_id = ? AND id = ? LIMIT 1`,
    args: [requireTenant(tenantId), id],
  });
  return rs.rows[0] ? mapCatalogueItem(rs.rows[0]) : null;
}

function insertStatement(tenantId: string, draft: CatalogueDraft, version: number, actorId: string | null, at: string, fixture = false) {
  return {
    sql: `INSERT INTO ai_service_catalogue_items (id, tenant_id, sku, item_version, status, name, description, category, unit, unit_label,
            price_cents, currency, deliverables, onboarding_requirements, source_ref, is_fixture, created_by, created_at, updated_at)
          SELECT ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM ai_service_catalogue_items WHERE tenant_id = ? AND sku = ? AND item_version = ?)`,
    args: [
      newId(), tenantId, draft.sku, version, draft.name, draft.description, draft.category, draft.unit, draft.unit_label ?? null,
      draft.price_cents, draft.currency, JSON.stringify(draft.deliverables), JSON.stringify(draft.onboarding_requirements),
      JSON.stringify(draft.source_ref), fixture ? 1 : 0, actorId, at, at,
      tenantId, draft.sku, version,
    ],
  };
}

/**
 * Seed the catalogue from the files prices lived in. Idempotent: a SKU that
 * already has any version is left alone, so re-running never resurrects an
 * item CC retired or overwrites one CC edited.
 */
export async function seedCatalogue(
  db: Client,
  tenantId: string,
  actorId: string | null,
  now: Date,
  opts: { includeFixture?: boolean } = {},
): Promise<{ inserted: number }> {
  const t = requireTenant(tenantId);
  const at = now.toISOString();
  const existing = new Set(
    (await db.execute({ sql: "SELECT DISTINCT sku FROM ai_service_catalogue_items WHERE tenant_id = ?", args: [t] })).rows.map((r) => String(r.sku)),
  );
  const drafts: Array<{ draft: CatalogueDraft; fixture: boolean }> = CATALOGUE_SEED.filter((d) => !existing.has(d.sku)).map((d) => ({ draft: d, fixture: false }));
  if (opts.includeFixture && !existing.has(FIXTURE_CATALOGUE_ITEM.sku)) drafts.push({ draft: FIXTURE_CATALOGUE_ITEM, fixture: true });
  if (!drafts.length) return { inserted: 0 };
  const results = await db.batch(drafts.map(({ draft, fixture }) => insertStatement(t, draft, 1, actorId, at, fixture)), "write");
  return { inserted: results.reduce((n, r) => n + r.rowsAffected, 0) };
}

/** A new proposed version of a SKU (CC edited the price or the wording). */
export async function proposeCatalogueVersion(
  db: Client,
  tenantId: string,
  draft: CatalogueDraft,
  actorId: string | null,
  now: Date,
): Promise<CatalogueItem> {
  const t = requireTenant(tenantId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const v = int(
      (await db.execute({ sql: "SELECT COALESCE(MAX(item_version), 0) AS v FROM ai_service_catalogue_items WHERE tenant_id = ? AND sku = ?", args: [t, draft.sku] })).rows[0]?.v,
    ) + 1;
    const r = await db.execute(insertStatement(t, draft, v, actorId, now.toISOString()));
    if (r.rowsAffected === 1) {
      const row = (await db.execute({ sql: `SELECT ${COLUMNS} FROM ai_service_catalogue_items WHERE tenant_id = ? AND sku = ? AND item_version = ? LIMIT 1`, args: [t, draft.sku, v] })).rows[0];
      if (row) return mapCatalogueItem(row);
    }
  }
  throw new Error("ai-audit.catalogue: could not allocate a version number");
}

export type ConfirmResult = { ok: true; item: CatalogueItem } | { ok: false; error: string };

/** Confirm one version. The SKU's previous confirmed version retires in the same batch. */
export async function confirmCatalogueItem(db: Client, tenantId: string, itemId: string, ownerId: string, now: Date): Promise<ConfirmResult> {
  const t = requireTenant(tenantId);
  const item = await getCatalogueItem(db, t, itemId);
  if (!item) return { ok: false, error: "not_found" };
  const blocker = confirmBlocker(item);
  if (blocker) return { ok: false, error: blocker };
  const at = now.toISOString();
  const results = await db.batch(
    [
      {
        sql: `UPDATE ai_service_catalogue_items SET status = 'retired', retired_by = ?, retired_at = ?, updated_at = ?
              WHERE tenant_id = ? AND sku = ? AND status = 'confirmed' AND id <> ?`,
        args: [ownerId, at, at, t, item.sku, item.id],
      },
      {
        sql: `UPDATE ai_service_catalogue_items SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ? AND status = 'proposed' AND price_cents IS NOT NULL AND price_cents > 0`,
        args: [ownerId, at, at, t, item.id],
      },
    ],
    "write",
  );
  if (results[1].rowsAffected !== 1) return { ok: false, error: "changed_while_confirming" };
  const after = await getCatalogueItem(db, t, item.id);
  return after ? { ok: true, item: after } : { ok: false, error: "not_found" };
}

export async function retireCatalogueItem(db: Client, tenantId: string, itemId: string, actorId: string, now: Date): Promise<ConfirmResult> {
  const t = requireTenant(tenantId);
  const at = now.toISOString();
  const r = await db.execute({
    sql: `UPDATE ai_service_catalogue_items SET status = 'retired', retired_by = ?, retired_at = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND status <> 'retired'`,
    args: [actorId, at, at, t, itemId],
  });
  const after = await getCatalogueItem(db, t, itemId);
  if (!after) return { ok: false, error: "not_found" };
  return r.rowsAffected === 1 || after.status === "retired" ? { ok: true, item: after } : { ok: false, error: "not_retired" };
}

/** The item a proposal line names, only if that exact version is confirmed now. */
export async function confirmedCatalogueItem(db: Client, tenantId: string, itemId: string): Promise<CatalogueItem | null> {
  const item = await getCatalogueItem(db, tenantId, itemId);
  return item && item.status === "confirmed" && item.price_cents !== null && item.price_cents > 0 ? item : null;
}
