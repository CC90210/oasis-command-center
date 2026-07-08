"use client";

/**
 * Composer — plan §3/§6.4. ChannelSwitcher + SegmentCounter (SMS) + subject
 * field (email) + SlashCommandTemplateMenu + SendSplitButton, plus the
 * Phase 2 AI affordances: "✨ Suggest" (full draft via voice-suggest),
 * AIDraftBanner (Accept & Send / Edit / Regenerate / Discard once a draft is
 * AI-authored and unedited), GhostTextSuggestion (debounced single-sentence
 * SMS opener on a focused-empty composer, Tab to accept), and tone-rewrite
 * buttons once a draft exists. Owns only ephemeral UI state (slash-menu,
 * ghost-text debounce/abort lifecycle) — the actual draft text, channel,
 * and AI-suggestion bookkeeping are owned by InboxShell per the plan's
 * state-owner design, and passed down as props.
 */

import { useEffect, useRef, useState } from "react";
import { Sparkles, Wand2 } from "lucide-react";
import type { ConversationThread } from "@/lib/conversation-threading";
import { ChannelSwitcher, type ComposerChannel } from "./ChannelSwitcher";
import { SegmentCounter } from "./SegmentCounter";
import {
  SlashCommandTemplateMenu,
  DEFAULT_SMS_TEMPLATES,
  DEFAULT_EMAIL_TEMPLATES,
  interpolateTemplate,
  type SlashTemplate,
} from "./SlashCommandTemplateMenu";
import { SendSplitButton } from "./SendSplitButton";
import { AIDraftBanner } from "./AIDraftBanner";
import { GhostTextSuggestion } from "./GhostTextSuggestion";

const TONE_TOOLS: { id: string; label: string; instruction: string }[] = [
  { id: "formal", label: "More formal", instruction: "make the tone more formal and professional" },
  { id: "casual", label: "More casual", instruction: "make the tone more casual and conversational" },
  { id: "tighter", label: "Tighten", instruction: "make it noticeably shorter and more direct, same meaning" },
];

function TextareaWithSlash({
  value,
  onChange,
  placeholder,
  rows,
  templates,
  templateVars,
  disabled,
  onFocus,
  ghostText,
  onAcceptGhost,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  rows: number;
  templates: SlashTemplate[];
  templateVars: Record<string, string | undefined>;
  disabled?: boolean;
  onFocus?: () => void;
  ghostText?: string | null;
  onAcceptGhost?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Slash trigger: "/" at the very start of the draft, or right after a
  // space/newline — so a phone number or "24/7" mid-sentence never opens it.
  const slashMatch = /(^|[\s\n])\/([\w-]*)$/.exec(value);

  const handleChange = (v: string) => {
    onChange(v);
    const m = /(^|[\s\n])\/([\w-]*)$/.exec(v);
    setMenuOpen(!!m);
  };

  const pickTemplate = (t: SlashTemplate) => {
    const body = interpolateTemplate(t.body, templateVars);
    // Replace the trailing "/query" fragment with the interpolated template.
    const next = slashMatch
      ? value.slice(0, value.length - slashMatch[0].length) + (slashMatch[1] || "") + body
      : body;
    onChange(next);
    setMenuOpen(false);
    taRef.current?.focus();
  };

  return (
    <div className="relative flex-1">
      {menuOpen && (
        <SlashCommandTemplateMenu
          query={slashMatch?.[2] || ""}
          templates={templates}
          onPick={pickTemplate}
          onClose={() => setMenuOpen(false)}
        />
      )}
      <textarea
        ref={taRef}
        value={value}
        disabled={disabled}
        onFocus={onFocus}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && menuOpen) {
            e.preventDefault();
            setMenuOpen(false);
            return;
          }
          if (e.key === "Tab" && ghostText && value.trim() === "") {
            e.preventDefault();
            onAcceptGhost?.();
          }
        }}
        rows={rows}
        placeholder={placeholder}
        className="w-full bg-bg-deep/40 border border-bg-border rounded-md px-3 py-2 text-sm text-fg placeholder:text-fg-dim resize-none focus:outline-none focus:border-accent/50 disabled:opacity-50"
      />
    </div>
  );
}

export function Composer({
  thread,
  channel,
  onChannelChange,
  smsProvider,
  onSmsProviderChange,
  draft,
  onDraftChange,
  emailSubject,
  onEmailSubjectChange,
  emailBody,
  onEmailBodyChange,
  onSend,
  sending,
  notice,
  onAiReply,
  aiLoading,
  templateVars,
  aiSuggestActive,
  aiConfidence,
  aiSanitized,
  aiSuggestLoading,
  onSuggest,
  onAiAcceptSend,
  onAiEdit,
  onAiRegenerate,
  onAiDiscard,
  onToneRewrite,
  onGhostFetch,
}: {
  thread: ConversationThread;
  channel: ComposerChannel;
  onChannelChange: (c: ComposerChannel) => void;
  smsProvider: "texttorrent" | "kixie";
  onSmsProviderChange: (p: "texttorrent" | "kixie") => void;
  draft: string;
  onDraftChange: (v: string) => void;
  emailSubject: string;
  onEmailSubjectChange: (v: string) => void;
  emailBody: string;
  onEmailBodyChange: (v: string) => void;
  onSend: (opts?: { scheduledAt?: string }) => void;
  sending: boolean;
  notice: string | null;
  onAiReply?: () => void;
  aiLoading?: boolean;
  templateVars: Record<string, string | undefined>;
  aiSuggestActive?: boolean;
  aiConfidence?: "low" | "med" | "high";
  aiSanitized?: boolean;
  aiSuggestLoading?: boolean;
  onSuggest?: () => void;
  onAiAcceptSend?: () => void;
  onAiEdit?: () => void;
  onAiRegenerate?: () => void;
  onAiDiscard?: () => void;
  onToneRewrite?: (instruction: string) => void;
  onGhostFetch?: (signal: AbortSignal) => Promise<string | null>;
}) {
  const hasPhone = !!thread.contact_phone;
  const hasEmail = !!thread.contact_email;
  const canSend = channel === "sms" ? hasPhone && draft.trim().length > 0 : hasEmail && emailSubject.trim().length > 0 && emailBody.trim().length > 0;

  const activeText = channel === "sms" ? draft : `${emailSubject}\n${emailBody}`;
  const hasUserText = activeText.trim().length > 0;
  const suggestDisabled = !onSuggest || hasUserText || !!aiSuggestLoading;

  // --- Ghost text (plan §6.4 #2): focused-empty SMS composer, 800ms debounce,
  // Tab accepts, any keystroke dismisses + cancels the in-flight request. ---
  const [ghostText, setGhostText] = useState<string | null>(null);
  const ghostTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ghostAbortRef = useRef<AbortController | null>(null);

  function clearGhost() {
    if (ghostTimerRef.current) {
      clearTimeout(ghostTimerRef.current);
      ghostTimerRef.current = null;
    }
    if (ghostAbortRef.current) {
      ghostAbortRef.current.abort();
      ghostAbortRef.current = null;
    }
    setGhostText(null);
  }

  useEffect(() => clearGhost, []); // cancel any in-flight ghost fetch on unmount/thread-switch

  function scheduleGhost() {
    if (!onGhostFetch || channel !== "sms" || draft.trim().length > 0) return;
    clearGhost();
    ghostTimerRef.current = setTimeout(() => {
      const controller = new AbortController();
      ghostAbortRef.current = controller;
      onGhostFetch(controller.signal)
        .then((text) => {
          if (!controller.signal.aborted) setGhostText(text);
        })
        .catch(() => {
          if (!controller.signal.aborted) setGhostText(null);
        });
    }, 800);
  }

  function handleSmsDraftChange(v: string) {
    clearGhost(); // any keystroke dismisses the suggestion + cancels the fetch
    onDraftChange(v);
  }

  function acceptGhost() {
    if (!ghostText) return;
    onDraftChange(ghostText);
    clearGhost();
  }

  return (
    <div className="shrink-0 border-t border-bg-border bg-bg-panel p-3 space-y-2">
      {notice && <div className="text-[11px] text-status-warm">{notice}</div>}

      <div className="flex items-center gap-1.5 flex-wrap">
        <ChannelSwitcher
          channel={channel}
          onChange={onChannelChange}
          smsDisabled={!hasPhone}
          emailDisabled={!hasEmail}
        />
        {channel === "sms" && (
          <div className="inline-flex items-center rounded-md border border-bg-border overflow-hidden">
            {(["texttorrent", "kixie"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onSmsProviderChange(p)}
                className={`text-[10px] uppercase tracking-wide px-2 py-1 transition-colors ${
                  smsProvider === p ? "bg-accent/15 text-accent" : "text-fg-dim hover:text-fg hover:bg-bg-elev"
                }`}
              >
                {p === "texttorrent" ? "TextTorrent" : "Kixie"}
              </button>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {channel === "sms" && <SegmentCounter text={draft} />}
          {onAiReply && thread.tt_chat_id && (
            <button
              type="button"
              onClick={onAiReply}
              disabled={aiLoading}
              className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline disabled:opacity-50"
            >
              <Sparkles className="h-3 w-3" />
              {aiLoading ? "Thinking…" : "AI reply"}
            </button>
          )}
          <button
            type="button"
            onClick={onSuggest}
            disabled={suggestDisabled}
            title={hasUserText ? "Clear the draft to get an AI suggestion" : "Draft a reply in this rep's voice"}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-300 border border-violet-500/30 bg-violet-500/10 hover:bg-violet-500/20 rounded-md px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-violet-500/10 transition-colors"
          >
            <Sparkles className="h-3 w-3" />
            {aiSuggestLoading ? "Thinking…" : "Suggest"}
          </button>
        </div>
      </div>

      {aiSuggestActive && (
        <AIDraftBanner
          confidence={aiConfidence}
          sanitized={aiSanitized}
          loading={aiSuggestLoading}
          onAcceptSend={canSend ? onAiAcceptSend : undefined}
          onEdit={onAiEdit}
          onRegenerate={onAiRegenerate}
          onDiscard={onAiDiscard}
        />
      )}

      {channel === "sms" ? (
        hasPhone ? (
          <div className="space-y-1.5">
            <div className="flex items-end gap-2">
              <TextareaWithSlash
                value={draft}
                onChange={handleSmsDraftChange}
                onFocus={scheduleGhost}
                ghostText={ghostText}
                onAcceptGhost={acceptGhost}
                placeholder={`Reply via ${smsProvider === "kixie" ? "Kixie" : "TextTorrent"}… (type / for templates)`}
                rows={2}
                templates={DEFAULT_SMS_TEMPLATES}
                templateVars={templateVars}
              />
              <SendSplitButton
                onSend={onSend}
                sending={sending}
                disabled={!canSend}
                channel="sms"
                recipientPhone={thread.contact_phone}
              />
            </div>
            <GhostTextSuggestion text={ghostText} onAccept={acceptGhost} onDismiss={clearGhost} />
            {hasUserText && onToneRewrite && (
              <ToneToolsRow onPick={(instr) => onToneRewrite(instr)} disabled={!!aiSuggestLoading} />
            )}
          </div>
        ) : (
          <div className="text-[11px] text-fg-dim italic">This thread has no SMS number on file.</div>
        )
      ) : hasEmail ? (
        <div className="space-y-1.5">
          <input
            value={emailSubject}
            onChange={(e) => onEmailSubjectChange(e.target.value)}
            placeholder="Subject"
            className="w-full bg-bg-deep/40 border border-bg-border rounded-md px-3 py-2 text-sm text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent/50"
          />
          <div className="flex items-end gap-2">
            <TextareaWithSlash
              value={emailBody}
              onChange={onEmailBodyChange}
              placeholder="Write an email… (type / for templates)"
              rows={4}
              templates={DEFAULT_EMAIL_TEMPLATES}
              templateVars={templateVars}
            />
            <SendSplitButton
              onSend={onSend}
              sending={sending}
              disabled={!canSend}
              channel="email"
              recipientPhone={thread.contact_phone}
            />
          </div>
          {hasUserText && onToneRewrite && (
            <ToneToolsRow onPick={(instr) => onToneRewrite(instr)} disabled={!!aiSuggestLoading} />
          )}
        </div>
      ) : (
        <div className="text-[11px] text-fg-dim italic">This thread has no email address on file.</div>
      )}
    </div>
  );
}

/** Tone-rewrite chips — plan §6.4 tail: "appear only after a draft exists".
 *  Each calls voice-suggest with mode:'rewrite' + the current draft. */
function ToneToolsRow({ onPick, disabled }: { onPick: (instruction: string) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <Wand2 className="h-3 w-3 text-violet-400/50 shrink-0" />
      {TONE_TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onPick(t.instruction)}
          disabled={disabled}
          className="text-[10.5px] font-medium text-violet-300/80 hover:text-violet-200 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
