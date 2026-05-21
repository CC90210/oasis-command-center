"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type LifecycleAction = {
  type:
    | "discovery_call_scheduled"
    | "lead_qualified"
    | "proposal_sent"
    | "proposal_viewed"
    | "contract_signed"
    | "onboarding_complete"
    | "lead_replied_negative"
    | "contract_ended";
  label: string;
  from: Set<string>;
};

const ACTIVE_STAGES = new Set([
  "new_contact",
  "outreach",
  "discovery",
  "qualified",
  "proposal",
  "negotiation",
  "onboarding",
  "active_client",
]);

const ACTIONS: LifecycleAction[] = [
  { type: "discovery_call_scheduled", label: "Discovery scheduled", from: new Set(["outreach"]) },
  { type: "lead_qualified", label: "Mark qualified", from: new Set(["outreach", "discovery"]) },
  { type: "proposal_sent", label: "Proposal sent", from: new Set(["qualified", "discovery"]) },
  { type: "proposal_viewed", label: "Proposal viewed", from: new Set(["proposal"]) },
  { type: "contract_signed", label: "Contract signed", from: new Set(["proposal", "negotiation"]) },
  { type: "onboarding_complete", label: "Onboarding complete", from: new Set(["onboarding"]) },
  { type: "lead_replied_negative", label: "Mark lost", from: ACTIVE_STAGES },
  { type: "contract_ended", label: "Contract ended", from: new Set(["active_client"]) },
];

export function LeadLifecycleActions({
  leadId,
  currentStage,
}: {
  leadId: string;
  currentStage: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [busyType, setBusyType] = useState<string | null>(null);

  async function fire(type: LifecycleAction["type"]) {
    setBusyType(type);
    setMessage(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/stage-event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const data = await res.json().catch(() => null) as {
        ok?: boolean;
        fired?: boolean;
        to?: string;
        reason?: string;
        error?: string;
      } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `stage_event_${res.status}`);
      }
      if (data.fired && data.to) setMessage(`Stage advanced to ${data.to.replace(/_/g, " ")}.`);
      else setMessage(`No stage change: ${String(data.reason || "rule did not apply").replace(/_/g, " ")}.`);
      startTransition(() => router.refresh());
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "stage event failed");
    } finally {
      setBusyType(null);
    }
  }

  return (
    <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-xs font-bold uppercase tracking-wider text-fg-muted">
          Lifecycle actions
        </div>
        {message && <div className="text-[11px] text-fg-dim">{message}</div>}
      </div>
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map((action) => {
          const enabled = action.from.has(currentStage);
          return (
            <button
              key={action.type}
              type="button"
              disabled={!enabled || isPending || busyType !== null}
              onClick={() => fire(action.type)}
              className={
                enabled
                  ? "btn-secondary !px-3 !py-1.5 text-xs"
                  : "rounded-md border border-bg-border bg-bg-deep/30 px-3 py-1.5 text-xs text-fg-dim cursor-not-allowed opacity-60"
              }
              title={enabled ? action.label : `Only applies from ${Array.from(action.from).join(", ")}`}
            >
              {busyType === action.type ? "Working..." : action.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
