"use client";

/**
 * WebLeadDetail — right-side panel, following the existing LeadDetailDrawer
 * convention reps already know: URL-driven (`?lead=<id>`) by the page that
 * mounts it, one aggregated fetch, presentational body. Restyled onto the
 * app's dark tokens (2026-08-23 revamp) -- chrome now matches
 * components/leads/LeadDetailDrawer.tsx exactly (bg-bg-elev aside,
 * border-bg-border seams, black/60 backdrop) so this panel and the CRM's
 * own drawer are indistinguishable in feel.
 *
 * Also carries the three a11y affordances LeadDetailDrawer
 * (components/leads/LeadDetailDrawer.tsx) already fixed for this exact
 * pattern (Codex pass-2 finding): Esc to close, body scroll lock, and focus
 * on the close button on mount. Skipping them here would reintroduce the
 * same keyboard-trap/scroll-bleed bug in a second drawer.
 *
 * THE SCORE IS THE HERO (2026-08-23 revamp): WebsiteComparison (the score +
 * biggest-gaps list -- what a rep actually reads mid-call) now renders
 * directly under the call/website actions, ahead of the address/industry/
 * category metadata below it. That ordering, plus its own larger type
 * scale, is what makes it dominant -- nothing here is hidden behind a
 * click, because a rep mid-call should never have to go hunting for the
 * one honest sentence this system owes them.
 *
 * Built as a section list so enrichment fields drop in later without a
 * redesign. Today these leads carry directory data only.
 */

import { useEffect, useRef, useState } from "react";
import { X, Phone, ExternalLink } from "lucide-react";
import type { WebLead } from "@/lib/web-leads/data";
import { preferredSiteUrl } from "@/lib/web-leads/url-safety";
import { BusinessFacts } from "./BusinessFacts";
import { WebsiteComparison } from "./WebsiteComparison";
import { CallOutcomeLog } from "./CallOutcomeLog";

function HeaderSkeleton() {
  return (
    <div className="space-y-2">
      <div className="h-4 w-40 rounded bg-bg-deep animate-pulse-slow" />
      <div className="h-3 w-24 rounded bg-bg-deep/70 animate-pulse-slow" />
    </div>
  );
}

export function WebLeadDetail({
  leadId,
  onClose,
  canMutate,
}: {
  leadId: string;
  onClose: () => void;
  canMutate: boolean;
}) {
  const [lead, setLead] = useState<WebLead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    setLead(null);
    setError(null);
    // `alive` is re-checked AFTER the body is parsed, right before every
    // setState -- not once at the top of the callback. A check before
    // `await r.json()` only covers the header round-trip: click lead A, then
    // lead B while A's body is still streaming, and A's late body would land
    // after B's (smaller/faster) body and overwrite it, showing B's URL next
    // to A's name and A's `tel:` number. Same invariant WebLeadsBrowser.tsx
    // uses for its fetches.
    fetch(`/api/web-leads/${encodeURIComponent(leadId)}`)
      .then(async (r) => {
        if (r.status === 404) {
          if (alive) setError("This lead no longer exists.");
          return;
        }
        if (!r.ok) {
          if (alive) setError("Could not load this lead.");
          return;
        }
        const body = await r.json();
        if (alive) setLead(body);
      })
      .catch(() => { if (alive) setError("Could not load this lead."); });
    return () => { alive = false; };
  }, [leadId]);

  // Esc to close + body scroll lock + focus the close button on mount,
  // matching LeadDetailDrawer: without these, a drawer traps keyboard users
  // and leaves the page scrolling behind the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtnRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Lead detail"
        className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col overflow-y-auto overscroll-contain border-l border-bg-border bg-bg-elev shadow-[-12px_0_32px_-8px_rgba(0,0,0,0.6)]"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-bg-border bg-bg-elev px-5 py-4">
          <div className="min-w-0 flex-1">
            {!lead && !error ? (
              <HeaderSkeleton />
            ) : (
              <>
                <h2 className="truncate text-lg font-bold leading-tight text-fg">
                  {lead?.name || (error ? "Unavailable" : "")}
                </h2>
                {lead?.territoryName && <p className="mt-1 truncate text-xs text-fg-dim">{lead.territoryName}</p>}
              </>
            )}
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close lead detail"
            className="rounded-md p-1 text-fg-muted transition-colors hover:bg-bg-deep hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="px-5 py-4">
          {error && <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">{error}</p>}
          {lead && (
            <>
              <div className="flex flex-col gap-2 sm:flex-row">
                {lead.phone && canMutate ? (
                  <a
                    href={`tel:${lead.phone}`}
                    className="flex flex-1 items-center justify-center gap-2 rounded-md bg-gradient-to-br from-accent to-accent-muted px-4 py-2.5 text-sm font-bold text-white shadow-[0_0_0_1px_rgba(59,130,246,0.18),0_8px_20px_-8px_rgba(59,130,246,0.4)] transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    <Phone className="h-4 w-4" />Call {lead.phone}
                  </a>
                ) : lead.phone ? (
                  <p className="flex flex-1 items-center justify-center rounded-md border border-bg-border px-4 py-2.5 text-sm tabular-nums text-fg-muted">
                    {lead.phone}
                  </p>
                ) : null}
                {/* safeExternalUrl adds a scheme to bare domains (217 of our
                    stored websites have none -- a bare string in an href is
                    app-relative and would navigate inside our own dashboard)
                    and allowlists http/https (these values come from OSM,
                    which anyone can edit, and a javascript: href would run in
                    our origin). Render nothing rather than a dead or
                    dangerous link when it returns null. */}
                {(() => {
                  const websiteHref = preferredSiteUrl(lead.websiteUrl);
                  return websiteHref && (
                    // rel="noopener noreferrer" is required: without it the
                    // opened page can reach back through window.opener, and
                    // these are 27,000 sites we do not control.
                    <a
                      href={websiteHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex flex-1 items-center justify-center gap-2 rounded-md border border-bg-border bg-bg-panel px-4 py-2.5 text-sm font-semibold text-fg transition-colors hover:border-accent/40 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    >
                      <ExternalLink className="h-4 w-4" />View website
                    </a>
                  );
                })()}
              </div>

              {/* HERO. See module header. */}
              <WebsiteComparison leadId={leadId} />

              {/* The SAME component the battle card renders, not a second copy
                  of these rows. The page shipped on 2026-08-24 without any of
                  them, which is the bug this extraction closes; leaving two
                  hand-maintained lists would let the two surfaces drift again,
                  and two screens disagreeing about one business's address
                  while a rep is on the phone is the failure mode worth paying
                  a shared component for. It carries the verbatim
                  websiteCondition/auditFindings rules with it. */}
              <div className="mt-5">
                <BusinessFacts lead={lead} layout="stack" />
              </div>

              <CallOutcomeLog leadId={leadId} canMutate={canMutate} />
            </>
          )}
        </div>
      </aside>
    </>
  );
}
