/**
 * Who may see which book. PURE — the one predicate every read and write in
 * lib/founders-finances goes through (via access-io.ts requireEntity).
 *
 *   OASIS AI Solutions (business)  -> CC and Adon, Atlas (internal API),
 *                                     the Stripe webhook / reconcile
 *   CC personal                    -> CC only
 *   Adon personal                  -> Adon only
 *
 * The founders portal gate (lib/founders/gate.ts) admits the marketing hire
 * and builders too, because their job is the marketing studio. That is NOT
 * enough for money: Finances additionally requires the caller's auth user id
 * to be the one behind conaugh@oasisai.work or adon@oasisai.work, resolved at
 * runtime from user_profiles.auth_user_id — never a hard-coded uuid.
 *
 * Machine callers (Atlas, Stripe) reach the BUSINESS book only. A personal
 * book is never readable by an automation, including the CFO agent.
 */

export type OwnerKey = "cc" | "adon";

export const FINANCE_OWNER_EMAILS: Readonly<Record<OwnerKey, string>> = {
  cc: "conaugh@oasisai.work",
  adon: "adon@oasisai.work",
};

export const OWNER_LABEL: Readonly<Record<OwnerKey, string>> = { cc: "CC", adon: "Adon" };

export type FinanceViewer =
  | { kind: "founder"; ownerKey: OwnerKey; email: string; userId: string }
  | { kind: "agent"; name: "atlas" }
  | { kind: "system"; name: "stripe" | "reconcile" };

export type EntityAccessShape = { kind: "business" | "personal"; owner_key: string | null };

export function ownerKeyForEmail(email: string | null | undefined): OwnerKey | null {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  for (const key of Object.keys(FINANCE_OWNER_EMAILS) as OwnerKey[]) {
    if (FINANCE_OWNER_EMAILS[key] === e) return key;
  }
  return null;
}

/** Cosmetic check for the sidebar row. The page gate below is the wall. */
export function isFinanceOwnerEmail(email: string | null | undefined): boolean {
  return ownerKeyForEmail(email) !== null;
}

/**
 * Resolve the caller from their AUTH user id against the owner profile rows
 * (user_profiles where email is an owner email). A profile email alone is not
 * trusted: the auth user id is what the session cryptographically proves.
 * Two owners claiming the same auth id (a data error) resolves to nobody.
 */
export function ownerKeyForUser(
  userId: string | null | undefined,
  ownerRows: ReadonlyArray<{ email: string | null; auth_user_id: string | null }>,
): OwnerKey | null {
  const uid = String(userId || "").trim();
  if (!uid) return null;
  const hits = new Set<OwnerKey>();
  for (const row of ownerRows) {
    const key = ownerKeyForEmail(row.email);
    if (key && row.auth_user_id && row.auth_user_id.trim() === uid) hits.add(key);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

export function canAccessEntity(entity: EntityAccessShape, viewer: FinanceViewer | null): boolean {
  if (!viewer) return false;
  if (entity.kind === "business") return entity.owner_key === null;
  if (entity.kind !== "personal") return false;
  if (viewer.kind !== "founder") return false;
  return entity.owner_key === viewer.ownerKey;
}

/** Stamped into created_by / audit rows. */
export function viewerLabel(viewer: FinanceViewer): string {
  if (viewer.kind === "founder") return viewer.email;
  return viewer.name;
}
