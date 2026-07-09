"use client";

/**
 * ContextPanel — plan §5/§6. Fetches /api/leads/[id]/detail on thread
 * select (deal details, Phase 1) and /api/conversations/summarize on thread
 * select + explicit regenerate (AI summary + key points, Phase 2), each
 * cached client-side so switching threads back and forth doesn't re-hit the
 * API. Renders: AISummaryCard + KeyPointsAccordion (click-to-source via the
 * MessageList registry) + DealDetailsAccordion + AISuggestionRail
 * (chips derived from lead state + key points) + LeadFileBody inline.
 *
 * Accordion-open state + panel-open state persist to localStorage, read in
 * a useEffect (not during render) to avoid an SSR/client hydration mismatch.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ConversationThread } from "@/lib/conversation-threading";
import type { KeyPoint } from "@/lib/ai-conversation-summarize";
import { EmptyState } from "@/components/Card";
import { LeadFileBody, type DetailPayload } from "@/components/leads/LeadFileBody";
import { AISummaryCard } from "./AISummaryCard";
import { KeyPointsAccordion } from "./KeyPointsAccordion";
import { AISuggestionRail, deriveSuggestionChips } from "./AISuggestionRail";
import { DealDetailsAccordion, computeMissingStips } from "./DealDetailsAccordion";
import { scrollToMessage, type MessageRegistry } from "./MessageList";
import { CallSchedulerModal } from "./CallSchedulerModal";

const ACCORDION_STORAGE_KEY = "oasis:conversations:contextPanelAccordions";

type AccordionState = { dealDetails: boolean; keyPoints: boolean };
const DEFAULT_ACCORDIONS: AccordionState = { dealDetails: true, keyPoints: true };

type SummaryState = { summary: string | null; keyPoints: KeyPoint[]; loading: boolean; error: string | null };
const SUMMARY_IDLE: SummaryState = { summary: null, keyPoints: [], loading: false, error: null };

export function ContextPanel({
  thread,
  tenantSlug,
  open,
  onClose,
  onDealSummary,
  registryRef,
  templateVars,
  onComposerAction,
}: {
  thread: ConversationThread;
  tenantSlug: string;
  open: boolean;
  onClose: () => void;
  onDealSummary?: (leadId: string, summary: { business_name?: string; funding_amount?: string }) => void;
  registryRef?: MessageRegistry;
  templateVars?: Record<string, string | undefined>;
  onComposerAction?: (text: string) => void;
}) {
  const cacheRef = useRef<Map<string, DetailPayload | "error">>(new Map());
  const [payload, setPayload] = useState<DetailPayload | "error" | null>(null);
  const [accordions, setAccordions] = useState<AccordionState>(DEFAULT_ACCORDIONS);
  const [hydrated, setHydrated] = useState(false);

  const summaryCacheRef = useRef<Map<string, SummaryState>>(new Map());
  const [summaryState, setSummaryState] = useState<SummaryState>(SUMMARY_IDLE);
  const [schedulerOpen, setSchedulerOpen] = useState(false);

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

  // AI summary + key points — cache key is thread.key + thread.last_at so a
  // new inbound/outbound message (which bumps last_at) invalidates the
  // cached summary automatically, and switching back to an unchanged thread
  // is instant (plan §5: "cache keyed on thread.key + last_at + explicit
  // regenerate").
  const summaryCacheKey = `${thread.key}:${thread.last_at}`;

  const fetchSummary = useCallback(
    async (force: boolean) => {
      if (!force) {
        const cached = summaryCacheRef.current.get(summaryCacheKey);
        if (cached) {
          setSummaryState(cached);
          return;
        }
      }
      setSummaryState((s) => ({ ...s, loading: true, error: null }));
      try {
        const r = await fetch("/api/conversations/summarize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ thread_key: thread.key, lead_id: thread.lead_id }),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j?.ok) {
          const next: SummaryState = {
            summary: j?.fallback?.summary || "Summary unavailable - try regenerating.",
            keyPoints: j?.fallback?.key_points || [],
            loading: false,
            error: j?.message || "Couldn't generate a summary.",
          };
          summaryCacheRef.current.set(summaryCacheKey, next);
          setSummaryState(next);
          return;
        }
        const next: SummaryState = { summary: j.summary, keyPoints: j.key_points || [], loading: false, error: null };
        summaryCacheRef.current.set(summaryCacheKey, next);
        setSummaryState(next);
      } catch {
        const next: SummaryState = {
          summary: "Summary unavailable - try regenerating.",
          keyPoints: [],
          loading: false,
          error: "Network error.",
        };
        summaryCacheRef.current.set(summaryCacheKey, next);
        setSummaryState(next);
      }
    },
    [summaryCacheKey, thread.key, thread.lead_id],
  );

  useEffect(() => {
    void fetchSummary(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryCacheKey]);

  const handleJumpToMessage = useCallback(
    (messageId: string) => {
      if (registryRef) scrollToMessage(registryRef, messageId);
    },
    [registryRef],
  );

  if (!open) return null;

  const missingStips = payload && payload !== "error" ? computeMissingStips(payload.documents) : [];
  const suggestionChips =
    payload && payload !== "error"
      ? deriveSuggestionChips({
          missingStips,
          record: payload.record.data,
          application: payload.application,
          keyPoints: summaryState.keyPoints,
          templateVars: templateVars || {},
        })
      : [];

  return (
    <div className="h-full min-h-0 flex flex-col border-l border-bg-border bg-bg-panel">
      <div className="shrink-0 flex items-center justify-between px-3.5 py-2.5 border-b border-bg-border lg:hidden">
        <span className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">Deal file</span>
        <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded-md text-fg-dim hover:text-fg hover:bg-bg-elev">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        <AISummaryCard
          summary={summaryState.summary}
          loading={summaryState.loading}
          error={summaryState.error}
          onRegenerate={() => void fetchSummary(true)}
        />
        <KeyPointsAccordion
          keyPoints={summaryState.keyPoints}
          loading={summaryState.loading}
          open={accordions.keyPoints}
          onToggle={() => setAccordions((a) => ({ ...a, keyPoints: !a.keyPoints }))}
          onJump={handleJumpToMessage}
        />

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
            <AISuggestionRail
              chips={suggestionChips}
              onAction={(text) => onComposerAction?.(text)}
              onRequestCall={() => setSchedulerOpen(true)}
            />
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

      {schedulerOpen ? (
        <CallSchedulerModal
          leadId={thread.lead_id}
          threadKey={thread.key}
          defaultLabel={thread.contact_label}
          defaultPhone={thread.contact_phone}
          company={templateVars?.merchant_company}
          onClose={() => setSchedulerOpen(false)}
        />
      ) : null}
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
