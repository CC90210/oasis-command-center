"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type LifecycleAction = {
  type:
    | "manual_outreach_started"
    | "discovery_call_scheduled"
    | "lead_qualified"
    | "proposal_sent"
    | "proposal_viewed"
    | "contract_signed"
    | "onboarding_complete"
    | "lead_replied_negative"
    | "contract_ended"
    | "manual_archive";
  label: string;
  from: Set<string>;
  /** Plain-English explanation of what this action means, surfaced in
   *  the title attribute on enabled buttons so operators don't have
   *  to guess what they're about to fire. */
  description: string;
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

const ARCHIVABLE_STAGES = new Set([
  "new_contact",
  "outreach",
  "discovery",
  "qualified",
  "proposal",
  "negotiation",
  "onboarding",
  "active_client",
  "churned",
  "lost",
]);

const ACTIONS: LifecycleAction[] = [
  {
    type: "manual_outreach_started",
    label: "Outreach started",
    from: new Set(["new_contact"]),
    description: "I reached out to this lead (phone, DM, in person). Advance to Outreach.",
  },
  {
    type: "discovery_call_scheduled",
    label: "Discovery scheduled",
    from: new Set(["outreach"]),
    description: "Discovery call is on the books. Advance to Discovery.",
  },
  {
    type: "lead_qualified",
    label: "Mark qualified",
    from: new Set(["outreach", "discovery"]),
    description: "Lead is a real fit (right ICP, budget, intent). Advance to Qualified.",
  },
  {
    type: "proposal_sent",
    label: "Proposal sent",
    from: new Set(["qualified", "discovery"]),
    description: "Proposal/SOW delivered. Advance to Proposal.",
  },
  {
    type: "proposal_viewed",
    label: "Proposal viewed",
    from: new Set(["proposal"]),
    description: "Lead opened / clicked the proposal. Advance to Negotiation.",
  },
  {
    type: "contract_signed",
    label: "Contract signed",
    from: new Set(["proposal", "negotiation"]),
    description: "Contract executed. Advance to Onboarding.",
  },
  {
    type: "onboarding_complete",
    label: "Onboarding complete",
    from: new Set(["onboarding"]),
    description: "Kickoff done, first deliverable shipped. Advance to Active client (counts toward MRR).",
  },
  {
    type: "lead_replied_negative",
    label: "Mark lost",
    from: ACTIVE_STAGES,
    description: "Lead said no / wrong fit / ghosted permanently. Move to Lost.",
  },
  {
    type: "contract_ended",
    label: "Contract ended",
    from: new Set(["active_client"]),
    description: "Retainer ended or churned client. Move to Churned (drops MRR).",
  },
  {
    type: "manual_archive",
    label: "Move to archived",
    from: ARCHIVABLE_STAGES,
    description: "Hide this lead from active views. Use for cleanup of stale rows (e.g. a lost lead that's still cluttering active_client).",
  },
];

/**
 * Plain-English summary of which stage(s) gate an action. Used by the
 * disabled-button tooltip so an operator who sees "Discovery scheduled"
 * greyed out gets "Available from Outreach" instead of an opaque hint.
 */
function stageGate(action: LifecycleAction): string {
  const stages = Array.from(action.from)
    .map((s) => s.replace(/_/g, " "))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  if (stages.length === 0) return "Disabled";
  if (stages.length === 1) return `Available from ${stages[0]}`;
  if (stages.length <= 3) return `Available from ${stages.join(", ")}`;
  return `Available from ${stages.slice(0, 2).join(", ")} +${stages.length - 2} more`;
}

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
          // Tooltip strategy — enabled buttons show the plain-English
          // description of what firing does. Disabled buttons show
          // which stage(s) the action becomes available from, so the
          // operator understands the gate instead of guessing.
          const titleText = enabled
            ? action.description
            : stageGate(action);
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
              title={titleText}
            >
              {busyType === action.type ? "Working..." : action.label}
            </button>
          );
        })}
      </div>
      <div className="mt-2 text-[10px] text-fg-dim leading-relaxed">
        Hover any action for what it does. Greyed-out actions show which
        stage they become available from. Current stage:{" "}
        <span className="text-fg-muted font-medium">{currentStage.replace(/_/g, " ")}</span>.
      </div>
    </div>
  );
}
