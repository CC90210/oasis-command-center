"use client";

/**
 * SlashCommandMenu — autocomplete dropdown that appears the moment the
 * operator types `/` in the chat composer. Filters the wired command
 * set as they type, renders a one-line description per command, and
 * supports keyboard nav (Up/Down to cycle, Tab/Enter to insert,
 * Escape to dismiss).
 *
 * The component is purely presentational + selection-driven — all
 * keyboard handling lives in the parent (ChatWidget) because the
 * textarea owns focus. This file's job is the visuals + the
 * `onSelect` callback contract.
 */

import { ALL_COMMANDS, COMMAND_DESCRIPTIONS, type SlashCommandName } from "@/lib/chat-modes/slash-parser";

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
              {COMMAND_DESCRIPTIONS[cmd].replace(/^\/\w+\s*[—-]\s*/, "")}
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
