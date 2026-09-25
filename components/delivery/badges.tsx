/**
 * Presentational tags for Projects + Tickets. No state, no data access — safe in
 * server and client components alike. Tones come from components/Card Tag so
 * the colours mean the same thing here as everywhere else in the app:
 * hot = needs action now, warm = watch it, engaged = done/healthy.
 */
import type { ReactNode } from "react";
import { Tag } from "@/components/Card";
import {
  PROJECT_STAGE_LABELS,
  TASK_STATUS_LABELS,
  TICKET_CATEGORY_LABELS,
  TICKET_SEVERITY_LABELS,
  TICKET_STATUS_LABELS,
  formatDuration,
  type ProjectStage,
  type SlaView,
  type TaskStatus,
  type TicketCategory,
  type TicketSeverity,
  type TicketStatus,
} from "@/lib/delivery/rules";

type Tone = "neutral" | "accent" | "hot" | "warm" | "engaged" | "info";

const STAGE_TONE: Record<ProjectStage, Tone> = {
  discovery: "info",
  building: "accent",
  review: "warm",
  live: "engaged",
  maintenance: "neutral",
  paused: "neutral",
};

export function StageTag({ stage }: { stage: ProjectStage }) {
  return <Tag tone={STAGE_TONE[stage] ?? "neutral"}>{PROJECT_STAGE_LABELS[stage] ?? stage}</Tag>;
}

const PRIORITY_TONE: Record<string, Tone> = { urgent: "hot", high: "warm", medium: "info", low: "neutral" };

export function PriorityTag({ priority }: { priority: string }) {
  return <Tag tone={PRIORITY_TONE[priority] ?? "neutral"}>{priority}</Tag>;
}

const SEVERITY_TONE: Record<TicketSeverity, Tone> = { critical: "hot", high: "warm", medium: "info", low: "neutral" };

export function SeverityTag({ severity }: { severity: TicketSeverity }) {
  return <Tag tone={SEVERITY_TONE[severity] ?? "neutral"}>{TICKET_SEVERITY_LABELS[severity] ?? severity}</Tag>;
}

const STATUS_TONE: Record<TicketStatus, Tone> = {
  open: "accent",
  in_progress: "info",
  waiting_on_client: "warm",
  resolved: "engaged",
  closed: "neutral",
};

export function TicketStatusTag({ status }: { status: TicketStatus }) {
  return <Tag tone={STATUS_TONE[status] ?? "neutral"}>{TICKET_STATUS_LABELS[status] ?? status}</Tag>;
}

export function CategoryTag({ category }: { category: TicketCategory }) {
  return <Tag>{TICKET_CATEGORY_LABELS[category] ?? category}</Tag>;
}

export function TaskStatusTag({ status }: { status: TaskStatus }) {
  const tone: Tone = status === "done" ? "engaged" : status === "blocked" ? "hot" : status === "in_progress" ? "info" : "neutral";
  return <Tag tone={tone}>{TASK_STATUS_LABELS[status] ?? status}</Tag>;
}

/** The first-response clock in one tag. */
export function SlaBadge({ sla }: { sla: SlaView }) {
  const m = sla.minutesRemaining ?? 0;
  switch (sla.state) {
    case "breached":
      return <Tag tone="hot">SLA breached · {formatDuration(m)} over</Tag>;
    case "at_risk":
      return <Tag tone="warm">Reply due in {formatDuration(m)}</Tag>;
    case "on_track":
      return <Tag>Reply due in {formatDuration(m)}</Tag>;
    case "responded":
      return <Tag tone="engaged">Responded</Tag>;
    case "responded_late":
      return <Tag tone="warm">Responded late</Tag>;
    default:
      return <Tag>No SLA</Tag>;
  }
}

/** A failure to load is shown as a failure — never as an empty list. */
export function LoadError({ what, detail }: { what: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-status-hot/40 bg-status-hot/5 px-5 py-4 text-sm">
      <div className="font-semibold text-status-hot">Could not load {what}.</div>
      <p className="mt-1 text-fg-muted">
        This is an error, not an empty list. It has been logged
        {detail ? <> — <span className="font-mono text-xs text-fg-dim break-all">{detail}</span></> : "."}
      </p>
    </div>
  );
}

/** Label + value row used on detail pages. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-dim">{label}</div>
      <div className="mt-1 text-sm text-fg break-words">{children}</div>
    </div>
  );
}
