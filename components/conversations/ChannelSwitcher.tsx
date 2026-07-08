"use client";

/** ChannelSwitcher — segmented SMS/Email control on the Composer. Recolors
 *  to the active channel (SMS green-600, Email blue-600) so SendSplitButton
 *  can pick up the same accent. */
import { MessageSquare, Mail } from "lucide-react";

export type ComposerChannel = "sms" | "email";

export function ChannelSwitcher({
  channel,
  onChange,
  smsDisabled,
  emailDisabled,
}: {
  channel: ComposerChannel;
  onChange: (c: ComposerChannel) => void;
  smsDisabled?: boolean;
  emailDisabled?: boolean;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-bg-border overflow-hidden shrink-0">
      <button
        type="button"
        disabled={smsDisabled}
        onClick={() => onChange("sms")}
        title={smsDisabled ? "No SMS number on this thread" : "Switch to SMS"}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
          channel === "sms" ? "bg-emerald-500/15 text-emerald-400" : "text-fg-dim hover:text-fg hover:bg-bg-elev"
        }`}
      >
        <MessageSquare className="h-3.5 w-3.5" /> SMS
      </button>
      <span className="w-px self-stretch bg-bg-border" />
      <button
        type="button"
        disabled={emailDisabled}
        onClick={() => onChange("email")}
        title={emailDisabled ? "No email on this thread" : "Switch to email"}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
          channel === "email" ? "bg-blue-500/15 text-blue-400" : "text-fg-dim hover:text-fg hover:bg-bg-elev"
        }`}
      >
        <Mail className="h-3.5 w-3.5" /> Email
      </button>
    </div>
  );
}
