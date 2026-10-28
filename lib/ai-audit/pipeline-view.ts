/**
 * lib/ai-audit/pipeline-view.ts — the Free AI Audit drawn inside the one sales
 * pipeline (CC, 2026-10-28: the AI audits board and the Pipeline "need to be
 * merged and act as one").
 *
 * PURE: no I/O. The board's columns are the Pipeline's own stages, counted from
 * the Pipeline's own deals (lib/ai-audit/pipeline-deals.ts reads them with the
 * Pipeline page's query), so both screens show the same numbers under the same
 * names and colours. Inside each column: the audits there, by step
 * (lib/ai-audit/rules.ts), and the deals with no audit yet.
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

/**
 * Where an audit belongs and a deal can still be missing one: the founder meeting to the proposal, before a sale.
 * A won or delivered deal either closed its audit (an active client closes it) or was sold without one, so
 * "No audit yet" is never counted there (Codex review of #763).
 */
export const AUDIT_STAGES: ReadonlySet<string> = new Set(["founder_meeting_booked", "demo_completed", "proposal_sent"]);

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

export type PipelineQueue = "warm" | "cold";

/** Which Pipeline queue a lead's sales_motion puts it in, or null when it carries neither. */
export function queueKey(motion: unknown): PipelineQueue | null {
  if (motion === OASIS_INBOUND_WARM_MOTION) return "warm";
  if (motion === OASIS_COLD_OUTBOUND_MOTION) return "cold";
  return null;
}

/** Which Pipeline queue the lead is in: "Warm inbound", "Cold outbound", or null when it carries neither. */
export function queueLabel(motion: unknown): string | null {
  const q = queueKey(motion);
  return q === "warm" ? "Warm inbound" : q === "cold" ? "Cold outbound" : null;
}

export type BoardColumn = PipelineColumn & {
  /** The Pipeline's deals in this column, by queue (count is their sum). */
  warm: number;
  cold: number;
  /** Deals here with no open audit, in the AUDIT_STAGES columns only: never before the meeting, or after a sale. */
  noAudit: number;
};

/**
 * The board's columns. Counts are the Pipeline's (`counts`, per queue and
 * stage); `deals` is every deal those counts are made of, with its open audit,
 * so the steps and "No audit yet" inside each column are exact. Open audits
 * whose lead is on neither queue get a "Not on the Pipeline" column of their
 * own, so they are never counted as Pipeline deals.
 */
export function boardColumns(input: {
  counts: Record<PipelineQueue, Record<string, number>>;
  deals: ReadonlyArray<{ stage: string; audit: { stage: AiAuditStage } | null }>;
  offPipeline: ReadonlyArray<{ stage: AiAuditStage }>;
}): BoardColumn[] {
  const byQueue = (q: PipelineQueue) => {
    const m = new Map<string, number>();
    for (const [stage, n] of Object.entries(input.counts[q])) {
      const key = pipelineColumnKey(stage);
      m.set(key, (m.get(key) ?? 0) + n);
    }
    return m;
  };
  const warm = byQueue("warm");
  const cold = byQueue("cold");
  const steps = new Map<string, Map<AiAuditStage, number>>();
  const unaudited = new Map<string, number>();
  const add = (key: string, stage: AiAuditStage) => {
    const m = steps.get(key) ?? new Map<AiAuditStage, number>();
    m.set(stage, (m.get(stage) ?? 0) + 1);
    steps.set(key, m);
  };
  for (const d of input.deals) {
    const key = pipelineColumnKey(d.stage);
    if (d.audit) add(key, d.audit.stage);
    else if (AUDIT_STAGES.has(d.stage)) unaudited.set(key, (unaudited.get(key) ?? 0) + 1);
  }
  for (const a of input.offPipeline) add(NOT_ON_PIPELINE, a.stage);
  return ORDER.map((key) => {
    const off = key === NOT_ON_PIPELINE;
    const w = off ? 0 : (warm.get(key) ?? 0);
    const c = off ? 0 : (cold.get(key) ?? 0);
    const st = steps.get(key) ?? new Map<AiAuditStage, number>();
    const list = AI_AUDIT_STAGES.filter((s) => st.has(s)).map((s) => ({ stage: s, label: AI_AUDIT_STAGE_LABELS[s], count: st.get(s)! }));
    return { key, ...pipelineColumnMeta(key), count: off ? input.offPipeline.length : w + c, warm: w, cold: c, noAudit: unaudited.get(key) ?? 0, steps: list };
  }).filter((col) => ALWAYS.includes(col.key) || col.count > 0);
}
