"use client";

/**
 * components/automations/guided/RunHistory.tsx - "Recent runs" on one automation's card.
 *
 * A closed disclosure that, when opened, reads the last runs of this automation (scheduled runs and
 * tests) and lets a person open any one as a receipt: what it looked up, what it wrote, and why it
 * stopped if it did. Everything shown is the server's, already redacted; this component states nothing
 * it was not told. It reads again when the automation's last run changes (a test just finished).
 */
import { useEffect, useRef, useState } from "react";
import type { GuidedApi, RunHistoryItem, RunReceipt } from "@/lib/automations/guided/api-types";
import { instantText, runStatusLabel } from "@/lib/automations/guided/view";
import { Notice, TAP } from "./ui";

type Loaded<T> = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: T };

export function RunHistory({ api, automationId, refreshKey }: { api: GuidedApi; automationId: string; refreshKey: string }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<Loaded<RunHistoryItem[]>>({ kind: "idle" });
  const [picked, setPicked] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Loaded<RunReceipt>>({ kind: "idle" });
  const latest = useRef(0);
  const latestReceipt = useRef(0);
  const seenKey = useRef(refreshKey);

  function load() {
    const token = ++latest.current;
    setRuns({ kind: "loading" });
    void api.runs(automationId).then((out) => {
      if (token !== latest.current) return;
      setRuns(out.ok ? { kind: "ready", data: out.runs } : { kind: "error", message: out.message });
    });
  }

  // A test just finished (the card's last run changed): read the list again if it is open.
  useEffect(() => {
    if (seenKey.current === refreshKey) return;
    seenKey.current = refreshKey;
    if (open) load();
  });

  function show(runId: string) {
    if (picked === runId) {
      setPicked(null);
      return;
    }
    setPicked(runId);
    setReceipt({ kind: "loading" });
    // Only the answer for the run opened last is shown: an earlier, slower answer is dropped.
    const token = ++latestReceipt.current;
    void api.receipt(automationId, runId).then((out) => {
      if (token !== latestReceipt.current) return;
      setReceipt(out.ok ? { kind: "ready", data: out.receipt } : { kind: "error", message: out.message });
    });
  }

  return (
    <details
      className="mt-3 border-t border-hairline pt-3"
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(next);
        if (next) load();
      }}
    >
      <summary className={`cursor-pointer text-sm font-medium text-fg ${TAP} flex items-center`}>Recent runs</summary>
      <div className="mt-2 space-y-2" aria-live="polite">
        {runs.kind === "loading" && <p className="text-sm text-fg-muted">Loading its runs...</p>}
        {runs.kind === "error" && <Notice tone="error">{runs.message}</Notice>}
        {runs.kind === "ready" && runs.data.length === 0 && <p className="text-sm text-fg-muted">It has not run yet. Press Test now to see what a run looks like.</p>}
        {runs.kind === "ready" && runs.data.length > 0 && (
          <ul className="space-y-2">
            {runs.data.map((r) => (
              <li key={r.id} className="rounded-lg border border-hairline bg-bg-deep">
                <button
                  type="button"
                  className={`flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 text-left text-sm ${TAP}`}
                  aria-expanded={picked === r.id}
                  onClick={() => show(r.id)}
                >
                  <span className="font-medium text-fg">{runStatusLabel(r.status)}</span>
                  <span className="text-fg-muted">{instantText(r.at) ?? "Time unknown"}</span>
                  <span className="rounded border border-hairline bg-bg-elev px-1.5 py-0.5 text-xs font-medium text-fg-muted">{r.origin === "test" ? "Preview" : "Scheduled"}</span>
                  <span className="w-full break-words text-fg-muted">{r.summary}</span>
                </button>
                {picked === r.id && (
                  <div className="space-y-2 border-t border-hairline px-3 py-3">
                    {receipt.kind === "loading" && <p className="text-sm text-fg-muted">Loading the receipt...</p>}
                    {receipt.kind === "error" && <Notice tone="error">{receipt.message}</Notice>}
                    {receipt.kind === "ready" && <ReceiptView receipt={receipt.data} />}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function ReceiptView({ receipt }: { receipt: RunReceipt }) {
  return (
    <div className="space-y-3">
      {receipt.failure && <Notice tone="error">{receipt.failure}</Notice>}
      <div>
        <p className="text-sm font-medium text-fg">What it looked up</p>
        {receipt.steps.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing was looked up.</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {receipt.steps.map((step, i) => (
              <li key={`${step.label}-${i}`} className="text-sm text-fg-muted">
                {step.label}
                {step.ok === false && <span className="ml-2 text-fg">(could not be read)</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {receipt.text.trim() && (
        <div>
          <p className="text-sm font-medium text-fg">What it wrote</p>
          <div className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-hairline bg-bg-panel p-3 text-sm leading-relaxed text-fg">{receipt.text.trim()}</div>
        </div>
      )}
      {receipt.origin === "test" && <p className="text-xs font-medium text-fg-muted">Preview only. Nothing was sent or filed.</p>}
    </div>
  );
}
