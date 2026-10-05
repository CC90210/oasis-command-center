/**
 * Shared helpers for Supabase Storage routes. Sanitization in particular
 * must be identical across uploaders — every storage path lives under
 * <tenant_id>/... so a sloppy filename could escape the tenant folder.
 */

/**
 * Strip directory-traversal, collapse whitespace, drop characters that
 * have no business in a storage object name. Returns a non-empty string
 * (falls back to a timestamped placeholder when the input sanitizes to
 * nothing).
 */
export function sanitizeStorageFilename(name: string): string {
  return (
    name
      .replace(/[/\\]/g, "_")
      .replace(/\.\.+/g, "_")
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9._-]/g, "")
      .slice(0, 120) || `file_${Date.now()}`
  );
}

/**
 * Assert a stored path really sits under the tenant that claims it.
 *
 * The invariant in this file's header ("every storage path lives under
 * <tenant_id>/...") was, until 2026-08-26, only ever enforced at WRITE time by
 * the uploaders constructing the path themselves. That is fine while the only
 * way to reach an object is to build its path — and stops being fine the moment
 * something reads a path back out of a database row and signs a URL for it
 * (/api/internal/extraction-doc-url). A row is not a promise: a bad migration,
 * a future bug, or a tampered write could carry a path pointing anywhere, and
 * the signer would faithfully mint a working URL to another tenant's merchant
 * bank statements.
 *
 * So the read side re-asserts it. Rejects an empty tenant or path, a path that
 * merely starts with the tenant string without the separator (a prefix collision
 * across tenants), and any traversal segment that could climb back out.
 */
export function pathBelongsToTenant(tenantId: string, storagePath: string): boolean {
  const t = String(tenantId || "").trim();
  const p = String(storagePath || "").trim();
  if (!t || !p) return false;
  if (p.includes("..")) return false;
  if (p.startsWith("/")) return false;
  return p.startsWith(`${t}/`) && p.length > t.length + 1;
}
