"use client";

/**
 * StagePicker — one-click stage changer (Batch 6.1). Renders the current stage
 * as a colored badge; click → menu of the entity's pipeline stages; selecting
 * one POSTs /api/leads/[id]/set-stage and fires onChanged so the parent
 * (drawer / list) refreshes. Lead → LEAD_PIPELINE_STAGES; application →
 * OPPORTUNITY_PIPELINE_STAGES.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ChevronDown } from "lucide-react";
import { LEAD_PIPELINE_STAGES, OPPORTUNITY_PIPELINE_STAGES } from "@/lib/sunbiz-stage-meta";
import { stageChangeRequest } from "@/lib/leads/stage-change-request";

const DECLINED_STAGE = OPPORTUNITY_PIPELINE_STAGES.find((candidate) => candidate.key === "declined")!;

export function StagePicker({
  recordId,
  entity,
  currentStage,
  onChanged,
}: {
  recordId: string;
  entity: "lead" | "application";
  currentStage: string | null;
  onChanged?: (stage: string) => void | Promise<void>;
}) {
  const router = useRouter();
  // Declined is an application status, not a lead-board lane. Surface it only
  // inside the lead drawer as a cross-board action, immediately after Default.
  const stages = entity === "application"
    ? OPPORTUNITY_PIPELINE_STAGES
    : [...LEAD_PIPELINE_STAGES, DECLINED_STAGE];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(currentStage || "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const current = stages.find((s) => s.key === stage) || null;

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  async function pick(next: string) {
    setOpen(false);
    if (next === stage) return;
    if (entity === "lead" && next === "declined" && !window.confirm("Decline this lead? It moves to Applications › Declined.")) return;
    setBusy(true);
    try {
      const request = stageChangeRequest(entity, next);
      const endpoint = request.endpoint;
      const r = await fetch(`/api/leads/${recordId}/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(request.body),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        setStage(next);
        if (onChanged) await onChanged(next);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-[0.06em] whitespace-nowrap disabled:opacity-60"
        style={
          current
            ? { background: current.bg, color: current.fg }
            : { background: "#3a3a40", color: "#fff" }
        }
        title="Change stage"
      >
        {busy && <Loader2 className="w-3 h-3 animate-spin" />}
        {current?.label || stage || "Set stage"}
        <ChevronDown className="w-3 h-3 opacity-80" />
      </button>
      {open && (
        <ul className="absolute z-30 mt-1 max-h-72 min-w-[190px] overflow-y-auto rounded-md border border-bg-border bg-bg-elev shadow-lg">
          {stages.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  void pick(s.key);
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg hover:bg-accent/10 ${
                  s.key === stage ? "font-bold" : ""
                }`}
              >
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: s.bg }} />
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
