"use client";

/**
 * SlashCommandMenu — autocomplete dropdown that appears the moment the
 * operator types `/` in the chat composer. Filters the wired command
 * set as they type, renders a one-line description per command, and
 * supports keyboard nav (Up/Down to cycle, Tab/Enter to insert,
 * Escape to dismiss).
 *
 * Sibling export: SlashArgMenu — same shape, but for arg autocomplete
 * (e.g. `/agent <slug>` shows available agent slugs after the space).
 *
 * Components are purely presentational + selection-driven; all keyboard
 * handling lives in the parent (ChatWidget) because the textarea owns
 * focus. This file owns the visuals + onSelect callback contract.
 */

import { ALL_COMMANDS, COMMAND_DESCRIPTIONS, type SlashCommandName } from "@/lib/chat-modes/slash-parser";

/**
 * Strip the leading "/command [<args>] — " preamble from a command's
 * description so the dropdown's hint shows ONLY the explanatory text.
 * Without this the row reads "/agent" (bold) then "/agent <slug> —
 * switch the agent persona..." (hint) — the operator sees the command
 * name twice.
 *
 * Splits on the first em-dash or hyphen surrounded by spaces. Falls
 * back to the original string when the description has no dash (so a
 * single-sentence description shows verbatim instead of getting empty).
 */
export function stripDescriptionPreamble(desc: string): string {
  const dashMatch = desc.match(/\s[—-]\s/);
  if (!dashMatch || dashMatch.index === undefined) return desc;
  return desc.slice(dashMatch.index + dashMatch[0].length).trim();
}

type Props = {
  /** The string the operator has typed after the leading slash, lowercased.
   *  When this is empty (the operator just typed "/"), every command shows.
   *  When this is "pl", only commands starting with "pl" show. */
  query: string;
  /** Index into the filtered list — which row is highlighted. The parent
   *  cycles this on ArrowUp/ArrowDown and resets to 0 when the filter
   *  changes (so a previously-valid index doesn't point past the new
   *  shorter list). */
  selectedIndex: number;
  /** Called when the operator picks a command, either by clicking or by
   *  pressing Tab/Enter while the menu is open. Receives the command name
   *  without the leading slash. */
  onSelect: (name: SlashCommandName) => void;
};

/**
 * Filter commands by prefix. Exported so the parent can compute the
 * filtered list once and use it for both the visual render AND the
 * Enter/Tab dispatch — keeping a single source of truth for what's
 * actually selectable.
 */
export function filterCommands(query: string): SlashCommandName[] {
  const q = query.trim().toLowerCase();
  if (!q) return ALL_COMMANDS;
  return ALL_COMMANDS.filter((c) => c.startsWith(q));
}

export function SlashCommandMenu({ query, selectedIndex, onSelect }: Props) {
  const matches = filterCommands(query);
  if (matches.length === 0) {
    // Show an explicit "no matches" so operators don't think the menu
    // is broken. Easier to read than an empty container vanishing
    // beneath the cursor.
    return (
      <div className="absolute bottom-full left-0 mb-2 w-80 rounded-lg border border-bg-border bg-bg-elev shadow-lg z-20 px-3 py-2 text-xs text-fg-dim">
        No commands match
        <span className="font-mono"> /{query}</span>
      </div>
    );
  }
  return (
    <div
      className="absolute bottom-full left-0 mb-2 w-80 rounded-lg border border-bg-border bg-bg-elev shadow-lg z-20 overflow-hidden"
      role="listbox"
      aria-label="Slash command suggestions"
    >
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-bold text-fg-dim border-b border-bg-border/60 bg-bg-deep/60">
        Slash commands
      </div>
      {matches.map((cmd, idx) => {
        const isSelected = idx === selectedIndex;
        return (
          <button
            key={cmd}
            type="button"
            role="option"
            aria-selected={isSelected}
            onClick={() => onSelect(cmd)}
            // Prevent the textarea from losing focus before our click
            // handler fires — without preventDefault on mousedown, the
            // blur fires first and the menu re-renders closed before
            // onClick can run.
            onMouseDown={(e) => e.preventDefault()}
            className={`block w-full text-left px-3 py-2 text-xs transition-colors ${
              isSelected
                ? "bg-accent/15 text-fg"
                : "text-fg-muted hover:bg-bg-deep/40 hover:text-fg"
            }`}
          >
            <div className="font-mono font-bold">/{cmd}</div>
            <div className="text-[10px] text-fg-dim mt-0.5 leading-snug">
              {stripDescriptionPreamble(COMMAND_DESCRIPTIONS[cmd])}
            </div>
          </button>
        );
      })}
      <div className="px-3 py-1.5 text-[10px] text-fg-dim border-t border-bg-border/60 bg-bg-deep/40 font-mono">
        ↑↓ navigate · Tab/Enter to insert · Esc to dismiss
      </div>
    </div>
  );
}

/**
 * SlashArgMenu — companion to SlashCommandMenu for arg completion.
 *
 * Used when the operator has already committed to a command (e.g.,
 * typed `/agent ` with a trailing space) and is now picking the arg.
 * The candidates list is supplied by the caller because the universe
 * of valid args depends on the command (agent slugs for /agent,
 * model ids for /model).
 */
export type ArgCandidate = {
  /** What gets inserted when the operator picks this row. */
  value: string;
  /** Short label rendered in the row — typically the same as `value`
   *  but with light formatting (e.g., title case for agent slugs). */
  label: string;
  /** Optional supporting text rendered beneath the label. */
  hint?: string;
};

export function filterArgCandidates(query: string, candidates: ArgCandidate[]): ArgCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return candidates;
  return candidates.filter((c) => c.value.toLowerCase().includes(q) || c.label.toLowerCase().includes(q));
}

type ArgMenuProps = {
  /** What the operator has typed AFTER the command + space.
   *  E.g. for input `/agent atl`, query is "atl". */
  query: string;
  candidates: ArgCandidate[];
  selectedIndex: number;
  /** The command this arg menu is bound to — used only for the header
   *  label so the operator sees what they're picking from. */
  command: SlashCommandName;
  onSelect: (value: string) => void;
};

export function SlashArgMenu({ query, candidates, selectedIndex, command, onSelect }: ArgMenuProps) {
  const matches = filterArgCandidates(query, candidates);
  if (matches.length === 0) {
    return (
      <div className="absolute bottom-full left-0 mb-2 w-80 rounded-lg border border-bg-border bg-bg-elev shadow-lg z-20 px-3 py-2 text-xs text-fg-dim">
        No <span className="font-mono">/{command}</span> values match
        <span className="font-mono"> {query}</span>
      </div>
    );
  }
  return (
    <div
      className="absolute bottom-full left-0 mb-2 w-80 rounded-lg border border-bg-border bg-bg-elev shadow-lg z-20 overflow-hidden"
      role="listbox"
      aria-label={`Arguments for /${command}`}
    >
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-bold text-fg-dim border-b border-bg-border/60 bg-bg-deep/60 font-mono">
        /{command} arguments
      </div>
      {matches.slice(0, 12).map((c, idx) => {
        const isSelected = idx === selectedIndex;
        return (
          <button
            key={c.value}
            type="button"
            role="option"
            aria-selected={isSelected}
            onClick={() => onSelect(c.value)}
            onMouseDown={(e) => e.preventDefault()}
            className={`block w-full text-left px-3 py-2 text-xs transition-colors ${
              isSelected
                ? "bg-accent/15 text-fg"
                : "text-fg-muted hover:bg-bg-deep/40 hover:text-fg"
            }`}
          >
            <div className="font-mono font-bold">{c.label}</div>
            {c.hint && (
              <div className="text-[10px] text-fg-dim mt-0.5 leading-snug truncate">
                {c.hint}
              </div>
            )}
          </button>
        );
      })}
      {matches.length > 12 && (
        <div className="px-3 py-1.5 text-[10px] text-fg-dim border-t border-bg-border/60 bg-bg-deep/40 font-mono">
          + {matches.length - 12} more — keep typing to narrow
        </div>
      )}
      <div className="px-3 py-1.5 text-[10px] text-fg-dim border-t border-bg-border/60 bg-bg-deep/40 font-mono">
        ↑↓ navigate · Tab/Enter to insert · Esc to dismiss
      </div>
    </div>
  );
}
