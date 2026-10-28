"use client";

/**
 * components/tools/RecallTest.tsx - "Ask the agent to recall this", under one learned note.
 *
 * Posts the question to /api/admin/agent-training/recall, which runs the department's real turn and
 * says two things: whether this note was among the notes picked for the question (the agent reads the
 * notes that best match what it is asked; lib/os/training-notes.ts), and what the agent answered. A
 * note that was not picked is said plainly, with the words that would pick it.
 *
 * Collapsed by default (a details element), so a long list of notes stays a list.
 */
import { useState } from "react";

type Outcome =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; included: boolean; answer: string; runsOn: string }
  | { kind: "error"; message: string };

export function RecallTest({
  noteId,
  department,
  agentLabel,
  title,
  topTerms,
}: {
  noteId: string;
  department: string;
  agentLabel: string;
  title: string;
  topTerms: readonly string[];
}) {
  const [question, setQuestion] = useState(`What did you learn from "${title}"? Give me its main technique in two lines.`);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });

  async function ask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (outcome.kind === "running" || !question.trim()) return;
    setOutcome({ kind: "running" });
    try {
      const res = await fetch("/api/admin/agent-training/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note_id: noteId, department, question: question.trim() }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: true; included: boolean; answer: string; runsOn: string }
        | { ok: false; message?: string }
        | null;
      if (body && body.ok) {
        setOutcome({ kind: "done", included: body.included, answer: body.answer, runsOn: body.runsOn });
      } else {
        setOutcome({ kind: "error", message: body?.message || "The agent did not answer this time. Try again." });
      }
    } catch {
      setOutcome({ kind: "error", message: "Couldn't reach the server. Check your connection and try again." });
    }
  }

  return (
    <details className="group rounded-lg border border-bg-border bg-bg-deep/40">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-fg-muted hover:text-fg">
        Ask the {agentLabel} agent to recall this
      </summary>
      <form onSubmit={ask} className="space-y-2 px-3 pb-3">
        <label className="block text-[11px] text-fg-dim" htmlFor={`recall-${noteId}`}>
          Your question. The agent reads the notes that best match it.
        </label>
        <textarea
          id={`recall-${noteId}`}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={600}
          rows={2}
          className="input w-full text-sm"
        />
        <button type="submit" className="btn-secondary text-xs" disabled={outcome.kind === "running" || !question.trim()}>
          {outcome.kind === "running" ? "Asking…" : "Ask"}
        </button>
        {outcome.kind === "done" && (
          <div className="space-y-2" aria-live="polite">
            <p className={`text-xs ${outcome.included ? "text-fg" : "text-status-warm"}`}>
              {outcome.included
                ? "This note was in its instructions for this question."
                : `This note was not picked for this question, so the agent answered without it.${topTerms.length ? ` A question that mentions ${topTerms.slice(0, 3).join(", ")} picks it.` : ""}`}
            </p>
            <blockquote className="whitespace-pre-wrap rounded-md border border-bg-border bg-bg-panel px-3 py-2 text-sm text-fg">
              {outcome.answer}
            </blockquote>
            <p className="text-[11px] text-fg-dim">Answered on {outcome.runsOn}.</p>
          </div>
        )}
        {outcome.kind === "error" && (
          <p className="text-xs text-status-warm" aria-live="polite">
            {outcome.message}
          </p>
        )}
      </form>
    </details>
  );
}
