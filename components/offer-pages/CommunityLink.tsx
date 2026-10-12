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
 * `v=<visit id>` comes from sessionStorage at click time
 * (getOrCreateVisitId, the same id the page's own events use). The server handling /go/community has no access to
 * sessionStorage, so passing it in the query is how that route's own
 * community_click event links back to this visit.
 *
 * Plain `<a>`: keyboard-operable and screen-reader-visible by default, no
 * custom role or JS handler needed.
 */
import { useEffect, useState, type MouseEvent } from "react";
import { getOrCreateVisitId } from "@/lib/offers/tracking-client";

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
  // Three constraints, all from review:
  //  1. The first client render must match the server's href (CodeRabbit:
  //     React does not promise to patch a mismatched href), so it renders
  //     without `v`.
  //  2. After hydration the href must carry `v`, so a middle-click or "open
  //     in new tab" (which bypass onClick) is still attributed (Codex).
  //  3. Reading the id on mount must not race the tracking effect that
  //     creates it on a fresh tab (Codex): getOrCreateVisitId creates it if
  //     absent, and the page's own events reuse that same sessionStorage id.
  // The click handler refreshes it once more for the ordinary-click case.
  const [visitId, setVisitId] = useState<string | null>(null);
  useEffect(() => {
    setVisitId(getOrCreateVisitId());
  }, []);

  if (!configured || !tenantSlug || !formSlug) return null;

  const base = new URLSearchParams({ form: formSlug, t: tenantSlug });
  const hrefFor = (id: string | null) => {
    const params = new URLSearchParams(base);
    if (id) params.set("v", id);
    return `/go/community?${params.toString()}`;
  };
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    const id = getOrCreateVisitId();
    if (id) e.currentTarget.href = hrefFor(id);
  };

  return (
    <a
      href={hrefFor(visitId)}
      onClick={onClick}
      className={`text-[14px] text-fg-dim underline underline-offset-4 transition-colors hover:text-fg ${className}`}
    >
      Not ready? Join the free community
    </a>
  );
}
