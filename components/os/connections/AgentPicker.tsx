"use client";

/**
 * AgentPicker - choose which agents may use a key or an app.
 *
 * Each choice is a department's agent, named the way the workspace's AI Team
 * names it ("Maven (Marketing)", lib/os/agent-access-names.ts); the routes send
 * those names as `choices`, and without them the department labels show.
 *
 * "All agents" means every agent, including one with no department. Turning
 * one department off from "All agents" leaves the other five; ticking it back
 * returns to "All agents" (collapseToAll). Turning every department off leaves
 * "No agents", which an owner may want for a key kept on file but not in use.
 * The rules and defaults are lib/os/agent-access.ts.
 */

import { AGENT_CHOICES, collapseToAll, type AgentAccess, type AgentChoice } from "@/lib/os/agent-access";
import type { DepartmentKey } from "@/lib/os/types";

const CHIP = "rounded-md border px-2 py-0.5 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-60";
const ON = "border-accent bg-accent/15 text-fg";
const OFF = "border-hairline bg-bg-raised text-fg-muted hover:text-fg";

export function AgentPicker({
  value,
  onChange,
  disabled = false,
  label = "Which agents may use this",
  choices = AGENT_CHOICES,
}: {
  value: AgentAccess;
  onChange: (next: AgentAccess) => void;
  disabled?: boolean;
  label?: string;
  /** The workspace's agents, by department, with the words to show (the routes' `choices`). */
  choices?: ReadonlyArray<AgentChoice>;
}) {
  const all = value === "all";
  const has = (k: DepartmentKey) => all || (value as readonly DepartmentKey[]).includes(k);
  const toggle = (k: DepartmentKey) => {
    const current = all ? AGENT_CHOICES.map((c) => c.key) : [...(value as readonly DepartmentKey[])];
    const next = current.includes(k) ? current.filter((x) => x !== k) : [...current, k];
    onChange(collapseToAll(next));
  };
  const labelFor = (k: DepartmentKey) => choices.find((c) => c.key === k)?.label ?? AGENT_CHOICES.find((c) => c.key === k)?.label ?? k;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      <button
        type="button"
        aria-pressed={all}
        disabled={disabled}
        onClick={() => onChange(all ? [] : "all")}
        className={`${CHIP} ${all ? ON : OFF}`}
      >
        All agents
      </button>
      {AGENT_CHOICES.map((c) => (
        <button
          key={c.key}
          type="button"
          aria-pressed={has(c.key)}
          disabled={disabled}
          onClick={() => toggle(c.key)}
          className={`${CHIP} ${has(c.key) ? ON : OFF}`}
        >
          {labelFor(c.key)}
        </button>
      ))}
    </div>
  );
}
