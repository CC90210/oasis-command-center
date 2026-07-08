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
import type { VoiceConfidence } from "@/lib/ai-voice-suggest";

type AiSuggestion = {
  sms: string;
  emailSubject: string;
  emailBody: string;
  confidence: VoiceConfidence;
  sanitized: boolean;
};
type LastAiParams =
  | { mode: "full" }
  | { mode: "rewrite"; channel: ComposerChannel; instruction: string; draft: string };

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

  // Voice-suggest state (Phase 2, plan §6.4). `aiSuggestion` is the last
  // loaded suggestion for the CURRENT thread — AIDraftBanner shows only
  // while the active channel's text still matches it verbatim (computed in
  // `aiDraftActive` below), so any user edit silently drops the banner
  // without extra bookkeeping. `lastAiParamsRef` lets Regenerate re-issue
  // whatever call (full draft or a tone-rewrite) produced the current draft.
  const [aiSuggestion, setAiSuggestion] = useState<AiSuggestion | null>(null);
  const [aiSuggestLoading, setAiSuggestLoading] = useState(false);
  const lastAiParamsRef = useRef<LastAiParams | null>(null);

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

  // True only while the composer's active-channel text still verbatim
  // matches the last AI suggestion — any keystroke that diverges makes this
  // false and the banner disappears, satisfying "never overwrite user-typed
  // text; the AI affordance disappears once edited" without a dirty flag.
  const aiDraftActive = useMemo(() => {
    if (!aiSuggestion) return false;
    return channel === "sms"
      ? draft === aiSuggestion.sms
      : emailSubject === aiSuggestion.emailSubject && emailBody === aiSuggestion.emailBody;
  }, [aiSuggestion, channel, draft, emailSubject, emailBody]);

  const selectThread = useCallback((key: string) => {
    setSelectedKey(key);
    setMobileView("thread");
    setNotice(null);
    setDraft("");
    setEmailSubject("");
    setEmailBody("");
    setChannel("sms");
    setAiSuggestion(null);
    lastAiParamsRef.current = null;
  }, []);

  const onDealSummary = useCallback(
    (leadId: string, summary: { business_name?: string; funding_amount?: string }) => {
      setDealSummaryByLead((prev) => ({ ...prev, [leadId]: summary }));
    },
    [],
  );

  // Empty/preview early-returns live BELOW all hooks (React rules-of-hooks:
  // hooks must run unconditionally on every render). See just above the render.

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
      setAiSuggestion(null);
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
      setAiSuggestion(null);
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

  // --- Voice-suggest (Phase 2, plan §6.3/§6.4) ---------------------------
  // Every call re-derives lead_id/thread_key from `selected` (never a
  // client-cached transcript) and lets the route re-query messages + lead
  // facts server-side. `runVoiceSuggest` is the single fetch primitive; the
  // three user-facing actions (full Suggest, tone-rewrite, ghost text) and
  // Regenerate all funnel through it so error/notice handling never drifts.
  const runVoiceSuggest = useCallback(
    async (params: {
      mode: "full" | "ghost" | "rewrite";
      channel?: ComposerChannel;
      instruction?: string;
      draft?: string;
      signal?: AbortSignal;
    }): Promise<AiSuggestion | null> => {
      if (!selected) return null;
      try {
        const res = await fetch("/api/conversations/voice-suggest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lead_id: selected.lead_id,
            thread_key: selected.key,
            mode: params.mode,
            channel: params.channel,
            instruction: params.instruction,
            draft: params.draft,
          }),
          signal: params.signal,
        });
        const data = await res.json().catch(() => null);
        if (params.signal?.aborted) return null;
        if (!res.ok || !data?.ok) {
          if (params.mode !== "ghost") {
            setNotice(data?.message || "Couldn't generate a suggestion.");
          }
          if (data?.fallback) {
            return {
              sms: data.fallback.sms || "",
              emailSubject: data.fallback.email?.subject || "",
              emailBody: data.fallback.email?.body || "",
              confidence: "low",
              sanitized: false,
            };
          }
          return null;
        }
        return {
          sms: data.sms || "",
          emailSubject: data.email?.subject || "",
          emailBody: data.email?.body || "",
          confidence: (data.voice_confidence as VoiceConfidence) || "low",
          sanitized: data.sanitized !== false,
        };
      } catch (err) {
        if (params.signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) return null;
        if (params.mode !== "ghost") setNotice("Network error — suggestion unavailable.");
        return null;
      }
    },
    [selected],
  );

  async function handleSuggest() {
    if (aiSuggestLoading) return;
    setAiSuggestLoading(true);
    setNotice(null);
    lastAiParamsRef.current = { mode: "full" };
    const result = await runVoiceSuggest({ mode: "full" });
    setAiSuggestLoading(false);
    if (!result) return;
    setAiSuggestion(result);
    // Always fill the channel the operator is actively looking at (Composer
    // only enables Suggest when that channel's field is empty). Only
    // opportunistically fill the OTHER channel if it's also empty — never
    // clobber real typed text sitting in the tab the operator isn't on.
    if (channel === "sms") {
      setDraft(result.sms);
      if (!emailSubject.trim() && !emailBody.trim()) {
        setEmailSubject(result.emailSubject);
        setEmailBody(result.emailBody);
      }
    } else {
      setEmailSubject(result.emailSubject);
      setEmailBody(result.emailBody);
      if (!draft.trim()) setDraft(result.sms);
    }
  }

  async function handleToneRewrite(instruction: string) {
    if (aiSuggestLoading) return;
    const draftText = channel === "sms" ? draft : emailBody;
    if (!draftText.trim()) return;
    setAiSuggestLoading(true);
    setNotice(null);
    lastAiParamsRef.current = { mode: "rewrite", channel, instruction, draft: draftText };
    const result = await runVoiceSuggest({ mode: "rewrite", channel, instruction, draft: draftText });
    setAiSuggestLoading(false);
    if (!result) return;
    setAiSuggestion(result);
    if (channel === "sms") setDraft(result.sms || draftText);
    else {
      setEmailBody(result.emailBody || draftText);
      if (result.emailSubject) setEmailSubject(result.emailSubject);
    }
  }

  async function handleAiRegenerate() {
    const p = lastAiParamsRef.current;
    if (!p || aiSuggestLoading) return;
    setAiSuggestLoading(true);
    setNotice(null);
    const result = await runVoiceSuggest(p.mode === "full" ? { mode: "full" } : { mode: "rewrite", channel: p.channel, instruction: p.instruction, draft: p.draft });
    setAiSuggestLoading(false);
    if (!result) return;
    setAiSuggestion(result);
    if (p.mode === "full") {
      if (channel === "sms") {
        setDraft(result.sms);
        if (!emailSubject.trim() && !emailBody.trim()) {
          setEmailSubject(result.emailSubject);
          setEmailBody(result.emailBody);
        }
      } else {
        setEmailSubject(result.emailSubject);
        setEmailBody(result.emailBody);
        if (!draft.trim()) setDraft(result.sms);
      }
    } else if (p.channel === "sms") {
      setDraft(result.sms || draft);
    } else {
      setEmailBody(result.emailBody || emailBody);
      if (result.emailSubject) setEmailSubject(result.emailSubject);
    }
  }

  function handleAiEdit() {
    // Dismiss the banner but keep the current text — the operator free-edits
    // from here; a fresh Suggest/regenerate call is needed to bring it back.
    setAiSuggestion(null);
  }

  function handleAiDiscard() {
    setAiSuggestion(null);
    if (channel === "sms") setDraft("");
    else {
      setEmailSubject("");
      setEmailBody("");
    }
  }

  async function handleAiAcceptSend() {
    setAiSuggestion(null);
    await handleSend();
  }

  const handleGhostFetch = useCallback(
    async (signal: AbortSignal): Promise<string | null> => {
      const result = await runVoiceSuggest({ mode: "ghost", signal });
      return result?.sms?.trim() || null;
    },
    [runVoiceSuggest],
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
            aiSuggestActive={aiDraftActive}
            aiConfidence={aiSuggestion?.confidence}
            aiSanitized={aiSuggestion?.sanitized}
            aiSuggestLoading={aiSuggestLoading}
            onSuggest={handleSuggest}
            onAiAcceptSend={handleAiAcceptSend}
            onAiEdit={handleAiEdit}
            onAiRegenerate={handleAiRegenerate}
            onAiDiscard={handleAiDiscard}
            onToneRewrite={handleToneRewrite}
            onGhostFetch={handleGhostFetch}
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
              registryRef={messageRegistry}
              templateVars={templateVars}
              onComposerAction={(text) => {
                setChannel("sms");
                setDraft(text);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
