/**
 * lib/forms/routing-destination.ts — turns a matched routing rule (lib/forms/
 * routing.ts) into a REAL, safe-to-navigate-to relative path. Split out from
 * routing.ts on purpose: that module is pure (no I/O) so its parser and
 * evaluator can be unit-tested with plain objects; this one needs the
 * database, so it is the one place `go` is checked against reality.
 *
 * NEVER AN OPEN REDIRECT. The only two things this can ever return are:
 *   - `/f/<tenant_slug>/<form_slug>` for an ENABLED form of the SAME tenant
 *     the router form belongs to (resolvePublicForm resolves tenant_id from
 *     the router's OWN tenant slug, then looks up the destination slug
 *     within that tenant only — a cross-tenant form id is structurally
 *     unreachable, not merely checked for);
 *   - `/go/community?form=<router_slug>&t=<tenant_slug>` (lib/offers/
 *     community-link.ts's own save-basin redirect), and only when that
 *     tenant has a community URL configured.
 * Both are relative paths built from validated, already-known-safe slugs —
 * never a value copied from the request body or from `go` verbatim.
 *
 * A rule that matches but whose `go` fails to resolve (a disabled form,
 * one from another tenant that leaked in somehow, a typo) is SKIPPED, not
 * fatal: resolveRouterDestination keeps walking the rule list, then falls
 * back to the community route, then to null (the form's own ordinary
 * thank-you behavior — no routing at all).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolvePublicForm } from "./public-resolver";
import { communityUrlForTenant } from "@/lib/offers/community-link";
import { COMMUNITY_LINK_GO, ruleMatches, type FormRoutingRule } from "./routing";

function buildFormPath(tenantSlug: string, formSlug: string): string {
  return `/f/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(formSlug)}`;
}

function buildCommunityPath(tenantSlug: string, routerFormSlug: string): string {
  const qs = new URLSearchParams({ form: routerFormSlug, t: tenantSlug });
  return `/go/community?${qs.toString()}`;
}

/**
 * Resolve ONE `go` value to a real destination, or null when it does not
 * resolve to anything this visitor may be sent to.
 */
async function resolveGoDestination(
  db: SupabaseClient,
  input: { tenantId: string; tenantSlug: string; routerFormSlug: string; go: string },
): Promise<string | null> {
  if (input.go === COMMUNITY_LINK_GO) {
    return communityUrlForTenant(input.tenantId) ? buildCommunityPath(input.tenantSlug, input.routerFormSlug) : null;
  }
  const resolved = await resolvePublicForm(db, input.tenantSlug, input.go);
  if (!resolved.ok) return null;
  // Use the DB-resolved slug/tenant_slug, not the raw `go`/input value — closes
  // any gap between "what the rule asked for" and "what actually exists".
  return buildFormPath(resolved.tenant_slug, resolved.form.slug);
}

/**
 * The router form's destination for this submission, or null when nothing
 * routes (no rule matched and no community link is configured — the form's
 * own ordinary thank-you/redirect_url behavior applies unchanged).
 *
 * `answers` is the SAME server-built merged-answers context the submit route
 * already computes for show_if (lib/forms/visibility.ts buildAnswerContext)
 * — never anything read fresh from the request body here.
 */
export async function resolveRouterDestination(
  db: SupabaseClient,
  input: {
    tenantId: string;
    tenantSlug: string;
    routerFormSlug: string;
    rules: readonly FormRoutingRule[];
    answers: Readonly<Record<string, unknown>>;
  },
): Promise<string | null> {
  for (const rule of input.rules) {
    if (!ruleMatches(rule, input.answers)) continue;
    const dest = await resolveGoDestination(db, {
      tenantId: input.tenantId,
      tenantSlug: input.tenantSlug,
      routerFormSlug: input.routerFormSlug,
      go: rule.go,
    });
    if (dest) return dest;
  }
  // Implicit default (HANDOVER section 4's bottom row: "closes the router,
  // or answers not now" -> the free community, tracked): no rule matched, or
  // every matching rule's destination failed to resolve.
  return resolveGoDestination(db, {
    tenantId: input.tenantId,
    tenantSlug: input.tenantSlug,
    routerFormSlug: input.routerFormSlug,
    go: COMMUNITY_LINK_GO,
  });
}
