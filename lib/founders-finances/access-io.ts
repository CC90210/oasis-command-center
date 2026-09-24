/**
 * Session -> finance viewer, and the entity gate every I/O function calls.
 *
 * resolveFinanceViewer() = founders portal gate (tenant + capability)
 *   AND the session's auth user id is the one behind an owner email in
 *   user_profiles (resolved at runtime, never a hard-coded uuid).
 * requireEntity() = the entity exists AND canAccessEntity() says yes. A
 *   refused entity and a missing one raise the SAME error, so a founder
 *   cannot learn that the other's personal book exists by probing ids.
 */
import "server-only";

import { resolveFounder } from "@/lib/founders/gate";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  FINANCE_OWNER_EMAILS,
  canAccessEntity,
  ownerKeyForUser,
  type FinanceViewer,
  type OwnerKey,
} from "./access";
import { BUSINESS_ENTITY_ID } from "./chart";
import { query, queryOne } from "./db";
import { ensureFinanceSeed } from "./seed-io";

export type FounderViewer = Extract<FinanceViewer, { kind: "founder" }>;

export type EntityRow = {
  id: string;
  slug: string;
  name: string;
  kind: "business" | "personal";
  owner_key: OwnerKey | null;
  base_currency: string;
};

export class FinanceNotFound extends Error {
  constructor(what = "not_found") {
    super(what);
    this.name = "FinanceNotFound";
  }
}

export class FinanceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinanceInputError";
  }
}

/** user_profiles rows for the two owner emails: { email, auth_user_id }. */
export async function loadOwnerProfiles(): Promise<Array<{ email: string | null; auth_user_id: string | null }>> {
  const emails = Object.values(FINANCE_OWNER_EMAILS);
  const r = await getServiceSupabase().from("user_profiles").select("email, auth_user_id").in("email", emails);
  if (r.error) throw new Error(`owner profile lookup failed: ${r.error.message}`);
  return ((r.data || []) as Array<{ email: string | null; auth_user_id: string | null }>).map((row) => ({
    email: row.email,
    auth_user_id: row.auth_user_id,
  }));
}

export async function resolveFinanceViewer(): Promise<FounderViewer | null> {
  const founder = await resolveFounder();
  if (!founder) return null;
  const session = await resolveSessionContext();
  if (!session.ok) return null;
  const owners = await loadOwnerProfiles();
  const ownerKey = ownerKeyForUser(session.userId, owners);
  if (!ownerKey) return null;
  await ensureFinanceSeed();
  return { kind: "founder", ownerKey, email: FINANCE_OWNER_EMAILS[ownerKey], userId: session.userId };
}

const ENTITY_COLS = "id, slug, name, kind, owner_key, base_currency";

export async function visibleEntities(viewer: FinanceViewer): Promise<EntityRow[]> {
  await ensureFinanceSeed();
  const rows = await query<EntityRow>(`SELECT ${ENTITY_COLS} FROM fin_entities ORDER BY kind, name`);
  return rows.filter((e) => canAccessEntity(e, viewer));
}

/** By id or slug. Throws FinanceNotFound for missing AND for forbidden. */
export async function requireEntity(viewer: FinanceViewer, idOrSlug: string | null | undefined): Promise<EntityRow> {
  await ensureFinanceSeed();
  const key = String(idOrSlug || "").trim();
  if (!key) throw new FinanceNotFound();
  const row = await queryOne<EntityRow>(`SELECT ${ENTITY_COLS} FROM fin_entities WHERE id = ? OR slug = ?`, [key, key]);
  if (!row || !canAccessEntity(row, viewer)) throw new FinanceNotFound();
  return row;
}

export async function requireBusinessEntity(viewer: FinanceViewer): Promise<EntityRow> {
  return requireEntity(viewer, BUSINESS_ENTITY_ID);
}

/** Resolve the owning entity of any fin_* row and gate it. */
export async function requireRowEntity(
  viewer: FinanceViewer,
  table: "fin_invoices" | "fin_bills" | "fin_bank_transactions" | "fin_rules" | "fin_contacts" | "fin_attachments" | "fin_recurring_items" | "fin_accounts" | "fin_categories",
  id: string,
): Promise<EntityRow> {
  const row = await queryOne<{ entity_id: string }>(`SELECT entity_id FROM ${table} WHERE id = ?`, [id]);
  if (!row) throw new FinanceNotFound();
  return requireEntity(viewer, row.entity_id);
}

export type AccountRow = {
  id: string;
  entity_id: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  subtype: string;
  currency: string;
  owner_key: string | null;
  archived: number;
};

export async function entityAccounts(entityId: string): Promise<AccountRow[]> {
  return query<AccountRow>(
    `SELECT id, entity_id, code, name, type, subtype, currency, owner_key, archived
       FROM fin_accounts WHERE entity_id = ? ORDER BY code`,
    [entityId],
  );
}

/** The account must belong to the entity. Throws FinanceInputError otherwise. */
export async function requireAccountOf(entityId: string, accountId: string): Promise<AccountRow> {
  const a = await queryOne<AccountRow>(
    `SELECT id, entity_id, code, name, type, subtype, currency, owner_key, archived FROM fin_accounts WHERE id = ? AND entity_id = ?`,
    [accountId, entityId],
  );
  if (!a) throw new FinanceInputError("account does not belong to this book");
  return a;
}

export type CategoryRow = { id: string; entity_id: string; name: string; kind: string; account_id: string; archived: number };

export async function entityCategories(entityId: string): Promise<CategoryRow[]> {
  return query<CategoryRow>(
    `SELECT id, entity_id, name, kind, account_id, archived FROM fin_categories WHERE entity_id = ? AND archived = 0 ORDER BY kind, name`,
    [entityId],
  );
}

export async function requireCategoryOf(entityId: string, categoryId: string): Promise<CategoryRow> {
  const c = await queryOne<CategoryRow>(
    `SELECT id, entity_id, name, kind, account_id, archived FROM fin_categories WHERE id = ? AND entity_id = ?`,
    [categoryId, entityId],
  );
  if (!c) throw new FinanceInputError("category does not belong to this book");
  return c;
}
