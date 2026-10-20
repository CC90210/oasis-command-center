/**
 * lib/email/suppression-scope.ts: the one opt-out check every OCC sender makes.
 *
 * A workspace's sender honours its own opt-outs and the global ones (tenant_id
 * NULL). /api/unsubscribe files an opt-out globally unless its link's brand is
 * pinned to one workspace (pinnedSuppressionTenant), and BEA files reply-STOP
 * opt-outs globally (casl_compliance.add_suppression). Before (2026-10-19
 * audit) every OCC send path read the workspace's own rows only, so a global
 * opt-out stopped no one, and four send paths each carried their own copy of
 * the lookup. tests/unsubscribe-records-every-opt-out.test.ts fails if a new
 * sender reads email_suppressions without coming through here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A workspace's own rows plus the global ones, as a PostgREST .or()
 * expression. The id is checked and quoted because it is pasted into the
 * expression: unquoted, an all-digit id would be read as a number
 * (lib/turso-postgrest.ts grammarLiteral).
 */
export function suppressionScope(tenantId: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(tenantId)) throw new Error("suppressionScope: not a tenant id");
  return `tenant_id.eq."${tenantId}",tenant_id.is.null`;
}

export type SuppressionCheck = { suppressed: boolean; checkFailed: boolean; error?: string };

/**
 * Has this address opted out of this workspace's mail, or everyone's?
 *
 * - No address: nothing to send to, so not suppressed.
 * - No workspace: the global rows only. (checkEmailSuppressed used to answer
 *   "not suppressed" here without reading anything.)
 * - A lookup that errors or throws is checkFailed, and every caller treats
 *   that as "do not send" (fail closed).
 *
 * The address is matched case-insensitively and literally: "_", "%" and "\"
 * are escaped, because "_" and "%" are valid in an address. The Turso adapter
 * also reads "*" as a wildcard and has no escape for it, so an address with a
 * "*" also matches addresses that differ only there. That can only
 * over-suppress.
 */
export async function checkSuppression(
  db: Pick<SupabaseClient, "from">,
  tenantId: string | null | undefined,
  email: string | null | undefined,
): Promise<SuppressionCheck> {
  const addr = String(email ?? "").trim().toLowerCase();
  if (!addr) return { suppressed: false, checkFailed: false };
  try {
    const lookup = db.from("email_suppressions").select("email").ilike("email", addr.replace(/[%_\\]/g, "\\$&"));
    const scoped = tenantId ? lookup.or(suppressionScope(tenantId)) : lookup.is("tenant_id", null);
    const { data, error } = await scoped.limit(1);
    if (error) return { suppressed: false, checkFailed: true, error: error.message };
    return { suppressed: (data?.length ?? 0) > 0, checkFailed: false };
  } catch (err) {
    return { suppressed: false, checkFailed: true, error: err instanceof Error ? err.message : String(err) };
  }
}
