"use client";

/**
 * PersonEngineCard — "How your departments think" (O3b). Your OWN choice:
 * Claude Code on your own computer, or the workspace API key. Codex and
 * Gemini are listed but never selectable here: they are refused for
 * department work (lib/bridge-cli-policy.ts, lib/os/runs/session.ts), and
 * this card never offers a choice the gate would refuse.
 *
 * Reads/writes GET and PUT /api/agent-config/person-engine (self only).
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

type Facts = {
  choice: "computer" | "api" | null;
  effective: { source: "person" | "workspace"; kind?: string; engine?: { kind: string } };
  hasApprovedComputer: boolean;
  workspaceDefault: string | null;
  /** The workspace AI account can be chosen only where the workspace itself runs on it. */
  apiChoiceAllowed: boolean;
};

export function PersonEngineCard() {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch("/api/agent-config/person-engine");
      const j = await r.json();
      if (j.ok) setFacts(j as Facts);
      else setError(j.message || j.error || "load_failed");
    } catch (e) {
      setError(e instanceof Error ? e.message : "load_failed");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function choose(choice: "computer" | "api" | "default") {
    setSaving(true);
    setNotice(null);
    try {
      const r = await fetch("/api/agent-config/person-engine", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choice }),
      });
      const j = await r.json();
      if (!j.ok) setNotice(j.message || j.error || "Could not save. Try again.");
      else await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "save_failed");
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return <div className="text-sm text-status-warm">Couldn&apos;t check how your departments think just now. Refresh to try again.</div>;
  }
  if (!facts) {
    return (
      <div className="text-fg-dim text-sm flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> loading…
      </div>
    );
  }

  const selected: "computer" | "api" | "default" = facts.choice ?? "default";

  const Option = ({
    value,
    label,
    disabledReason,
    note,
  }: {
    value: "computer" | "api" | "default";
    label: string;
    disabledReason?: string | null;
    note?: string;
  }) => (
    <label className={`flex items-start gap-2 py-2 ${disabledReason ? "opacity-60" : "cursor-pointer"}`}>
      <input
        type="radio"
        name="person-engine"
        className="mt-1"
        checked={selected === value}
        disabled={saving || Boolean(disabledReason)}
        onChange={() => choose(value)}
      />
      <span>
        <span className="text-sm text-fg block">{label}</span>
        {disabledReason ? (
          <span className="text-[11px] text-fg-dim block">{disabledReason}</span>
        ) : note ? (
          <span className="text-[11px] text-fg-dim block">{note}</span>
        ) : null}
      </span>
    </label>
  );

  return (
    <div className="space-y-1">
      {notice && <div className="rounded-md border border-bg-border bg-bg-elev/40 p-3 text-xs text-fg-muted mb-2">{notice}</div>}
      <Option
        value="computer"
        label="My computer: Claude Code on your own computer"
        disabledReason={facts.hasApprovedComputer ? null : "Connect and approve your computer first."}
      />
      <Option
        value="api"
        label="Workspace API key"
        disabledReason={
          !facts.apiChoiceAllowed
            ? "This workspace runs department chats on each person's own computer, so its AI account isn't offered here."
            : facts.workspaceDefault
              ? null
              : "An owner or admin adds the workspace key in AI brain."
        }
      />
      <Option
        value="default"
        label={`Workspace default (currently: ${facts.workspaceDefault ?? "not set"})`}
        note="Members without a computer use the workspace API key."
      />
      <div className="text-[11px] text-fg-dim pt-2">
        Codex and Gemini are not used for department work: Codex can read your whole computer, and Gemini CLI cannot run on a personal sign-in.
      </div>
    </div>
  );
}
