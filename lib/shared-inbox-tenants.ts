/**
 * shared-inbox-tenants.ts — canonical list of tenants that enforce a
 * shared outbound email identity (every send goes from the tenant-level
 * Gmail/SMTP, no per-user OAuth) and the per-deal-assigned-rep CC pattern.
 *
 * Mirrors `_SHARED_INBOX_SLUGS` in CEO-Agent's user_gmail_oauth.py. The
 * Python side is consulted at send time by send_gateway; the TypeScript
 * side gates dashboard UX (hides Connect Gmail panel + Personal Gmail
 * readiness item for these tenants, since under the shared model both
 * would mislead the operator).
 *
 * Promote to `tenants.config` JSONB column when a third tenant adopts
 * the model — at that point the two-line hardcoded set across two
 * languages stops being the right shape.
 */

export const SHARED_INBOX_SLUGS: ReadonlySet<string> = new Set(["submissions"]);

export function isSharedInboxTenant(slug: string | null | undefined): boolean {
  return !!slug && SHARED_INBOX_SLUGS.has(slug);
}
