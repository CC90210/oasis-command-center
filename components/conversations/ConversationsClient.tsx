"use client";

/**
 * ConversationsClient — Phase 3b of the TT + Kixie full embedding plan
 * (2026-06-02). The unified inbox: TextTorrent chats + Kixie SMS + Kixie
 * calls + email replies, threaded by contact (lead → phone → email).
 *
 * Server-fed: app/t/[slug]/[...path]/page.tsx awaits listThreadsForTenant
 * and passes the threads in. This component owns the channel filter, search,
 * thread selection, the reply composer, and the TT AI-reply suggestion.
 *
 * Reply sends POST /api/conversations/reply (dry-run-gated server-side);
 * the AI-reply button POSTs /api/conversations/ai-reply and drops the
 * suggestion into the composer for the operator to edit before sending —
 * it never auto-sends (TCPA posture).
 */

import { useMemo, useState } from "react";
import type {
  ConversationThread,
  ConversationMessage,
  ConversationSource,
} from "@/lib/lead-interactions-queries";
import { EmptyState } from "@/components/Card";
import { MessageSquare, Phone, Mail, Send, Sparkles, Search, StickyNote } from "lucide-react";

// The inbox sections by PLATFORM (not raw channel) — Adon's "section for texts,
// emails, Twilio, Kixie". Each filters the thread list by ConversationThread.sources.
type SectionKey = "all" | "texttorrent" | "email" | "twilio" | "kixie";

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "texttorrent", label: "Text Torrent" },
  { key: "email", label: "Email" },
  { key: "twilio", label: "Twilio" },
  { key: "kixie", label: "Kixie" },
];

// Platforms with live ingestion today. Email + Twilio sections render but their
// full inbound sync is a later phase — show a "coming soon" affordance there.
const COMING_SOON: Partial<Record<SectionKey, string>> = {
  email: "Email conversations will thread here once inbound email sync is wired (coming soon).",
  twilio: "Twilio conversations will thread here once Twilio ingestion is wired (coming soon).",
};

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ChannelIcon({ channel, className }: { channel: string; className?: string }) {
  const cls = className || "h-3.5 w-3.5";
  if (channel === "phone") return <Phone className={cls} />;
  if (channel === "email") return <Mail className={cls} />;
  if (channel === "note") return <StickyNote className={cls} />;
  return <MessageSquare className={cls} />;
}

/** Mirror the lead-timeline vocabulary for phone rows. */
function messageTitle(m: ConversationMessage): string {
  if (m.channel !== "phone") return "";
  const base =
    m.type === "call_voicemail"
      ? "Voicemail"
      : m.type === "call_ci_summary"
        ? "CI summary"
        : m.type === "call_dispositioned"
          ? "Disposition set"
          : m.type === "call_answered"
            ? "Answered call"
            : m.type === "call_ended"
              ? "Call ended"
              : m.direction === "inbound"
                ? "Inbound call"
                : "Outbound call";
  const dur = m.call_duration_sec ? `${Math.round((m.call_duration_sec / 60) * 10) / 10}m` : null;
  const disp = m.disposition || m.call_outcome;
  return [base, dur ? `· ${dur}` : null, disp ? `· ${disp}` : null].filter(Boolean).join(" ");
}

export function ConversationsClient({
  tenantSlug,
  tenantId,
  initialThreads,
}: {
  tenantSlug: string;
  tenantId: string | null;
  initialThreads: ConversationThread[];
}) {
  const [threads, setThreads] = useState<ConversationThread[]>(initialThreads);
  const [selectedKey, setSelectedKey] = useState<string | null>(initialThreads[0]?.key ?? null);
  const [section, setSection] = useState<SectionKey>("all");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [provider, setProvider] = useState<"texttorrent" | "kixie">("texttorrent");
  const [sending, setSending] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Thread count per section (drives the little badges on the section tabs).
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: threads.length };
    for (const t of threads) for (const s of t.sources) c[s] = (c[s] || 0) + 1;
    return c;
  }, [threads]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    return threads.filter((t) => {
      if (section !== "all" && !t.sources.includes(section as ConversationSource)) return false;
      if (!q) return true;
      const hay = `${t.contact_label} ${t.last_preview} ${t.contact_phone || ""} ${t.contact_email || ""}`.toLowerCase();
      if (hay.includes(q)) return true;
      if (qDigits.length >= 4 && (t.contact_phone || "").replace(/\D/g, "").includes(qDigits)) return true;
      return false;
    });
  }, [threads, section, search]);

  const selected = useMemo(
    () => threads.find((t) => t.key === selectedKey) ?? null,
    [threads, selectedKey],
  );

  if (!tenantId) {
    return (
      <div className="rounded-xl border border-bg-border bg-bg-panel p-6 text-sm text-fg-muted">
        Conversations render for the tenant that owns this workspace. You&apos;re previewing the shell.
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="rounded-xl border border-bg-border bg-bg-panel">
        <EmptyState message="No conversations yet. Inbound SMS, calls, and email replies will thread here by contact as they arrive." />
      </div>
    );
  }

  async function handleSend() {
    if (!selected || !selected.contact_phone || !draft.trim() || sending) return;
    setSending(true);
    setNotice(null);
    try {
      const res = await fetch("/api/conversations/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_id: selected.lead_id,
          to_phone: selected.contact_phone,
          message: draft.trim(),
          provider,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setNotice(data?.message || data?.error || "Send failed.");
        return;
      }
      const optimistic: ConversationMessage = {
        id: `local-${Date.now()}`,
        channel: "sms",
        source: provider, // "texttorrent" | "kixie" — both valid ConversationSource
        direction: "outbound",
        type: "sms_sent",
        subject: null,
        preview: draft.trim(),
        at: new Date().toISOString(),
        recording_url: null,
        transcript_url: null,
        disposition: null,
        call_outcome: null,
        call_duration_sec: null,
      };
      setThreads((prev) =>
        prev.map((t) =>
          t.key === selected.key
            ? {
                ...t,
                messages: [...t.messages, optimistic],
                last_preview: optimistic.preview,
                last_at: optimistic.at,
                last_direction: "outbound",
                channels: t.channels.includes("sms") ? t.channels : [...t.channels, "sms"],
                sources: t.sources.includes(provider) ? t.sources : [...t.sources, provider],
              }
            : t,
        ),
      );
      setDraft("");
      setNotice(
        data.dry_run
          ? "Dry-run — logged to the timeline but not actually sent (dashboard is in dry-run mode)."
          : null,
      );
    } catch {
      setNotice("Network error — reply not sent.");
    } finally {
      setSending(false);
    }
  }

  async function handleAiReply() {
    if (!selected?.tt_chat_id || aiLoading) return;
    setAiLoading(true);
    setNotice(null);
    try {
      const res = await fetch("/api/conversations/ai-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: selected.tt_chat_id }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setNotice(data?.message || "Couldn't generate an AI reply.");
        return;
      }
      setDraft(data.suggestion || "");
    } catch {
      setNotice("Network error — AI reply unavailable.");
    } finally {
      setAiLoading(false);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
      {/* Master list */}
      <div className="rounded-xl border border-bg-border bg-bg-panel flex flex-col max-h-[72vh]">
        <div className="border-b border-bg-border p-3 space-y-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSection(s.key)}
                className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${
                  section === s.key
                    ? "border-accent/50 bg-accent/10 text-accent"
                    : "border-bg-border bg-bg-elev/40 text-fg-muted hover:text-fg"
                }`}
              >
                {s.label}
                {counts[s.key] ? (
                  <span className="ml-1 text-[10px] opacity-70">{counts[s.key]}</span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-fg-dim" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contacts…"
              className="w-full bg-bg-deep/40 border border-bg-border rounded-md pl-8 pr-2 py-1.5 text-xs text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent/50"
            />
          </div>
        </div>
        <div className="overflow-y-auto flex-1">
          {filtered.length === 0 ? (
            <div className="p-4 text-xs text-fg-dim italic">
              {!search && COMING_SOON[section] ? COMING_SOON[section] : "No threads match."}
            </div>
          ) : (
            filtered.map((t) => (
              <button
                key={t.key}
                onClick={() => setSelectedKey(t.key)}
                className={`w-full text-left px-3 py-2.5 border-b border-bg-border/50 hover:bg-bg-elev/30 transition-colors ${
                  selectedKey === t.key ? "bg-bg-elev/40" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-fg truncate">{t.contact_label}</span>
                  <span className="text-[10px] text-fg-dim shrink-0">{relTime(t.last_at)}</span>
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="flex items-center gap-1 text-fg-dim">
                    {t.channels.map((ch) => (
                      <ChannelIcon key={ch} channel={ch} className="h-3 w-3" />
                    ))}
                  </span>
                  <span className="text-xs text-fg-muted truncate">{t.last_preview || "—"}</span>
                </div>
                {t.inbound_count > 0 && (
                  <span className="inline-block mt-1 text-[10px] text-status-engaged">
                    {t.inbound_count} inbound
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Detail pane */}
      <div className="rounded-xl border border-bg-border bg-bg-panel flex flex-col max-h-[72vh]">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-sm text-fg-dim">
            Select a conversation.
          </div>
        ) : (
          <>
            <div className="border-b border-bg-border px-4 py-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-fg">{selected.contact_label}</div>
                <div className="text-[11px] text-fg-dim">
                  {selected.contact_phone || selected.contact_email || "No contact info"}
                  {selected.lead_id && (
                    <a
                      href={`/t/${tenantSlug}/leads?lead=${selected.lead_id}`}
                      className="ml-2 text-accent hover:underline"
                    >
                      Open lead
                    </a>
                  )}
                </div>
              </div>
            </div>

            <div className="overflow-y-auto flex-1 p-4 space-y-2.5">
              {selected.messages.map((m) => {
                const outbound = m.direction === "outbound";
                const callTitle = messageTitle(m);
                return (
                  <div key={m.id} className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[78%] rounded-lg px-3 py-2 text-sm ${
                        outbound
                          ? "bg-accent/10 border border-accent/25 text-fg"
                          : "bg-bg-elev/50 border border-bg-border text-fg"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 text-[10px] text-fg-dim mb-0.5">
                        <ChannelIcon channel={m.channel} className="h-3 w-3" />
                        <span>{callTitle || (m.channel === "email" ? m.subject || "Email" : m.channel)}</span>
                        <span>· {relTime(m.at)}</span>
                      </div>
                      {m.preview && <div className="whitespace-pre-wrap break-words">{m.preview}</div>}
                      {(m.recording_url || m.transcript_url) && (
                        <div className="mt-1 flex flex-col gap-0.5 text-[11px]">
                          {m.recording_url && (
                            <a href={m.recording_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                              ▶ Recording
                            </a>
                          )}
                          {m.transcript_url && (
                            <a href={m.transcript_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                              📄 Transcript
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Composer */}
            <div className="border-t border-bg-border p-3 space-y-2">
              {notice && <div className="text-[11px] text-status-warm">{notice}</div>}
              {selected.contact_phone ? (
                <>
                  <div className="flex items-center gap-1.5">
                    {(["texttorrent", "kixie"] as const).map((p) => (
                      <button
                        key={p}
                        onClick={() => setProvider(p)}
                        className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border ${
                          provider === p
                            ? "border-accent/50 bg-accent/10 text-accent"
                            : "border-bg-border bg-bg-elev/40 text-fg-dim hover:text-fg"
                        }`}
                      >
                        {p === "texttorrent" ? "TextTorrent" : "Kixie"}
                      </button>
                    ))}
                    {selected.tt_chat_id && (
                      <button
                        onClick={handleAiReply}
                        disabled={aiLoading}
                        className="ml-auto inline-flex items-center gap-1 text-[11px] text-accent hover:underline disabled:opacity-50"
                      >
                        <Sparkles className="h-3 w-3" />
                        {aiLoading ? "Thinking…" : "AI reply"}
                      </button>
                    )}
                  </div>
                  <div className="flex items-end gap-2">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={2}
                      placeholder={`Reply via ${provider === "kixie" ? "Kixie" : "TextTorrent"}…`}
                      className="flex-1 bg-bg-deep/40 border border-bg-border rounded-md px-3 py-2 text-sm text-fg placeholder:text-fg-dim resize-none focus:outline-none focus:border-accent/50"
                    />
                    <button
                      onClick={handleSend}
                      disabled={sending || !draft.trim()}
                      className="btn-secondary inline-flex items-center gap-1.5 !px-3 !py-2 text-xs disabled:opacity-50"
                    >
                      <Send className="h-3.5 w-3.5" />
                      {sending ? "Sending…" : "Send"}
                    </button>
                  </div>
                </>
              ) : (
                <div className="text-[11px] text-fg-dim italic">
                  This thread has no SMS number — reply via the email path.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
