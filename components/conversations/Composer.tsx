"use client";

/**
 * Composer — plan §3. ChannelSwitcher + SegmentCounter (SMS) + subject field
 * (email) + SlashCommandTemplateMenu + SendSplitButton. Owns only ephemeral
 * UI state (the slash-menu open/query); the actual draft text, channel, and
 * send-in-flight state are owned by InboxShell per the plan's state-owner
 * design, and passed down as props.
 *
 * The AI "✨ Suggest" affordance is a disabled stub — Phase 2 wires it to
 * `voice-suggest`; AIDraftBanner/GhostTextSuggestion aren't mounted here yet
 * because there's nothing for them to show.
 */

import { useRef, useState } from "react";
import { Sparkles } from "lucide-react";
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

function TextareaWithSlash({
  value,
  onChange,
  placeholder,
  rows,
  templates,
  templateVars,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  rows: number;
  templates: SlashTemplate[];
  templateVars: Record<string, string | undefined>;
  disabled?: boolean;
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
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && menuOpen) {
            e.preventDefault();
            setMenuOpen(false);
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
  onSend: () => void;
  sending: boolean;
  notice: string | null;
  onAiReply?: () => void;
  aiLoading?: boolean;
  templateVars: Record<string, string | undefined>;
}) {
  const hasPhone = !!thread.contact_phone;
  const hasEmail = !!thread.contact_email;
  const canSend = channel === "sms" ? hasPhone && draft.trim().length > 0 : hasEmail && emailSubject.trim().length > 0 && emailBody.trim().length > 0;

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
            disabled
            title="AI voice suggestions — coming in Phase 2"
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-400/60 border border-violet-500/20 bg-violet-500/5 rounded-md px-2 py-1 cursor-not-allowed"
          >
            <Sparkles className="h-3 w-3" />
            Suggest
          </button>
        </div>
      </div>

      {channel === "sms" ? (
        hasPhone ? (
          <div className="flex items-end gap-2">
            <TextareaWithSlash
              value={draft}
              onChange={onDraftChange}
              placeholder={`Reply via ${smsProvider === "kixie" ? "Kixie" : "TextTorrent"}… (type / for templates)`}
              rows={2}
              templates={DEFAULT_SMS_TEMPLATES}
              templateVars={templateVars}
            />
            <SendSplitButton onSend={onSend} sending={sending} disabled={!canSend} channel="sms" />
          </div>
        ) : (
          <div className="text-[11px] text-fg-dim italic">This thread has no SMS number on file.</div>
        )
      ) : hasEmail ? (
        <div className="space-y-2">
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
            <SendSplitButton onSend={onSend} sending={sending} disabled={!canSend} channel="email" />
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-fg-dim italic">This thread has no email address on file.</div>
      )}
    </div>
  );
}
