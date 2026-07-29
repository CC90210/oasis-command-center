"use client";

/**
 * ThreadPane — plan §3. Composes ContactHeaderBar (sticky) + MessageList
 * (flex-1, own scroll) + Composer (pinned). All height discipline lives
 * here: `h-full min-h-0 flex flex-col` so MessageList is the only scroller.
 */

import type { ConversationThread, ConversationMessage } from "@/lib/conversation-threading";
import { ContactHeaderBar } from "./ContactHeaderBar";
import { MessageList, type MessageStatusMap, type MessageRegistry } from "./MessageList";
import { Composer } from "./Composer";
import { SunbizDraftCard } from "./SunbizDraftCard";
import type { ComposerChannel } from "./ChannelSwitcher";

export function ThreadPane({
  thread,
  tenantSlug,
  contextPanelOpen,
  onToggleContextPanel,
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
  statusMap,
  onRetry,
  registryRef,
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
  tenantSlug: string;
  contextPanelOpen: boolean;
  onToggleContextPanel: () => void;
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
  statusMap: MessageStatusMap;
  onRetry: (m: ConversationMessage) => void;
  registryRef?: MessageRegistry;
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
  return (
    <div className="h-full min-h-0 flex flex-col">
      <ContactHeaderBar
        thread={thread}
        tenantSlug={tenantSlug}
        contextPanelOpen={contextPanelOpen}
        onToggleContextPanel={onToggleContextPanel}
        onComposeEmail={() => onChannelChange("email")}
      />
      <SunbizDraftCard threadKey={thread.key} />
      <MessageList messages={thread.messages} statusMap={statusMap} onRetry={onRetry} registryRef={registryRef} />
      <Composer
        thread={thread}
        channel={channel}
        onChannelChange={onChannelChange}
        smsProvider={smsProvider}
        onSmsProviderChange={onSmsProviderChange}
        draft={draft}
        onDraftChange={onDraftChange}
        emailSubject={emailSubject}
        onEmailSubjectChange={onEmailSubjectChange}
        emailBody={emailBody}
        onEmailBodyChange={onEmailBodyChange}
        onSend={onSend}
        sending={sending}
        notice={notice}
        onAiReply={onAiReply}
        aiLoading={aiLoading}
        templateVars={templateVars}
        aiSuggestActive={aiSuggestActive}
        aiConfidence={aiConfidence}
        aiSanitized={aiSanitized}
        aiSuggestLoading={aiSuggestLoading}
        onSuggest={onSuggest}
        onAiAcceptSend={onAiAcceptSend}
        onAiEdit={onAiEdit}
        onAiRegenerate={onAiRegenerate}
        onAiDiscard={onAiDiscard}
        onToneRewrite={onToneRewrite}
        onGhostFetch={onGhostFetch}
      />
    </div>
  );
}
