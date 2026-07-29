"use client";

import { useCallback, useEffect, useState } from "react";

type Draft = {
  id: string;
  original_text: string;
  intent: string;
  confidence: number | null;
  agent_display_name: string;
  automation_paused: boolean;
};

export function SunbizDraftCard({ threadKey }: { threadKey: string }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setNotice(null);
    try {
      const res = await fetch(`/api/conversations/drafts?thread_key=${encodeURIComponent(threadKey)}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "draft_lookup_failed");
      const next = (body?.draft || null) as Draft | null;
      setDraft(next);
      setText(next?.original_text || "");
    } catch {
      setDraft(null);
      setNotice("Couldn’t load the automated draft.");
    }
  }, [threadKey]);

  useEffect(() => { void load(); }, [load]);

  async function act(action: "approve" | "edit_send" | "reject" | "pause" | "resume") {
    if (!draft || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/conversations/drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "edit_send" ? { action, message: text } : { action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "action_failed");
      if (action === "pause" || action === "resume") {
        setDraft((current) => current ? { ...current, automation_paused: action === "pause" } : current);
        setNotice(action === "pause" ? "Automation paused." : "Automation resumed.");
      } else {
        setDraft(null);
        setNotice(action === "reject" ? "Draft rejected." : "Reply approved and queued.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message.replaceAll("_", " ") : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!draft && !notice) return null;
  return (
    <section className="shrink-0 border-y border-amber-400/30 bg-amber-400/5 px-4 py-3" aria-label="SunBiz automated reply draft">
      {draft ? (
        <>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-amber-200">Reply awaiting approval</p>
              <p className="text-[11px] text-fg-muted">
                {draft.agent_display_name} · {draft.intent}
                {draft.confidence != null ? ` · ${Math.round(draft.confidence * 100)}% confidence` : ""}
              </p>
            </div>
            <button type="button" disabled={busy} onClick={() => void act(draft.automation_paused ? "resume" : "pause")}
              className="rounded border border-bg-border px-2 py-1 text-[11px] text-fg-muted hover:text-fg disabled:opacity-50">
              {draft.automation_paused ? "Resume automation" : "Pause automation"}
            </button>
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1600} rows={3}
            className="w-full resize-y rounded-lg border border-bg-border bg-bg-panel px-3 py-2 text-sm text-fg outline-none focus:border-amber-400/60" />
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={busy || draft.automation_paused} onClick={() => void act("approve")}
              className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Approve</button>
            <button type="button" disabled={busy || draft.automation_paused || !text.trim()} onClick={() => void act("edit_send")}
              className="rounded bg-amber-500 px-3 py-1.5 text-xs font-medium text-black disabled:opacity-50">Approve edited</button>
            <button type="button" disabled={busy} onClick={() => void act("reject")}
              className="rounded border border-bg-border px-3 py-1.5 text-xs text-fg-muted hover:text-fg disabled:opacity-50">Reject</button>
          </div>
        </>
      ) : null}
      {notice ? <p className="mt-2 text-xs text-fg-muted">{notice}</p> : null}
    </section>
  );
}
