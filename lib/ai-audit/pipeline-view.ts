/**
 * lib/ai-audit/pipeline-view.ts — the Free AI Audit drawn inside the one sales
 * pipeline (CC, 2026-10-28: the AI audits board and the Pipeline "need to be
 * merged and act as one").
 *
 * PURE: no I/O. The board groups each audit by the stage its lead is actually
 * in on the Pipeline (the lead's own row, never a stage the audit implies), so
 * both screens count the same deal in the same place, under the same name and
 * colour. The audit's step (lib/ai-audit/rules.ts) is shown inside it.
 */
import { OASIS_LEAD_STAGES, type StageMeta } from "@/lib/oasis-stage-meta";
import { OASIS_COLD_OUTBOUND_MOTION, OASIS_INBOUND_WARM_MOTION } from "@/lib/leads/canonical-lead-fields";
import { AI_AUDIT_STAGES, AI_AUDIT_STAGE_LABELS, type AiAuditStage } from "@/lib/ai-audit/rules";

/** The Pipeline's prospecting stages, before a founder meeting is booked: one column on the board. */
const BEFORE_MEETING_STAGES = new Set(["researched", "assigned", "attempting_contact", "connected", "qualified"]);
export const BEFORE_MEETING = "before_meeting";
/** An audit whose lead row is missing, or carries a stage the Pipeline does not have. */
export const NOT_ON_PIPELINE = "not_on_pipeline";

/** The columns every board draws, in the Pipeline's order; the rest appear only when an audit sits there. */
const ALWAYS: readonly string[] = [BEFORE_MEETING, "founder_meeting_booked", "demo_completed", "proposal_sent", "won", "onboarding", "in_build"];
const ORDER: readonly string[] = [...ALWAYS, "client_review", "launched", "lost", NOT_ON_PIPELINE];

const META = new Map<string, StageMeta>(OASIS_LEAD_STAGES.map((s) => [s.key, s]));

export type PipelineStep = { stage: AiAuditStage; label: string; count: number };
export type PipelineColumn = { key: string; label: string; bg: string; fg: string; count: number; steps: PipelineStep[] };

/** The board column a lead stage belongs to. */
export function pipelineColumnKey(leadStage: string | null): string {
  if (!leadStage) return NOT_ON_PIPELINE;
  if (BEFORE_MEETING_STAGES.has(leadStage)) return BEFORE_MEETING;
  return META.has(leadStage) ? leadStage : NOT_ON_PIPELINE;
}

/** A column's name and colour: the Pipeline's own for a real stage. */
export function pipelineColumnMeta(key: string): Pick<PipelineColumn, "label" | "bg" | "fg"> {
  if (key === BEFORE_MEETING) return { label: "Before the meeting", bg: "#5E6B82", fg: "#FFFFFF" };
  if (key === NOT_ON_PIPELINE) return { label: "Not on the Pipeline", bg: "#6F2D34", fg: "#FFFFFF" };
  const m = META.get(key);
  return m ? { label: m.label, bg: m.bg, fg: m.fg } : { label: key, bg: "#5E6B82", fg: "#FFFFFF" };
}

/** The Pipeline's name for a lead's stage, as the lead's own page shows it. */
export function pipelineStageLabel(leadStage: string | null): string {
  if (!leadStage) return "Not on the Pipeline";
  return META.get(leadStage)?.label ?? "Not on the Pipeline";
}

/** Which Pipeline queue the lead is in: "Warm inbound", "Cold outbound", or null when it carries neither. */
export function queueLabel(motion: unknown): string | null {
  if (motion === OASIS_INBOUND_WARM_MOTION) return "Warm inbound";
  if (motion === OASIS_COLD_OUTBOUND_MOTION) return "Cold outbound";
  return null;
}

/** The board's columns: each audit counted once, under its lead's Pipeline stage, with its step inside. */
export function pipelineColumns(rows: ReadonlyArray<{ stage: AiAuditStage; pipeline_stage: string | null }>): PipelineColumn[] {
  const cols = new Map<string, Map<AiAuditStage, number>>();
  for (const r of rows) {
    const key = pipelineColumnKey(r.pipeline_stage);
    const steps = cols.get(key) ?? new Map<AiAuditStage, number>();
    steps.set(r.stage, (steps.get(r.stage) ?? 0) + 1);
    cols.set(key, steps);
  }
  return ORDER.filter((key) => ALWAYS.includes(key) || cols.has(key)).map((key) => {
    const steps = cols.get(key) ?? new Map<AiAuditStage, number>();
    const list = AI_AUDIT_STAGES.filter((s) => steps.has(s)).map((s) => ({ stage: s, label: AI_AUDIT_STAGE_LABELS[s], count: steps.get(s)! }));
    return { key, ...pipelineColumnMeta(key), count: list.reduce((n, s) => n + s.count, 0), steps: list };
  });
}
