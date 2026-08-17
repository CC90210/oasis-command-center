/**
 * The chat's CLI-runtime selection, shared by the two surfaces that set it.
 *
 * WHY THIS FILE EXISTS. Settings → "Local AI CLIs" and the chat header both
 * write which local subscription powers a conversation, and they agree by
 * persisting to the same localStorage key. Until 2026-08-17 that key was a
 * string literal declared TWICE — components/ChatWidget.tsx:136 and
 * components/settings/LocalCliProvidersCard.tsx:145 — kept in step by a comment
 * asking the next person to remember:
 *
 *     // Keep the string in lock-step with components/ChatWidget.tsx
 *     // CLI_RUNTIME_STORAGE_KEY … the value sync is the contract.
 *
 * A contract enforced by a comment is not enforced. Change either literal and
 * nothing breaks loudly: Settings writes one key, the header reads another, the
 * selector silently stops reflecting the choice, and both screens keep rendering
 * a confident answer. That is the failure shape with no error message.
 *
 * One exported constant makes the coupling real — a rename now moves both call
 * sites or fails the build.
 */

/** localStorage key holding the operator's chosen local CLI runtime. */
export const CLI_RUNTIME_STORAGE_KEY = "oasis.chat.cliRuntime.v1";

export const CLI_RUNTIMES = ["claude", "codex", "gemini"] as const;
export type CliRuntime = (typeof CLI_RUNTIMES)[number];

export function isCliRuntime(v: unknown): v is CliRuntime {
  return typeof v === "string" && (CLI_RUNTIMES as readonly string[]).includes(v);
}

/**
 * Read the stored runtime, defaulting to Claude.
 *
 * Returns the default on the server and on unreadable/absent storage rather than
 * throwing — this is a UI preference, and a private-mode browser must not take
 * the chat down with it.
 */
export function readCliRuntime(): CliRuntime {
  if (typeof window === "undefined") return "claude";
  try {
    const raw = window.localStorage.getItem(CLI_RUNTIME_STORAGE_KEY);
    return isCliRuntime(raw) ? raw : "claude";
  } catch {
    return "claude";
  }
}

/**
 * Persist the runtime. Swallows storage failures on purpose: the caller has
 * already updated its own state, so the click still registers visually even
 * where storage is disabled — it simply will not survive a reload.
 */
export function writeCliRuntime(next: CliRuntime): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CLI_RUNTIME_STORAGE_KEY, next);
  } catch {
    /* quota or private mode — in-memory state still reflects the choice */
  }
}
