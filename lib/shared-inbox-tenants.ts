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

// 2026-07: emptied. SunBiz ("submissions") was here so the dashboard hid the
// per-user Connect Gmail panel (per-user OAuth had no effect while every send
// went through the shared submissions@ identity). That's no longer true: the
// operator-Gmail send path (lib/integrations/gmail-oauth-send.sendGmailAsOperator)
// sends DIRECTLY from each operator's connected Gmail, and the Operator Email
// Agent monitors each operator's inbox. So every employee must be able to
// connect + manage their own Gmail. Backward-compatible: an operator who does
// NOT connect still falls back to the shared submissions@ sender.
export const SHARED_INBOX_SLUGS: ReadonlySet<string> = new Set<string>([]);

export function isSharedInboxTenant(slug: string | null | undefined): boolean {
  return !!slug && SHARED_INBOX_SLUGS.has(slug);
}
