/**
 * The short public address of each OASIS offer page (CC, 2026-10-16: "They
 * should have individual links - each one sends to a different landing page.
 * This should be our link where we copy the link").
 *
 *   oasisai.work/protocol   -> /f/oasis-ai-cc/protocol
 *   oasisai.work/command    -> /f/oasis-ai-cc/command
 *   oasisai.work/community  -> /f/oasis-ai-cc/community
 *   oasisai.work/fleet-audit -> /f/oasis-ai-cc/fleet   (/fleet is the marketing page)
 *   oasisai.work/ai-audit   -> /f/oasis-ai-cc/ai-audit (an existing redirect)
 *   oasisai.work/vsl        -> the "Start here" router (app/vsl/route.ts)
 *
 * next.config.js redirects() carries the same list, because a JS config file
 * cannot import this TypeScript module; tests/offer-short-links.test.ts fails
 * if the two disagree. The redirects run before middleware, so no public-path
 * entry is needed, and Next keeps the query string, so utm_* and ?rep= reach
 * the page.
 *
 * Every other workspace keeps its /f/<workspace>/<offer> address.
 */
import { AI_AUDIT_TENANT_SLUG } from "@/lib/forms/oasis-ai-audit-seed";

export const OASIS_OFFER_SHORT_PATHS: Readonly<Record<string, string>> = {
  vsl: "/vsl",
  "ai-audit": "/ai-audit",
  protocol: "/protocol",
  command: "/command",
  community: "/community",
  fleet: "/fleet-audit",
};

/** The address to hand out for an offer: its short link when it has one, else /f/<workspace>/<offer>. */
export function offerShareablePath(tenantSlug: string | null, formSlug: string): string | null {
  if (!tenantSlug) return null;
  // Own keys only: a valid slug such as "constructor" must not pick up an
  // inherited Object member as its "path" (Codex review of #630).
  if (tenantSlug === AI_AUDIT_TENANT_SLUG && Object.prototype.hasOwnProperty.call(OASIS_OFFER_SHORT_PATHS, formSlug)) {
    return OASIS_OFFER_SHORT_PATHS[formSlug];
  }
  return `/f/${tenantSlug}/${formSlug}`;
}
