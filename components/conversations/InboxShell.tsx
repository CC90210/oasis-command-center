"use client";

/**
 * InboxShell — Phase 1 of the apex/conversations-inbox-v2 rebuild (plan
 * `compiled-tumbling-gem.md`). Full-page 3-pane omnichannel inbox: replaces
 * the old 2-pane ConversationsClient (deleted). State owner for selection,
 * filters, composer draft/channel, and panel visibility, per plan §3.
 *
 * Server-fed the same way the old client was: app/t/[slug]/[...path]/page.tsx
 * awaits listThreadsForTenant and passes initialThreads in.
 *
 * Responsive collapse (plan §3):
 *   >=1440   3 panes (340/flex/360), context default-open
 *   1280-1439 (xl)  3 panes (320/flex/340), context collapsible
 *   1024-1279 (lg)  2 panes, context = right slide-over
 *   <1024           list-only screen; select -> thread w/ back button; context slide-over
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type {
  ConversationThread,
  ConversationMessage,
  ConversationSource,
} from "@/lib/lead-interactions-queries";
import { EmptyState } from "@/components/Card";
import { ConversationListPane, type SectionKey } from "./ConversationListPane";
import type { ListTabKey } from "./ListTabs";
import type { StatusKey } from "./StatusFilter";
import { ThreadPane } from "./ThreadPane";
import { ContextPanel } from "./ContextPanel";
import type { ComposerChannel } from "./ChannelSwitcher";
import type { MessageStatusMap, MessageRegistry } from "./MessageList";

const CONTEXT_OPEN_STORAGE_KEY = "oasis:conversations:contextPanelOpen";

type FailedDraft = { channel: ComposerChannel; body: string; subject?: string };

function firstName(label: string): string {
  const w = label.trim().split(/\s+/)[0];
  return w || label;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function InboxShell({
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
  // Mobile always lands on the list screen first, even when a thread is
  // pre-selected for the desktop 2/3-pane layouts — "list is its own
  // screen" on <lg (plan §3 responsive collapse).
  const [mobileView, setMobileView] = useState<"list" | "thread">("list");

  // Filters — search + platform section are live/functional; ListTabs/
  // StatusFilter are Phase-1 render-only stubs (see those components).
  const [search, setSearch] = useState("");
  const [section, setSection] = useState<SectionKey>("all");
  const [listTab, setListTab] = useState<ListTabKey | null>(null);
  const [statusTab, setStatusTab] = useState<StatusKey | null>(null);

  // Composer state — owned here per plan §3 ("InboxShell owns... draft,
  // channel mode"), passed down to ThreadPane/Composer.
  const [channel, setChannel] = useState<ComposerChannel>("sms");
  const [smsProvider, setSmsProvider] = useState<"texttorrent" | "kixie">("texttorrent");
  const [draft, setDraft] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  // Optimistic-send status tracking (client-only — see MessageBubble note on
  // why historical rows never get a status ladder).
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());
  const [failedDrafts, setFailedDrafts] = useState<Record<string, FailedDraft>>({});

  // Deal-summary cache lifted from ContextPanel, used for {{funding_amount}}
  // / {{merchant_company}} template interpolation in the Composer.
  const [dealSummaryByLead, setDealSummaryByLead] = useState<
    Record<string, { business_name?: string; funding_amount?: string }>
  >({});

  // Context panel open/closed, persisted per-user in localStorage. Read in a
  // useEffect (not during render) to avoid an SSR/client hydration mismatch.
  const [contextOpen, setContextOpen] = useState(true);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CONTEXT_OPEN_STORAGE_KEY);
      if (raw != null) setContextOpen(raw === "1");
    } catch {
      /* default stays true */
    }
  }, []);
  const toggleContextOpen = useCallback(() => {
    setContextOpen((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(CONTEXT_OPEN_STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* best-effort */
      }
      return next;
    });
  }, []);

  const messageRegistry: MessageRegistry = useRef(new Map());

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

  const selected = useMemo(() => threads.find((t) => t.key === selectedKey) ?? null, [threads, selectedKey]);

  const statusMap: MessageStatusMap = useMemo(() => {
    const m: MessageStatusMap = {};
    for (const id of pendingIds) m[id] = "pending";
    for (const id of failedIds) m[id] = "failed";
    // Optimistic messages that succeeded (local- id, not pending/failed) get
    // a "sent" single-tick — historical DB rows are left with no status at
    // all (see MessageBubble doc comment on why).
    if (selected) {
      for (const msg of selected.messages) {
        if (msg.id.startsWith("local-") && !pendingIds.has(msg.id) && !failedIds.has(msg.id)) {
          m[msg.id] = "sent";
        }
      }
    }
    return m;
  }, [pendingIds, failedIds, selected]);

  const templateVars = useMemo(() => {
    const dealSummary = selected?.lead_id ? dealSummaryByLead[selected.lead_id] : undefined;
    return {
      first_name: selected ? firstName(selected.contact_label) : undefined,
      contact_phone: selected?.contact_phone ?? undefined,
      contact_email: selected?.contact_email ?? undefined,
      merchant_company: dealSummary?.business_name,
      funding_amount: dealSummary?.funding_amount,
    };
  }, [selected, dealSummaryByLead]);

  const selectThread = useCallback((key: string) => {
    setSelectedKey(key);
    setMobileView("thread");
    setNotice(null);
    setDraft("");
    setEmailSubject("");
    setEmailBody("");
    setChannel("sms");
  }, []);

  const onDealSummary = useCallback(
    (leadId: string, summary: { business_name?: string; funding_amount?: string }) => {
      setDealSummaryByLead((prev) => ({ ...prev, [leadId]: summary }));
    },
    [],
  );

  if (!tenantId) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="rounded-xl border border-bg-border bg-bg-panel p-6 text-sm text-fg-muted max-w-md text-center">
          Conversations render for the tenant that owns this workspace. You&apos;re previewing the shell.
        </div>
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="rounded-xl border border-bg-border bg-bg-panel max-w-md w-full">
          <EmptyState message="No conversations yet. Inbound SMS, calls, and email replies will thread here by contact as they arrive." />
        </div>
      </div>
    );
  }

  async function handleSend() {
    if (!selected || sending) return;
    if (channel === "sms") return handleSendSms();
    return handleSendEmail();
  }

  async function handleSendSms() {
    if (!selected || !selected.contact_phone || !draft.trim() || sending) return;
    const localId = `local-${Date.now()}`;
    const body = draft.trim();
    setSending(true);
    setNotice(null);
    setPendingIds((p) => new Set(p).add(localId));

    const optimistic: ConversationMessage = {
      id: localId,
      channel: "sms",
      source: smsProvider,
      direction: "outbound",
      type: "sms_sent",
      subject: null,
      preview: body,
      at: nowIso(),
      recording_url: null,
      transcript_url: null,
      disposition: null,
      call_outcome: null,
      call_duration_sec: null,
    };
    const selKey = selected.key;
    setThreads((prev) =>
      prev.map((t) =>
        t.key === selKey
          ? {
              ...t,
              messages: [...t.messages, optimistic],
              last_preview: optimistic.preview,
              last_at: optimistic.at,
              last_direction: "outbound",
              channels: t.channels.includes("sms") ? t.channels : [...t.channels, "sms"],
              sources: t.sources.includes(smsProvider) ? t.sources : [...t.sources, smsProvider],
            }
          : t,
      ),
    );
    setDraft("");

    try {
      const res = await fetch("/api/conversations/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_id: selected.lead_id,
          to_phone: selected.contact_phone,
          message: body,
          provider: smsProvider,
        }),
      });
      const data = await res.json();
      setPendingIds((p) => {
        const n = new Set(p);
        n.delete(localId);
        return n;
      });
      if (!res.ok || !data.ok) {
        setFailedIds((f) => new Set(f).add(localId));
        setFailedDrafts((d) => ({ ...d, [localId]: { channel: "sms", body } }));
        setNotice(data?.message || data?.error || "Send failed.");
        return;
      }
      setNotice(
        data.dry_run
          ? "Dry-run — logged to the timeline but not actually sent (dashboard is in dry-run mode)."
          : null,
      );
    } catch {
      setPendingIds((p) => {
        const n = new Set(p);
        n.delete(localId);
        return n;
      });
      setFailedIds((f) => new Set(f).add(localId));
      setFailedDrafts((d) => ({ ...d, [localId]: { channel: "sms", body } }));
      setNotice("Network error — reply not sent.");
    } finally {
      setSending(false);
    }
  }

  async function handleSendEmail() {
    if (!selected || !selected.lead_id || !selected.contact_email || sending) return;
    if (!emailSubject.trim() || !emailBody.trim()) return;
    const localId = `local-${Date.now()}`;
    const subject = emailSubject.trim();
    const body = emailBody.trim();
    setSending(true);
    setNotice(null);
    setPendingIds((p) => new Set(p).add(localId));

    const optimistic: ConversationMessage = {
      id: localId,
      channel: "email",
      source: "email",
      direction: "outbound",
      type: "email_queued",
      subject,
      preview: body,
      at: nowIso(),
      recording_url: null,
      transcript_url: null,
      disposition: null,
      call_outcome: null,
      call_duration_sec: null,
    };
    const selKey = selected.key;
    const leadId = selected.lead_id;
    setThreads((prev) =>
      prev.map((t) =>
        t.key === selKey
          ? {
              ...t,
              messages: [...t.messages, optimistic],
              last_preview: optimistic.preview,
              last_at: optimistic.at,
              last_direction: "outbound",
              channels: t.channels.includes("email") ? t.channels : [...t.channels, "email"],
              sources: t.sources.includes("email") ? t.sources : [...t.sources, "email"],
            }
          : t,
      ),
    );
    setEmailSubject("");
    setEmailBody("");

    try {
      const res = await fetch(`/api/leads/${leadId}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to_email: selected.contact_email, subject, body }),
      });
      const data = await res.json().catch(() => ({}));
      setPendingIds((p) => {
        const n = new Set(p);
        n.delete(localId);
        return n;
      });
      if (!res.ok || !data.ok) {
        setFailedIds((f) => new Set(f).add(localId));
        setFailedDrafts((d) => ({ ...d, [localId]: { channel: "email", body, subject } }));
        setNotice(data?.message || data?.error || "Send failed.");
        return;
      }
      setNotice(data.status === "queued" ? "Queued — will send shortly." : null);
    } catch {
      setPendingIds((p) => {
        const n = new Set(p);
        n.delete(localId);
        return n;
      });
      setFailedIds((f) => new Set(f).add(localId));
      setFailedDrafts((d) => ({ ...d, [localId]: { channel: "email", body, subject } }));
      setNotice("Network error — email not sent.");
    } finally {
      setSending(false);
    }
  }

  function handleRetry(message: ConversationMessage) {
    const fd = failedDrafts[message.id];
    if (fd) {
      setChannel(fd.channel);
      if (fd.channel === "sms") setDraft(fd.body);
      else {
        setEmailSubject(fd.subject || "");
        setEmailBody(fd.body);
      }
    } else if (message.channel === "email") {
      setChannel("email");
      setEmailSubject(message.subject || "");
      setEmailBody(message.preview);
    } else {
      setChannel("sms");
      setDraft(message.preview);
    }
    // Clear the failed flag so the composer, not the old bubble, owns the
    // retry going forward — the operator reviews then re-sends explicitly.
    setFailedIds((f) => {
      const n = new Set(f);
      n.delete(message.id);
      return n;
    });
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
      setChannel("sms");
      setDraft(data.suggestion || "");
    } catch {
      setNotice("Network error — AI reply unavailable.");
    } finally {
      setAiLoading(false);
    }
  }

  return (
    <div
      className={`h-full min-h-0 grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] overflow-hidden ${
        contextOpen
          ? "xl:grid-cols-[320px_minmax(480px,1fr)_340px] min-[1440px]:grid-cols-[340px_minmax(480px,1fr)_360px]"
          : "xl:grid-cols-[320px_minmax(0,1fr)] min-[1440px]:grid-cols-[340px_minmax(0,1fr)]"
      }`}
    >
      <div className={`h-full min-h-0 ${mobileView === "thread" ? "hidden lg:block" : "block"}`}>
        <ConversationListPane
          filtered={filtered}
          selectedKey={selectedKey}
          onSelect={selectThread}
          search={search}
          onSearchChange={setSearch}
          section={section}
          onSectionChange={setSection}
          sectionCounts={counts}
          listTab={listTab}
          onListTabChange={setListTab}
          statusTab={statusTab}
          onStatusTabChange={setStatusTab}
        />
      </div>

      <div className={`h-full min-h-0 flex flex-col ${mobileView === "list" ? "hidden lg:flex" : "flex"}`}>
        <button
          type="button"
          onClick={() => setMobileView("list")}
          className="lg:hidden shrink-0 flex items-center gap-1.5 px-3 py-2 text-[11px] text-fg-muted hover:text-fg border-b border-bg-border"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to conversations
        </button>
        {selected ? (
          <ThreadPane
            thread={selected}
            tenantSlug={tenantSlug}
            contextPanelOpen={contextOpen}
            onToggleContextPanel={toggleContextOpen}
            channel={channel}
            onChannelChange={setChannel}
            smsProvider={smsProvider}
            onSmsProviderChange={setSmsProvider}
            draft={draft}
            onDraftChange={setDraft}
            emailSubject={emailSubject}
            onEmailSubjectChange={setEmailSubject}
            emailBody={emailBody}
            onEmailBodyChange={setEmailBody}
            onSend={handleSend}
            sending={sending}
            notice={notice}
            onAiReply={handleAiReply}
            aiLoading={aiLoading}
            templateVars={templateVars}
            statusMap={statusMap}
            onRetry={handleRetry}
            registryRef={messageRegistry}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-fg-dim">Select a conversation.</div>
        )}
      </div>

      {contextOpen && selected && (
        <>
          {/* Backdrop — only meaningful below xl, where the panel is a
              slide-over rather than a grid column; click-outside-to-close. */}
          <button
            type="button"
            aria-label="Close deal file"
            onClick={toggleContextOpen}
            className="block xl:hidden fixed inset-0 z-30 bg-black/50 cursor-default"
          />
          <div className="fixed xl:static inset-y-0 right-0 z-40 xl:z-auto w-full max-w-sm sm:max-w-md xl:w-auto xl:max-w-none h-full min-h-0 shadow-2xl xl:shadow-none">
            <ContextPanel
              thread={selected}
              tenantSlug={tenantSlug}
              open={contextOpen}
              onClose={toggleContextOpen}
              onDealSummary={onDealSummary}
            />
          </div>
        </>
      )}
    </div>
  );
}
