"use client";

/**
 * The composer for a note or directive to an agent (Admin > Agent ops). The list
 * that used to sit beside it went with the /inbox page (2026-10-28): Agent ops
 * draws the notes itself, with what became of each.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Priority } from "@/lib/agent-inbox-types";

/** Who the composer offers when a page does not narrow it. */
const DEFAULT_RECIPIENTS = ["bravo", "atlas", "maven", "aura", "life-preservation", "codex", "broadcast"] as const;

export function AgentInboxComposer({
  recipients = DEFAULT_RECIPIENTS,
  submitLabel = "post message",
}: {
  /** The agents offered as recipients; the first is selected. The sender is always the operator (the route sets it). */
  recipients?: readonly string[];
  submitLabel?: string;
}) {
  const router = useRouter();
  const [to, setTo] = useState(recipients[0] ?? "bravo");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [requiresResponse, setRequiresResponse] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !body.trim()) {
      setError("subject + body required");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/inbox/post", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to,
          subject,
          body,
          priority,
          requires_response: requiresResponse,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) {
        setError(j.error || "post_failed");
        return;
      }
      setSubject("");
      setBody("");
      setRequiresResponse(false);
      startTransition(() => router.refresh());
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 flex-1 min-w-[140px]">
          <span className="text-[10px] uppercase tracking-wider text-fg-muted">to</span>
          <select
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="bg-bg-elev border border-bg-border rounded px-2 py-1.5 text-fg"
          >
            {recipients.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-fg-muted">priority</span>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
            className="bg-bg-elev border border-bg-border rounded px-2 py-1.5 text-fg"
          >
            <option value="urgent">urgent</option>
            <option value="high">high</option>
            <option value="normal">normal</option>
            <option value="low">low</option>
          </select>
        </label>
        <label className="flex items-end gap-2 pb-1.5">
          <input
            type="checkbox"
            checked={requiresResponse}
            onChange={(e) => setRequiresResponse(e.target.checked)}
            className="accent-accent"
          />
          <span className="text-xs text-fg-muted">needs reply</span>
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-fg-muted">subject</span>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={200}
          className="bg-bg-elev border border-bg-border rounded px-2 py-1.5 text-fg"
          placeholder="Brief subject"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-fg-muted">body</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          maxLength={8000}
          className="bg-bg-elev border border-bg-border rounded px-2 py-1.5 text-fg font-mono text-xs resize-y min-h-[100px]"
          placeholder="Body — markdown OK."
        />
      </label>
      {error && <div className="text-status-warm text-xs">{error}</div>}
      <button
        type="submit"
        disabled={submitting || pending}
        className="px-3 py-1.5 rounded bg-accent-soft border border-accent/30 text-accent text-xs font-bold uppercase tracking-wider hover:bg-accent/20 transition-colors disabled:opacity-50"
      >
        {submitting ? "sending…" : submitLabel}
      </button>
    </form>
  );
}
