"use client";

import { useEffect, useRef, useState } from "react";
import type { StageMeta } from "@/lib/sunbiz-stage-meta";

type NoteRow = {
  id: string;
  content_preview: string | null;
  created_at: string | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * Hover popover for a pipeline deal row: shows the current stage + the manual
 * notes (from /api/leads/[id]/notes) without a click. Fixed-positioned +
 * pointer-events-none so it can't be clipped by scroll containers and never
 * intercepts the row's click. Notes are fetched lazily on first mount (the row
 * only mounts this after a 250ms hover dwell, so quick passes don't fetch).
 */
export function DealHoverCard({
  leadId,
  entity,
  stage,
  anchor,
}: {
  leadId: string;
  entity: "lead" | "application";
  stage: StageMeta;
  anchor: { left: number; top: number };
}) {
  const [notes, setNotes] = useState<NoteRow[] | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "err">("loading");
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const q = entity === "application" ? "?entity=application" : "";
    fetch(`/api/leads/${leadId}/notes${q}`)
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok) {
          setNotes(Array.isArray(j.notes) ? j.notes : []);
          setState("ok");
        } else {
          setState("err");
        }
      })
      .catch(() => setState("err"));
  }, [leadId, entity]);

  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const left = Math.max(8, Math.min(anchor.left, vw - 336));

  return (
    <div
      className="pointer-events-none fixed z-[60] w-80 rounded-lg border border-bg-border bg-bg-panel p-3 text-[11px] shadow-2xl"
      style={{ left, top: anchor.top + 4 }}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className="rounded px-2 py-0.5 text-[10px] font-semibold"
          style={{ background: stage.bg, color: stage.fg }}
        >
          {stage.label}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-dim">Notes</span>
      </div>
      {state === "loading" ? (
        <div className="text-fg-dim">Loading notes…</div>
      ) : state === "err" ? (
        <div className="text-red-300">Couldn&apos;t load notes</div>
      ) : !notes?.length ? (
        <div className="text-fg-dim">No notes added yet</div>
      ) : (
        <ul className="max-h-64 space-y-1.5 overflow-hidden">
          {notes.slice(0, 6).map((n) => (
            <li key={n.id} className="border-b border-bg-border/40 pb-1 last:border-b-0">
              <div className="whitespace-pre-wrap break-words text-fg-muted">
                {n.content_preview || "(empty note)"}
              </div>
              <div className="mt-0.5 text-[9px] text-fg-dim">{metaLine(n)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function metaLine(n: NoteRow): string {
  const author =
    n.metadata && typeof n.metadata.author_email === "string" ? String(n.metadata.author_email) : "";
  const when = n.created_at ? new Date(n.created_at).toLocaleDateString() : "";
  return [author, when].filter(Boolean).join(" · ");
}
