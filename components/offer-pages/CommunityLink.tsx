"use client";

/**
 * CommunityLink — the persistent, quiet "Not ready? Join the free
 * community" link every offer page carries (HANDOVER 2026-10-12 section 4
 * and section 1.3's "save basin"). Renders to `/go/community?form=<slug>&t=
 * <tenant slug>&v=<visit id>` — the ONE place that route is linked to from
 * (lib/offers/community-link.ts decides the real destination server-side;
 * this component never guesses it).
 *
 * RENDERS NOTHING when `configured` is false (no community URL set up for
 * this tenant) or when `tenantSlug`/`formSlug` are null (the owner's
 * unpublished-page preview — same rule OfferPage already follows for
 * funnel tracking, so a preview never fires a real community_click either).
 * A workspace with no community link must never be told it has one.
 *
 * `v=<visit id>` is read client-side from sessionStorage (peekVisitId) —
 * never minted here. The server handling /go/community has no access to
 * sessionStorage, so passing it in the query is how that route's own
 * community_click event links back to this visit.
 *
 * Plain `<a>`: keyboard-operable and screen-reader-visible by default, no
 * custom role or JS handler needed.
 */
import { peekVisitId } from "@/lib/offers/tracking-client";

export function CommunityLink({
  tenantSlug,
  formSlug,
  configured,
  className = "",
}: {
  tenantSlug: string | null;
  formSlug: string | null;
  /** Server-resolved: lib/offers/community-link.ts has a URL for this tenant. */
  configured: boolean;
  className?: string;
}) {
  if (!configured || !tenantSlug || !formSlug) return null;

  const params = new URLSearchParams({ form: formSlug, t: tenantSlug });
  const visitId = peekVisitId();
  if (visitId) params.set("v", visitId);

  return (
    <a
      href={`/go/community?${params.toString()}`}
      className={`text-[14px] text-fg-dim underline underline-offset-4 transition-colors hover:text-fg ${className}`}
    >
      Not ready? Join the free community
    </a>
  );
}
