"use client";

/**
 * LeadTimelinePanel — the conversation + activity history for a single lead.
 *
 * Phase 18 of the SunBiz CRM Reconstructor build (2026-05-17). Mounted
 * below the lead's ManifestRecordForm on the detail page so Adon's team
 * can see every interaction in one place — the explicit ask from the
 * 2026-05-16 meeting ("we need to see text + email conversations
 * against the lead record").
 *
 * Data source: GET /api/leads/[id]/timeline (server-side merged feed
 * across lead_interactions, email_open_events, lead_documents,
 * agent_events, agent_alerts). The panel just renders.
 *
 * Render rules:
 *   - Chronological newest-first.
 *   - Per-source icon + colour tint so the operator can scan-skim.
 *   - Email-open events fold under the matching outbound by
 *     outbound_message_id when both are present (rendered as a "👁
 *     opened Nm ago" pill underneath the original send).
 *   - Suspicious-prefetch opens (Apple Mail Privacy Protection) render
 *     with a dimmer style + "(prefetch)" suffix so operators don't
 *     mistake APMP noise for real engagement.
 *   - Empty state: friendly "no activity yet" rather than blank.
 */

import { useEffect, useState } from "react";
import {
  ChevronRight,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneOutgoing,
  Sparkles,
  Voicemail,
  type LucideIcon,
} from "lucide-react";
import { relTime } from "@/lib/format-helpers";

type TimelineEvent = {
  source: string;
  type: string;
  at: string;
  title: string;
  body?: string;
  meta?: Record<string, unknown>;
};

type ApiResponse = {
  ok: boolean;
  events?: TimelineEvent[];
  truncated?: boolean;
  errors?: { feed: string; message: string }[];
  error?: string;
};

const SOURCE_STYLES: Record<string, { dot: string; label: string }> = {
  interaction: { dot: "bg-sky-400", label: "Conversation" },
  email_open: { dot: "bg-emerald-400", label: "Open" },
  document: { dot: "bg-violet-400", label: "Document" },
  system: { dot: "bg-fg-dim", label: "System" },
  alert: { dot: "bg-red-400", label: "Alert" },
};

function absTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/* ---------------- Kixie call events (Phase 2 webhook rows) ---------------- */

/** The call fields the timeline route forwards in `meta` for phone rows. */
type CallMeta = {
  channel?: string;
  direction?: string;
  call_duration_sec?: number | null;
  disposition?: string | null;
  call_outcome?: string | null;
  recording_url?: string | null;
  transcript_url?: string | null;
  ci_content?: string | null;
  metadata?: Record<string, unknown> | null;
};

function isCallEvent(e: TimelineEvent): boolean {
  return (
    e.source === "interaction" &&
    (e.meta as CallMeta | undefined)?.channel === "phone"
  );
}

/** "2m 14s" / "45s" — timeline-compact call duration. */
function fmtCallDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Icon + headline per call lifecycle type (mirrors the route's labels). */
function callVisual(type: string, direction: string): { Icon: LucideIcon; label: string } {
  switch (type) {
    case "call_voicemail":
      return { Icon: Voicemail, label: "Voicemail" };
    case "call_ci_summary":
      return { Icon: Sparkles, label: "AI call summary" };
    case "call_dispositioned":
      return { Icon: PhoneCall, label: "Disposition set" };
    case "call_answered":
      return { Icon: PhoneCall, label: "Call answered" };
    case "call_ended":
      return { Icon: Phone, label: "Call ended" };
    case "call_incoming":
      return { Icon: PhoneIncoming, label: "Inbound call" };
    case "call_outgoing":
      return { Icon: PhoneOutgoing, label: "Outbound call" };
    case "call_initiated":
      return { Icon: PhoneOutgoing, label: "Call initiated" };
  }
  return direction === "inbound"
    ? { Icon: PhoneIncoming, label: "Inbound call" }
    : { Icon: PhoneOutgoing, label: "Outbound call" };
}

/**
 * The route appends "▶ Recording: <url>" / "📄 Transcript: <url>" lines to the
 * body for older consumers; this panel renders proper links off meta instead,
 * so strip the raw-URL lines to avoid showing the same artifact twice.
 */
function stripArtifactLines(body?: string): string | null {
  if (!body) return null;
  const kept = body
    .split("\n")
    .filter((l) => !l.startsWith("▶ Recording:") && !l.startsWith("📄 Transcript:"));
  const out = kept.join("\n").trim();
  return out || null;
}

function SentimentBadge({ sentiment }: { sentiment: string | null }) {
  const v = (sentiment || "").toLowerCase();
  if (v !== "positive" && v !== "neutral" && v !== "negative") return null;
  const cls =
    v === "positive"
      ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/10"
      : v === "negative"
        ? "text-red-400 border-red-400/30 bg-red-400/10"
        : "text-fg-dim border-bg-border bg-bg-elev";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-px rounded border text-[10px] font-semibold uppercase tracking-wide ${cls}`}
    >
      {v}
    </span>
  );
}

/** Expandable AI summary block for call_ci_summary rows. */
function CiSummaryBlock({ content, sentiment }: { content: string; sentiment: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[11px] font-medium text-sky-400 hover:text-sky-300 transition-colors"
      >
        <ChevronRight
          className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        AI call summary
        <SentimentBadge sentiment={sentiment} />
      </button>
      {open && (
        <div className="mt-1.5 rounded-md border border-bg-border/60 bg-bg-deep/40 px-2.5 py-2 text-[11.5px] text-fg-muted whitespace-pre-wrap break-words">
          {content}
        </div>
      )}
    </div>
  );
}

/**
 * Rich rendering for Kixie call rows: per-type phone icon, duration,
 * disposition chip, recording/transcript links, and the expandable AI
 * summary (with sentiment) on call_ci_summary events. Same compact
 * bordered-row footprint as every other timeline entry.
 */
function CallEventContent({ e }: { e: TimelineEvent }) {
  const m = (e.meta || {}) as CallMeta;
  const direction = typeof m.direction === "string" ? m.direction : "outbound";
  const { Icon, label } = callVisual(e.type, direction);
  const durationSec =
    typeof m.call_duration_sec === "number" && m.call_duration_sec > 0
      ? m.call_duration_sec
      : null;
  const disposition = m.disposition || m.call_outcome || null;
  const isCi = e.type === "call_ci_summary";
  const body = stripArtifactLines(e.body);
  const sentiment =
    typeof m.metadata?.ci_sentiment === "string" ? (m.metadata.ci_sentiment as string) : null;
  const ciText = (isCi && (m.ci_content || body)) || "";
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0 font-medium text-fg break-words flex items-center gap-1.5 flex-wrap">
          <Icon className="w-3.5 h-3.5 text-sky-400 shrink-0" aria-hidden />
          <span>{label}</span>
          {durationSec !== null && (
            <span className="text-[11px] text-fg-muted font-mono tabular-nums">
              {fmtCallDuration(durationSec)}
            </span>
          )}
          {disposition && (
            <span className="inline-flex items-center px-1.5 py-px rounded border border-bg-border bg-bg-elev text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
              {disposition.replace(/_/g, " ")}
            </span>
          )}
        </div>
        <time title={absTime(e.at)} className="text-[10.5px] text-fg-dim font-mono shrink-0">
          {relTime(e.at)}
        </time>
      </div>
      {isCi && ciText ? (
        <CiSummaryBlock content={ciText} sentiment={sentiment} />
      ) : (
        body && (
          <div className="mt-1 text-fg-muted whitespace-pre-wrap break-words text-[11.5px]">
            {body}
          </div>
        )
      )}
      {(m.recording_url || m.transcript_url) && (
        <div className="mt-1.5 flex items-center gap-3 text-[11px]">
          {m.recording_url && (
            <a
              href={m.recording_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 hover:text-sky-300 hover:underline font-medium"
            >
              ▶ Recording
            </a>
          )}
          {m.transcript_url && (
            <a
              href={m.transcript_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-fg-muted hover:text-fg hover:underline"
            >
              Transcript
            </a>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Stage transition events (BRAVO_RECORD_STATUS_CHANGED + BRAVO_LEAD_AUTO_BUMPED)
 * carry `from`, `to`, `field`, and `reason` in payload. Surface them as a
 * compact "old → new (reason)" line so operators see WHY a lead moved.
 */
function renderStageMetaLine(meta: Record<string, unknown> | undefined) {
  if (!meta) return null;
  const from = typeof meta.from === "string" ? meta.from : null;
  const to = typeof meta.to === "string" ? meta.to : null;
  const reason = typeof meta.reason === "string" ? meta.reason : null;
  if (!from && !to) return null;
  return (
    <div className="mt-1 text-[11px] text-fg-dim font-mono break-words">
      {from || "—"} → <span className="text-fg-muted">{to || "—"}</span>
      {reason && <span className="ml-2 text-fg-dim">· {reason.replace(/_/g, " ")}</span>}
    </div>
  );
}

export function LeadTimelinePanel({
  leadId,
  entity = "lead",
}: {
  leadId: string;
  /** Drawer entity — applications must send ?entity=application so the route
   *  resolves the linked lead id, else it 404s (Codex 2026-06-19). */
  entity?: "lead" | "application";
}) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedErrors, setFeedErrors] = useState<{ feed: string; message: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const onTouch = (event: Event) => {
      const detail = (event as CustomEvent<{ leadId?: string }>).detail;
      if (!detail?.leadId || detail.leadId === leadId) {
        setRevision((value) => value + 1);
      }
    };
    window.addEventListener("oasis:lead-touch", onTouch);
    return () => window.removeEventListener("oasis:lead-touch", onTouch);
  }, [leadId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const q = entity === "application" ? "?entity=application" : "";
    fetch(`/api/leads/${leadId}/timeline${q}`, { cache: "no-store" })
      .then(async (r) => {
        const data = (await r.json()) as ApiResponse;
        if (cancelled) return;
        if (!data.ok) {
          setError(data.error || "timeline unavailable");
          setEvents([]);
        } else {
          setEvents(data.events || []);
          setFeedErrors(data.errors || []);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e?.message || e));
        setEvents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [leadId, entity, revision]);

  return (
    <div className="rounded-2xl border border-bg-border bg-bg-deep/40 p-5">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-fg-muted">
          Timeline
        </h3>
        <span className="text-[11px] text-fg-dim">
          {loading
            ? "loading…"
            : events
              ? `${events.length} event${events.length === 1 ? "" : "s"}`
              : ""}
        </span>
      </div>

      {error && (
        <div className="text-sm text-red-300 border border-red-500/30 bg-red-500/10 rounded-md p-3 mb-3">
          Timeline couldn&apos;t load: {error}
        </div>
      )}

      {feedErrors.length > 0 && (
        <div className="text-[11px] text-amber-300/80 mb-3">
          Partial: couldn&apos;t read {feedErrors.map((f) => f.feed).join(", ")}.
        </div>
      )}

      {!loading && events && events.length === 0 && (
        <div className="text-sm text-fg-dim italic py-6 text-center">
          No activity yet. Send a message or upload a doc and it&apos;ll appear here.
        </div>
      )}

      {events && events.length > 0 && (
        <ol className="relative border-l border-bg-border ml-2 space-y-3">
          {events.map((e, i) => {
            const style = SOURCE_STYLES[e.source] || SOURCE_STYLES.system;
            const dimmed =
              e.source === "email_open" &&
              !!(e.meta as { suspicious_prefetch?: boolean } | undefined)?.suspicious_prefetch;
            return (
              <li key={i} className="ml-5 relative">
                <span
                  className={`absolute -left-[27px] top-1 inline-block w-2.5 h-2.5 rounded-full ${style.dot} ring-2 ring-bg-deep`}
                />
                <div
                  className={`rounded-md border border-bg-border/60 px-3 py-2 text-[12.5px] ${
                    dimmed ? "opacity-50" : ""
                  }`}
                >
                  {isCallEvent(e) ? (
                    <CallEventContent e={e} />
                  ) : (
                    <>
                      <div className="flex items-baseline justify-between gap-3">
                        <div className="font-medium text-fg break-words">
                          {e.title}
                          {dimmed && (
                            <span className="ml-1.5 text-[10px] text-fg-dim font-mono">
                              (prefetch)
                            </span>
                          )}
                        </div>
                        <time
                          title={absTime(e.at)}
                          className="text-[10.5px] text-fg-dim font-mono shrink-0"
                        >
                          {relTime(e.at)}
                        </time>
                      </div>
                      {e.body && (
                        <div className="mt-1 text-fg-muted whitespace-pre-wrap break-words text-[11.5px]">
                          {e.body}
                        </div>
                      )}
                      {e.source === "system" && renderStageMetaLine(e.meta)}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
