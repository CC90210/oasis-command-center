"use client";

/**
 * ConnectorAgentAccess - the "Used by" section of an app's drawer, now a
 * choice. CC, 2026-10-26: every app has its own use and its own agents, and the
 * built-in apps come with the agents we already know they serve.
 *
 * The suggestion is the catalog's "Used by" departments plus the Chief of
 * Staff (lib/os/agent-access.ts connectorDefaultAccess). An owner can change it
 * and put it back. An agent the app is not given is not offered the app's tools
 * (lib/cloud-tool-runner.ts TOOL_CONNECTOR). Someone who cannot manage the
 * workspace sees the agents without the controls.
 */

import { useEffect, useState } from "react";
import { AgentPicker } from "@/components/os/connections/AgentPicker";
import { agentAccessLabel, connectorDefaultAccess, sameAgentAccess, type AgentAccess } from "@/lib/os/agent-access";
import type { DepartmentKey } from "@/lib/os/types";

type Loaded = { access: AgentAccess; saved: boolean; suggested: AgentAccess };

export function ConnectorAgentAccess({ slug, departments }: { slug: string; departments: readonly DepartmentKey[] }) {
  const suggested = connectorDefaultAccess({ departments });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
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
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; connectors?: Record<string, Loaded> };
        const mine = j.connectors?.[slug];
        if (!r.ok || !j.ok || !mine) throw new Error("not_loaded");
        if (!live) return;
        setLoaded(mine);
        setDraft(mine.access);
      } catch {
        if (live) setNote({ tone: "bad", text: "Couldn't read which agents use this app. The suggestion is shown." });
      }
    })();
    return () => {
      live = false;
    };
  }, [slug]);

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
    } catch {
      setNote({ tone: "bad", text: "Not saved: the server could not be reached." });
    } finally {
      setBusy(false);
    }
  }

  if (readOnly) {
    return <p className="text-[12.5px] text-fg-muted">{agentAccessLabel(suggested)}</p>;
  }
  const current = loaded?.access ?? suggested;
  const changed = !sameAgentAccess(draft, current);
  return (
    <div className="space-y-2" data-testid="connector-agent-access">
      <AgentPicker value={draft} onChange={setDraft} disabled={busy || !loaded} label="Agents that use this app" />
      <p className="text-[11.5px] leading-4 text-fg-dim">
        {loaded?.saved ? "Your choice." : "Suggested: the agents this app is built for, plus the Chief of Staff."} Only
        these agents are given the app&apos;s tools.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {changed && (
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
