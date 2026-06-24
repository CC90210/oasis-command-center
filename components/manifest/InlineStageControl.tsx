"use client";

/**
 * InlineStageControl — the clickable Stage cell on the Lead / Opportunity
 * Pipeline list (PipelineSearchableTable). CC 2026-06-23: operators wanted to
 * re-stage a record straight from the board instead of opening each lead.
 *
 * Click the badge → pick a stage → POST /api/leads/<id>/set-stage { stage, entity }.
 * Optimistic; reverts + alerts on failure (the API is owner/admin-gated and
 * fail-closed, so a non-permitted click cleanly bounces back). Options come from
 * the same stageMap the table already has (insertion order = pipeline order), so
 * no extra prop threading and the choices always match the API's valid stages.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { StageMeta } from "@/lib/sunbiz-stage-meta";

type Props = {
  recordId: string;
  stage: string;
  stageMap: Record<string, StageMeta>;
  /** "lead" | "application" — tells the API which field (stage vs status) to set. */
  entity: string;
  menuAlign?: "left" | "right";
};

export function InlineStageControl({ recordId, stage, stageMap, entity, menuAlign = "left" }: Props) {
  const router = useRouter();
  const [current, setCurrent] = useState(stage);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setCurrent(stage), [stage]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const options = Object.values(stageMap);
  const meta = stageMap[current];

  async function changeStage(key: string) {
    setOpen(false);
    if (key === current || pending) return;
    const prev = current;
    setPending(true);
    setCurrent(key); // optimistic
    try {
      const res = await fetch(`/api/leads/${recordId}/set-stage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stage: key, entity }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setCurrent(prev);
        alert(`Couldn't change stage: ${json?.error || res.status}`);
      } else {
        router.refresh();
      }
    } catch {
      setCurrent(prev);
      alert("Couldn't change stage — network error.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div ref={ref} className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={pending}
        onClick={() => setOpen((o) => !o)}
        title="Click to change stage"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold hover:ring-1 hover:ring-white/30 disabled:opacity-60 cursor-pointer"
        style={meta ? { background: meta.bg, color: meta.fg } : undefined}
      >
        <span>{meta ? meta.label : current || "—"}</span>
        <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true" className="opacity-70">
          <path d="M2 3l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </button>
      {open && (
        <div
          className={`absolute z-50 mt-1 min-w-[160px] max-h-64 overflow-auto rounded-md border border-bg-border bg-bg-deep shadow-xl py-1 ${
            menuAlign === "right" ? "right-0" : "left-0"
          }`}
        >
          {options.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => changeStage(s.key)}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] hover:bg-bg-elev/60 ${
                s.key === current ? "font-semibold" : ""
              }`}
            >
              <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ background: s.bg }} />
              <span className="text-fg">{s.label}</span>
              {s.key === current && <span className="ml-auto text-fg-dim">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
