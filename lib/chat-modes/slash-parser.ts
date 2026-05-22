/**
 * Slash-command parser for the Agent chat composer.
 *
 * Pure function — given a raw user input string, return either a
 * structured slash command or a normal message. The chat widget intercepts
 * commands client-side (no API call for `/clear`, `/plan`, `/build`,
 * `/help`, `/agent`, `/model`); `/compact` is the only one that hits the
 * server (it summarizes history).
 *
 * Mirrors the OpenCode UX pattern: slash commands feel like first-class
 * affordances, never accidentally sent to the model as text. Anything
 * unrecognized falls through as a regular message so a user typing
 * "/path/to/file" gets normal chat behaviour.
 *
 * Designed to be added to incrementally — each command's args are
 * permissive (rest-of-line) so individual handlers can parse further.
 */

export type SlashCommandName =
  | "agent"      // /agent <slug> — switch persona, reset history
  | "model"      // /model <id>   — switch model (must be a saved provider+model)
  | "clear"      // /clear        — reset conversation history
  | "compact"    // /compact      — summarize history to a single user message
  | "plan"       // /plan         — enter plan mode (gates write tools)
  | "build"      // /build        — exit plan mode (restore full registry)
  | "help";      // /help         — list commands

export const ALL_COMMANDS: SlashCommandName[] = [
  "agent",
  "model",
  "clear",
  "compact",
  "plan",
  "build",
  "help",
];

/** One-line description for each command — surfaced by /help. */
export const COMMAND_DESCRIPTIONS: Record<SlashCommandName, string> = {
  agent:   "/agent <slug> — switch the agent persona (e.g., /agent atlas). Resets history.",
  model:   "/model <id> — switch the active model (must already be saved in Settings → Agents).",
  clear:   "/clear — reset the conversation history. Keeps current agent + mode.",
  compact: "/compact — summarize the conversation into one message and keep going. Use when the chat gets long.",
  plan:    "/plan — enter plan mode. Agent can read + reason but cannot call any write tool. Use /build to exit.",
  build:   "/build — exit plan mode. Restores the full tool registry for the current chat mode.",
  help:    "/help — show this list.",
};

export type ParsedInput =
  | { kind: "command"; name: SlashCommandName; args: string; raw: string }
  | { kind: "message"; text: string };

const SLASH_COMMAND_RE = /^\/([a-z]+)(?:\s+(.+))?$/i;

/**
 * Parse a user input string.
 *
 * Rules:
 *   - Leading whitespace is stripped before checking for a slash. So
 *     `"  /plan"` is recognised, but a message with leading whitespace
 *     content beyond the slash (e.g., `"/ plan"`) is not.
 *   - Only the FIRST line is considered when looking for a slash command.
 *     A multi-line input starting with `/plan` is still a command (the
 *     plan summary inside the same paste would land in args).
 *   - Trailing whitespace + a trailing slash (`/help`) work; case-
 *     insensitive (`/HELP` is the same as `/help`).
 *   - Unknown commands fall through as messages. So `/foo` is treated as
 *     a regular message — never silently dropped or errored. The chat
 *     widget can layer an "unknown command — did you mean /help?" hint
 *     on top if desired, by checking with isKnownCommand.
 */
export function parseInput(raw: string): ParsedInput {
  const trimmedStart = raw.replace(/^\s+/, "");
  if (!trimmedStart.startsWith("/")) {
    return { kind: "message", text: raw };
  }
  // Only the first line participates in command matching.
  const firstLine = trimmedStart.split(/\r?\n/, 1)[0]!;
  const match = SLASH_COMMAND_RE.exec(firstLine.trim());
  if (!match) {
    return { kind: "message", text: raw };
  }
  const candidate = match[1]!.toLowerCase();
  if (!isKnownCommand(candidate)) {
    return { kind: "message", text: raw };
  }
  const argsFromFirstLine = (match[2] || "").trim();
  // If the input had additional lines after the command line, fold them
  // into args so e.g. `/compact\n\nfocus on revenue` carries the focus
  // hint to the compactor.
  const restLines = trimmedStart.split(/\r?\n/).slice(1).join("\n").trim();
  const args = restLines
    ? argsFromFirstLine
      ? `${argsFromFirstLine}\n${restLines}`
      : restLines
    : argsFromFirstLine;
  return {
    kind: "command",
    name: candidate as SlashCommandName,
    args,
    raw,
  };
}

export function isKnownCommand(name: string): name is SlashCommandName {
  return (ALL_COMMANDS as string[]).includes(name);
}

/** Render the /help payload (plain text — caller formats for display). */
export function renderHelp(): string {
  const lines = ["Slash commands:"];
  for (const cmd of ALL_COMMANDS) {
    lines.push(`  ${COMMAND_DESCRIPTIONS[cmd]}`);
  }
  return lines.join("\n");
}
