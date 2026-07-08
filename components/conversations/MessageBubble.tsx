"use client";

/**
 * MessageBubble — plan §3. direction=side+shade; channel=icon+accent-stripe
 * (SMS green-600, email blue-600, phone/call neutral slate); status ladder
 * for THIS-SESSION optimistic sends only (the read-time lead_interactions
 * grouping has no delivery/read-receipt telemetry yet — see status note
 * below); failed=red Tag+inline Retry; email chrome collapses to a subject
 * line (no per-message body fetch exists yet to show a full quoted trail —
 * P2/P3 candidate, noted in the handoff).
 */

import type { ConversationMessage } from "@/lib/conversation-threading";
import { Mail, MessageSquare, Phone, Voicemail, Clock, Check, CheckCheck, AlertTriangle } from "lucide-react";
import { relTime } from "./format";
import { Tag } from "@/components/Card";

/** Client-only send-status, tracked in ThreadPane's local state — NOT part
 *  of the shared ConversationMessage shape (the DB doesn't carry delivery
 *  status on these rows yet). Historical messages render with no status
 *  ladder at all (we genuinely don't know), which is more honest than a
 *  fabricated double-check. */
export type BubbleStatus = "pending" | "sent" | "failed";

function callTitle(m: ConversationMessage): string {
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

function ChannelBadge({ channel }: { channel: string }) {
  if (channel === "email") {
    return (
      <span className="inline-flex items-center gap-1 text-blue-400">
        <Mail className="h-3 w-3" />
      </span>
    );
  }
  if (channel === "phone") {
    return (
      <span className="inline-flex items-center gap-1 text-slate-400">
        {/* voicemail gets its own glyph so it reads distinctly in a mixed thread */}
        <Phone className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-emerald-500">
      <MessageSquare className="h-3 w-3" />
    </span>
  );
}

function accentStripeClass(channel: string): string {
  if (channel === "email") return "border-l-2 border-l-blue-600";
  if (channel === "phone") return "border-l-2 border-l-slate-500";
  return "border-l-2 border-l-emerald-600";
}

function StatusGlyph({ status }: { status: BubbleStatus }) {
  if (status === "pending") return <Clock className="h-3 w-3 text-fg-dim" />;
  if (status === "failed") return <AlertTriangle className="h-3 w-3 text-status-hot" />;
  return <CheckCheck className="h-3 w-3 text-status-engaged" />;
}

export function MessageBubble({
  message,
  status,
  onRetry,
  registerRef,
}: {
  message: ConversationMessage;
  status?: BubbleStatus;
  onRetry?: () => void;
  registerRef?: (id: string, el: HTMLDivElement | null) => void;
}) {
  const outbound = message.direction === "outbound";
  const isNote = message.channel === "note";
  const isVoicemail = message.type === "call_voicemail";
  const title = callTitle(message);
  const pending = status === "pending";
  const failed = status === "failed";

  return (
    <div className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
      <div
        ref={(el) => registerRef?.(message.id, el)}
        data-message-id={message.id}
        className={[
          "max-w-[70%] px-3.5 py-2.5 text-sm transition-opacity scroll-mt-4",
          outbound
            ? "rounded-2xl rounded-br-sm bg-accent/15 text-fg"
            : "rounded-2xl rounded-bl-sm bg-bg-elev/70 text-fg",
          accentStripeClass(message.channel),
          pending ? "opacity-60" : "opacity-100",
          isNote ? "bg-amber-500/10" : "",
        ].join(" ")}
      >
        <div className="flex items-center gap-1.5 text-[10px] text-fg-dim mb-1">
          <ChannelBadge channel={message.channel} />
          <span>
            {title || (message.channel === "email" ? message.subject || "Email" : message.channel)}
          </span>
          <span>· {relTime(message.at)}</span>
          {outbound && status && (
            <span className="ml-auto flex items-center gap-1">
              <StatusGlyph status={status} />
            </span>
          )}
        </div>

        {message.channel === "email" && message.subject && (
          <div className="text-[12.5px] font-semibold text-fg mb-0.5">{message.subject}</div>
        )}

        {message.preview && (
          <div className="whitespace-pre-wrap break-words leading-relaxed">{message.preview}</div>
        )}

        {isVoicemail && !message.preview && (
          <div className="italic text-fg-dim text-[12.5px]">Voicemail left — no transcript yet.</div>
        )}

        {(message.recording_url || message.transcript_url) && (
          <div className="mt-1.5 flex flex-col gap-0.5 text-[11px]">
            {message.recording_url && (
              <a href={message.recording_url} target="_blank" rel="noreferrer" className="text-accent hover:underline inline-flex items-center gap-1">
                <Voicemail className="h-3 w-3" /> Recording
              </a>
            )}
            {message.transcript_url && (
              <a href={message.transcript_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                Transcript
              </a>
            )}
          </div>
        )}

        {failed && (
          <div className="mt-1.5 flex items-center gap-2">
            <Tag tone="hot">Failed to send</Tag>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="text-[11px] font-semibold text-accent hover:underline"
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
