"use client";

/**
 * WebLeadDetail — right-side panel, following the existing LeadDetailDrawer
 * convention reps already know: URL-driven (`?lead=<id>`) by the page that
 * mounts it, one aggregated fetch, presentational body.
 *
 * Also carries the three a11y affordances LeadDetailDrawer
 * (components/leads/LeadDetailDrawer.tsx) already fixed for this exact
 * pattern (Codex pass-2 finding): Esc to close, body scroll lock, and focus
 * on the close button on mount. Skipping them here would reintroduce the
 * same keyboard-trap/scroll-bleed bug in a second drawer.
 *
 * Built as a section list so enrichment fields drop in later without a
 * redesign. Today these leads carry directory data only.
 */

import { useEffect, useRef, useState } from "react";
import { X, Phone, MapPin, Globe, Tag, ExternalLink } from "lucide-react";
import type { WebLead } from "@/lib/web-leads/data";
import { safeExternalUrl } from "@/lib/web-leads/url-safety";
import { WebsiteComparison } from "./WebsiteComparison";
import { CallOutcomeLog } from "./CallOutcomeLog";

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | null }) {
  return (
    <div className="flex gap-3 py-2">
      <div className="mt-0.5 text-slate-400">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
        <p className="break-words text-sm text-slate-900">{value || "—"}</p>
      </div>
    </div>
  );
}

export function WebLeadDetail({ leadId, onClose }: { leadId: string; onClose: () => void }) {
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
      <div className="fixed inset-0 z-40 bg-slate-900/20" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label="Lead detail" className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-slate-200 bg-white shadow-xl">
        <header className="sticky top-0 flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-slate-900">{lead?.name || (error ? "Unavailable" : "Loading…")}</h2>
            {lead?.territoryName && <p className="truncate text-xs text-slate-500">{lead.territoryName}</p>}
          </div>
          <button ref={closeBtnRef} type="button" onClick={onClose} aria-label="Close lead detail" className="rounded p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="px-5 py-4">
          {error && <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{error}</p>}
          {lead && (
            <>
              {lead.phone && (
                <a href={`tel:${lead.phone}`} className="mb-4 flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                  <Phone className="h-4 w-4" />Call {lead.phone}
                </a>
              )}
              {/* safeExternalUrl adds a scheme to bare domains (217 of our
                  stored websites have none -- a bare string in an href is
                  app-relative and would navigate inside our own dashboard)
                  and allowlists http/https (these values come from OSM,
                  which anyone can edit, and a javascript: href would run in
                  our origin). Render nothing rather than a dead or
                  dangerous link when it returns null. */}
              {(() => {
                const websiteHref = safeExternalUrl(lead.websiteUrl);
                return websiteHref && (
                  // rel="noopener noreferrer" is required: without it the
                  // opened page can reach back through window.opener, and
                  // these are 27,000 sites we do not control.
                  <a
                    href={websiteHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mb-4 flex w-full items-center justify-center gap-2 rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <ExternalLink className="h-4 w-4" />View website
                  </a>
                );
              })()}
              <div className="divide-y divide-slate-100">
                <Row icon={<MapPin className="h-4 w-4" />} label="Address" value={[lead.address, lead.city, lead.province, lead.postal].filter(Boolean).join(", ") || null} />
                <Row icon={<Tag className="h-4 w-4" />} label="Industry" value={lead.industry} />
                <Row icon={<Globe className="h-4 w-4" />} label="Website" value={lead.websiteUrl} />
                {/* VERBATIM — see spec section 2. */}
                <Row icon={<Globe className="h-4 w-4" />} label="Website status" value={lead.websiteCondition} />
                <Row icon={<Tag className="h-4 w-4" />} label="Research notes" value={lead.auditFindings} />
                <Row icon={<Tag className="h-4 w-4" />} label="Directory category" value={lead.osmCategory} />
              </div>
              <WebsiteComparison leadId={leadId} />
              <CallOutcomeLog leadId={leadId} />
            </>
          )}
        </div>
      </aside>
    </>
  );
}
