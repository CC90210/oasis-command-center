/**
 * lib/email/suppression-scope.ts: which opt-out rows a workspace's sender must
 * honour. Its own, and the global ones (tenant_id NULL).
 *
 * /api/unsubscribe files an opt-out globally when its link's brand names no
 * single workspace (an unknown brand, or a name several workspaces share). That
 * person opted out of mail they could not tie to one sender, so every sender
 * stops. Before (2026-10-19 audit) every OCC send path read the workspace's own
 * rows only, so a global opt-out stopped no one.
 *
 * Returned as a PostgREST .or() expression for `email_suppressions`. The id is
 * checked first because it is pasted into the expression.
 */
export function suppressionScope(tenantId: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(tenantId)) throw new Error("suppressionScope: not a tenant id");
  return `tenant_id.eq.${tenantId},tenant_id.is.null`;
}
