/**
 * components/agents/chat-layout.ts - how a channel conversation is laid out
 * (components/agents/AgentChat.tsx), as one table of classes on the OS tokens.
 *
 * WHY (CC, 2026-10-09: "the chat is condensed and not nicely spaced out"). Every
 * message used to be a full-width block (ml-8 / mr-8) at 14px with a 1.625 line
 * height, the list was spaced 16px, and the "via model" line was pulled up into
 * the bubble above it with a negative margin. Now:
 *   - a message is a bubble sized to its text, at most 42rem and 88% of the
 *     column, so a line stays readable on a wide screen and fits a phone;
 *   - yours sit on the right in the accent tint, the department's on the left
 *     on the panel surface, each with the corner nearest its side squared off,
 *     so who said what reads at a glance;
 *   - 12px by 16px inside, 1.65 line height, 20px between messages;
 *   - the "via" line sits UNDER its bubble, aligned with it, in its own space.
 *
 * PURE: class strings only, so tests/chat-layout.test.ts can pin them.
 */

export type ChatRole = "user" | "assistant" | "system";

/** The scrolling list of messages. */
export const CHAT_LIST_CLASS = "flex-1 min-h-0 overflow-y-auto px-4 py-5 sm:px-6 flex flex-col gap-5";

/** One message's column: its bubble and, under it, its "via" line. */
export function chatRowClass(role: ChatRole): string {
  if (role === "system") return "flex flex-col items-center";
  return `flex flex-col gap-1.5 ${role === "user" ? "items-end" : "items-start"}`;
}

const BUBBLE_BASE = "max-w-[min(42rem,88%)] rounded-2xl px-4 py-3 text-sm leading-[1.65] whitespace-pre-wrap break-words";

/** The bubble itself. */
export function chatBubbleClass(role: ChatRole): string {
  if (role === "system") {
    return "max-w-full rounded-lg border border-hairline bg-bg-deep/40 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words font-mono text-fg-dim";
  }
  return role === "user"
    ? `${BUBBLE_BASE} rounded-br-md border border-accent/25 bg-accent-soft text-fg`
    : `${BUBBLE_BASE} rounded-bl-md border border-hairline bg-bg-panel text-fg`;
}

/** The "via ..." line under an answer: what ran it, and whose credits it spent. */
export const CHAT_VIA_CLASS = "px-1 text-[11px] leading-snug text-fg-dim";
