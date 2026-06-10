"use client";

/**
 * DerivedCcList — Adon spec section 2.3 (2026-06-10).
 *
 * Renders the derived agent CC list (the intersection of the
 * application's rep fields × agents.config.json) as a checkbox group.
 * All entries are pre-checked. The operator can uncheck to exclude an
 * agent for this run. There is NO way to add an email from the UI — the
 * config file is the only source of valid CC addresses.
 *
 * Parent owns the selection state; this component is purely presentational
 * so the parent's confirm-modal can read the same array without prop
 * threading hell.
 */

import { useId } from "react";

export type DerivedAgentEntry = {
  /** "jordan" / "alex" / "matt" — stable key from agents.config.json. */
  key: string;
  /** Display name on the checkbox label. */
  name: string;
  /** Email — the actual value the parent persists in cc_emails. */
  email: string;
};

type Props = {
  derived: DerivedAgentEntry[];
  /** Current set of checked emails. Parent controls this. */
  checkedEmails: string[];
  /** Called when any checkbox flips. New checked-emails array passed in. */
  onChange: (checked: string[]) => void;
  /** Optional — disable the whole group while a run is in flight. */
  disabled?: boolean;
};

export default function DerivedCcList({
  derived,
  checkedEmails,
  onChange,
  disabled = false,
}: Props) {
  const baseId = useId();
  const checkedSet = new Set(checkedEmails.map((e) => e.trim().toLowerCase()));

  if (derived.length === 0) {
    return (
      <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-400">
        <div className="font-medium text-zinc-300">No agents derived from this deal.</div>
        <div className="mt-1 text-xs">
          The email will still send — signed by{" "}
          <span className="font-mono text-zinc-200">SunBiz Submissions</span>{" "}
          with no agent on CC. To add an agent, set <span className="font-mono">assigned_rep_email</span>{" "}
          (or another rep field) on the application to a roster entry from{" "}
          <span className="font-mono">agents.config.json</span>.
        </div>
      </div>
    );
  }

  return (
    <fieldset
      className="rounded-md border border-zinc-800 bg-zinc-950/40 p-4"
      disabled={disabled}
    >
      <legend className="px-1 text-xs uppercase tracking-wide text-zinc-400">
        Agent CC list (derived from deal)
      </legend>
      <div className="mt-2 grid gap-2">
        {derived.map((agent) => {
          const id = `${baseId}-${agent.key}`;
          const isChecked = checkedSet.has(agent.email.trim().toLowerCase());
          return (
            <label
              key={agent.key}
              htmlFor={id}
              className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm text-zinc-200 hover:bg-zinc-900/60"
            >
              <input
                id={id}
                type="checkbox"
                className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500/40"
                checked={isChecked}
                disabled={disabled}
                onChange={(e) => {
                  const targetEmail = agent.email.trim().toLowerCase();
                  if (e.target.checked) {
                    if (!checkedSet.has(targetEmail)) {
                      onChange([...checkedEmails, agent.email]);
                    }
                  } else {
                    onChange(
                      checkedEmails.filter(
                        (em) => em.trim().toLowerCase() !== targetEmail,
                      ),
                    );
                  }
                }}
              />
              <span className="font-medium">{agent.name}</span>
              <span className="ml-auto font-mono text-xs text-zinc-500">
                {agent.email}
              </span>
            </label>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        Only agents in <span className="font-mono">agents.config.json</span>{" "}
        appear here. To add a new agent, edit that file at the repo root —
        UI cannot bypass the config.
      </p>
    </fieldset>
  );
}
