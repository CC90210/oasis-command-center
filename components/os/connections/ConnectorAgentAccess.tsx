"use client";

/**
 * ConnectorAgentAccess - the "Used by" section of an app's drawer, now a
 * choice. CC, 2026-10-26: every app has its own use and its own agents, and the
 * built-in apps come with the agents we already know they serve.
 *
 * The suggestion is the catalog's "Used by" departments plus the Chief of
 * Staff (lib/os/agent-access.ts connectorDefaultAccess). An owner can change it
 * and put it back. An agent the app is not given is not offered the app's
 * agent tools (APP_TOOLS); an app no agent tool uses yet says so, so the choice
 * never claims to do more than it does (review of OCC #743). A saved choice
 * that cannot be read is shown as such and can be saved again. Someone who
 * cannot manage the workspace sees the suggestion, labelled as one.
 */

import { useEffect, useState } from "react";
import { AgentPicker } from "@/components/os/connections/AgentPicker";
import {
  AGENT_ACCESS_CHANGED_EVENT,
  AGENT_CHOICES,
  agentAccessLabel,
  agentToolsOf,
  connectorDefaultAccess,
  sameAgentAccess,
  type AgentAccess,
  type AgentChoice,
} from "@/lib/os/agent-access";
import type { DepartmentKey } from "@/lib/os/types";

type Loaded = { access: AgentAccess | null; saved: boolean; suggested: AgentAccess; unreadable?: boolean };

export function ConnectorAgentAccess({ slug, departments }: { slug: string; departments: readonly DepartmentKey[] }) {
  const suggested = connectorDefaultAccess({ departments });
  const tools = agentToolsOf(slug);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The workspace's agents by name ("Maven (Marketing)"), from the route.
  const [choices, setChoices] = useState<ReadonlyArray<AgentChoice>>(AGENT_CHOICES);
  const [readOnly, setReadOnly] = useState(false);
  const [draft, setDraft] = useState<AgentAccess>(suggested);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await fetch("/api/connections/agents", { cache: "no-store" });
        if (r.status === 401 || r.status === 403) {
          if (live) setReadOnly(true);
          return;
        }
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; connectors?: Record<string, Loaded>; choices?: AgentChoice[] };
        if (live && Array.isArray(j.choices) && j.choices.length > 0) setChoices(j.choices);
        const mine = j.connectors?.[slug];
        if (!r.ok || !j.ok || !mine) throw new Error("not_loaded");
        if (!live) return;
        setLoaded(mine);
        setDraft(mine.access ?? connectorDefaultAccess({ departments }));
        if (mine.access === null) {
          setNote({ tone: "bad", text: "The saved choice could not be read, so no agent gets this app's tools. Pick agents and save to fix it." });
        }
      } catch {
        if (live) setNote({ tone: "bad", text: "Couldn't read which agents use this app. The suggestion is shown." });
      }
    })();
    return () => {
      live = false;
    };
    // `departments` is the card's catalog list: the same array for the life of the card.
  }, [slug, departments]);

  async function save(agents: AgentAccess | null) {
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch("/api/connections/agents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "connector", id: slug, agents }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; access?: AgentAccess; saved?: boolean; error?: string };
      if (!r.ok || !j.ok || !j.access) {
        setNote({ tone: "bad", text: `Not saved (${j.error || `HTTP ${r.status}`}).` });
        return;
      }
      setLoaded({ access: j.access, saved: !!j.saved, suggested });
      setDraft(j.access);
      setNote({ tone: "ok", text: agents === null ? "Back to the suggested agents." : "Saved." });
      // Every card on the page reads its agents again.
      window.dispatchEvent(new CustomEvent(AGENT_ACCESS_CHANGED_EVENT));
    } catch {
      setNote({ tone: "bad", text: "Not saved: the server could not be reached." });
    } finally {
      setBusy(false);
    }
  }

  if (readOnly) {
    return <p className="text-[12.5px] text-fg-muted">Suggested: {agentAccessLabel(suggested)}. An owner can change this.</p>;
  }
  const current = loaded ? loaded.access : suggested;
  const changed = current === null || !sameAgentAccess(draft, current);
  return (
    <div className="space-y-2" data-testid="connector-agent-access">
      <AgentPicker value={draft} onChange={setDraft} disabled={busy || !loaded} label="Agents that use this app" choices={choices} />
      <p className="text-[11.5px] leading-4 text-fg-dim">
        {loaded?.saved && loaded.access !== null ? "Your choice." : "Suggested: the agents this app is built for, plus the Chief of Staff."}{" "}
        {tools
          ? `Only these agents are offered ${tools}.`
          : "No agent tool uses this app yet; your choice applies to any that does."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {changed && loaded && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void save(draft)}
            className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-bg hover:bg-accent-muted disabled:opacity-50"
          >
            {busy ? "Saving" : "Save agents"}
          </button>
        )}
        {loaded?.saved && !changed && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void save(null)}
            className="rounded-md border border-hairline px-3 py-1 text-[12px] text-fg-muted hover:text-fg disabled:opacity-50"
          >
            Use the suggested agents
          </button>
        )}
        {note && (
          <span role="status" className={`text-[12px] ${note.tone === "ok" ? "text-status-engaged" : "text-status-hot"}`}>
            {note.text}
          </span>
        )}
      </div>
    </div>
  );
}
