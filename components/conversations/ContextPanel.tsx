"use client";

/**
 * ContextPanel — plan §5 (Phase 1: deal-details only). Fetches
 * /api/leads/[id]/detail on thread select, caches per lead_id, and renders:
 * AISummaryCard + KeyPointsAccordion (P2 placeholders) + DealDetailsAccordion
 * (built) + AISuggestionRail (P2 placeholder) + LeadFileBody inline (the
 * full re-hosted lead file — its own Activity/Notes/Docs tabs cover the
 * plan's "SubTabs Activity/Notes/Files" requirement, see handoff notes for
 * why LeadFileBody's full 7-tab nav was kept rather than cut down to 3).
 *
 * Accordion-open state + panel-open state persist to localStorage, read in
 * a useEffect (not during render) to avoid an SSR/client hydration mismatch.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ConversationThread } from "@/lib/conversation-threading";
import { EmptyState } from "@/components/Card";
import { LeadFileBody, type DetailPayload } from "@/components/leads/LeadFileBody";
import { AISummaryCard } from "./AISummaryCard";
import { KeyPointsAccordion } from "./KeyPointsAccordion";
import { AISuggestionRail } from "./AISuggestionRail";
import { DealDetailsAccordion } from "./DealDetailsAccordion";

const ACCORDION_STORAGE_KEY = "oasis:conversations:contextPanelAccordions";

type AccordionState = { dealDetails: boolean };
const DEFAULT_ACCORDIONS: AccordionState = { dealDetails: true };

export function ContextPanel({
  thread,
  tenantSlug,
  open,
  onClose,
  onDealSummary,
}: {
  thread: ConversationThread;
  tenantSlug: string;
  open: boolean;
  onClose: () => void;
  onDealSummary?: (leadId: string, summary: { business_name?: string; funding_amount?: string }) => void;
}) {
  const cacheRef = useRef<Map<string, DetailPayload | "error">>(new Map());
  const [payload, setPayload] = useState<DetailPayload | "error" | null>(null);
  const [accordions, setAccordions] = useState<AccordionState>(DEFAULT_ACCORDIONS);
  const [hydrated, setHydrated] = useState(false);

  // Read persisted accordion state once on mount (client-only — avoids the
  // SSR/hydration mismatch a synchronous localStorage read during render
  // would cause).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(ACCORDION_STORAGE_KEY);
      if (raw) setAccordions({ ...DEFAULT_ACCORDIONS, ...JSON.parse(raw) });
    } catch {
      /* corrupt/unavailable storage — fall back to defaults */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(ACCORDION_STORAGE_KEY, JSON.stringify(accordions));
    } catch {
      /* best-effort persistence only */
    }
  }, [accordions, hydrated]);

  const leadId = thread.lead_id;

  const reload = useCallback(async () => {
    if (!leadId) return;
    try {
      const r = await fetch(`/api/leads/${leadId}/detail`, { credentials: "include", cache: "no-store" });
      const j = await r.json();
      if (!j.ok) {
        cacheRef.current.set(leadId, "error");
        setPayload("error");
        return;
      }
      cacheRef.current.set(leadId, j as DetailPayload);
      setPayload(j as DetailPayload);
      const data = (j as DetailPayload).record.data;
      if (onDealSummary) {
        const businessName = typeof data.business_name === "string" ? data.business_name : undefined;
        const funding =
          data.requested_amount != null ? String(data.requested_amount) : undefined;
        onDealSummary(leadId, { business_name: businessName, funding_amount: funding });
      }
    } catch {
      cacheRef.current.set(leadId, "error");
      setPayload("error");
    }
  }, [leadId, onDealSummary]);

  useEffect(() => {
    if (!leadId) {
      setPayload(null);
      return;
    }
    const cached = cacheRef.current.get(leadId);
    if (cached) {
      setPayload(cached);
      return;
    }
    setPayload(null); // loading state for this leadId
    void reload();
  }, [leadId, reload]);

  if (!open) return null;

  return (
    <div className="h-full min-h-0 flex flex-col border-l border-bg-border bg-bg-panel">
      <div className="shrink-0 flex items-center justify-between px-3.5 py-2.5 border-b border-bg-border lg:hidden">
        <span className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">Deal file</span>
        <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded-md text-fg-dim hover:text-fg hover:bg-bg-elev">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        <AISummaryCard />
        <KeyPointsAccordion />

        {!leadId ? (
          <EmptyState message="No lead linked to this thread yet — deal details will appear once one is." />
        ) : payload === "error" ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-3 text-[12px] text-red-200">
            Couldn&apos;t load this lead&apos;s file.
          </div>
        ) : payload === null ? (
          <ContextPanelSkeleton />
        ) : (
          <>
            <DealDetailsAccordion
              record={payload.record.data}
              documents={payload.documents}
              application={payload.application}
              open={accordions.dealDetails}
              onToggle={() => setAccordions((a) => ({ ...a, dealDetails: !a.dealDetails }))}
            />
            <AISuggestionRail />
            <div className="rounded-lg border border-bg-border bg-bg-elev/20">
              <LeadFileBody
                tenantSlug={tenantSlug}
                leadId={leadId}
                entity={payload.record.entity}
                record={payload.record.data}
                documents={payload.documents}
                application={payload.application}
                onReload={reload}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ContextPanelSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-24 rounded-lg bg-bg-elev/50" />
      <div className="h-40 rounded-lg bg-bg-elev/40" />
    </div>
  );
}
