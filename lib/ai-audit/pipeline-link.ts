/**
 * lib/ai-audit/pipeline-link.ts — the two halves of one deal, read for the
 * other's screen: each audit's lead as the Pipeline has it (stage and queue),
 * and each Pipeline row's open audit (its step). See lib/ai-audit/pipeline-view.ts.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import { AI_AUDIT_STAGE_LABELS, type AiAuditStage } from "@/lib/ai-audit/rules";
import { aiAuditTablesInstalled, requireTenant } from "@/lib/ai-audit/store";

export type LeadOnPipeline = { stage: string | null; motion: string | null };

const CHUNK = 200;

function chunks(ids: readonly string[]): string[][] {
  const unique = [...new Set(ids.filter(Boolean))];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK) out.push(unique.slice(i, i + CHUNK));
  return out;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Each lead's Pipeline stage and queue. A lead with no row is left out of the map. */
export async function leadsOnPipeline(db: Client, tenantId: string, leadIds: readonly string[]): Promise<Map<string, LeadOnPipeline>> {
  const t = requireTenant(tenantId);
  const out = new Map<string, LeadOnPipeline>();
  for (const ids of chunks(leadIds)) {
    const rs = await db.execute({
      sql: `SELECT id, json_extract(data, '$.stage') AS stage, json_extract(data, '$.sales_motion') AS motion
              FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' AND id IN (${ids.map(() => "?").join(", ")})`,
      args: [t, ...ids],
    });
    for (const r of rs.rows) out.set(String(r.id), { stage: text(r.stage), motion: text(r.motion) });
  }
  return out;
}

/**
 * Which of these engagements ever had an audit delivered, or an audit email
 * whose fate was uncertain (the mail server stopped answering after taking it):
 * ai_audit_events "delivered" or "delivery_unknown", revisions included.
 */
export async function everDelivered(db: Client, tenantId: string, engagementIds: readonly string[]): Promise<Set<string>> {
  const t = requireTenant(tenantId);
  const out = new Set<string>();
  for (const ids of chunks(engagementIds)) {
    const rs = await db.execute({
      sql: `SELECT DISTINCT engagement_id FROM ai_audit_events
             WHERE tenant_id = ? AND event IN ('delivered', 'delivery_unknown') AND engagement_id IN (${ids.map(() => "?").join(", ")})`,
      args: [t, ...ids],
    });
    for (const r of rs.rows) out.add(String(r.engagement_id));
  }
  return out;
}

export type OpenAudit = { engagementId: string; stage: AiAuditStage };

/** The open audit on each of these leads (one per lead at most: the one-open-per-lead index). */
export async function openAuditsForLeads(db: Client, tenantId: string, leadIds: readonly string[]): Promise<Map<string, OpenAudit>> {
  const t = requireTenant(tenantId);
  const out = new Map<string, OpenAudit>();
  for (const ids of chunks(leadIds)) {
    const rs = await db.execute({
      sql: `SELECT id, lead_id, stage FROM ai_audit_engagements
             WHERE tenant_id = ? AND closed_at IS NULL AND lead_id IN (${ids.map(() => "?").join(", ")})`,
      args: [t, ...ids],
    });
    for (const r of rs.rows) out.set(String(r.lead_id), { engagementId: String(r.id), stage: String(r.stage) as AiAuditStage });
  }
  return out;
}

/**
 * The open audit's step on each of these Pipeline leads, for the founders who
 * can open the audit (lib/ai-audit/access.ts). Anyone else, another workspace,
 * or before the audit tables exist: an empty map. A failed read is logged and
 * answers an empty map, so the Pipeline draws its rows without the step rather
 * than not at all.
 */
export async function auditStepsForLeads(
  leadIds: readonly string[],
  viewer: { tenantId: string; isTrueAdmin: boolean },
): Promise<Map<string, OpenAudit>> {
  if (!viewer.isTrueAdmin || !isOasisInternalTenant(viewer.tenantId) || !tursoConfigured() || leadIds.length === 0) return new Map();
  try {
    const db = getTursoClient();
    if (!(await aiAuditTablesInstalled(db))) return new Map();
    return await openAuditsForLeads(db, viewer.tenantId, leadIds);
  } catch (err) {
    console.error("[ai-audit.pipeline-link] the Pipeline's audit steps could not be read; the rows are drawn without them", err instanceof Error ? (err.stack ?? err.message) : String(err));
    return new Map();
  }
}

/** The rows, each lead with an open audit carrying its step: data.ai_audit_step (the step's name) and data.ai_audit_engagement_id. */
export function withAuditSteps<T extends { id: string; data: Record<string, unknown> }>(rows: T[], audits: ReadonlyMap<string, OpenAudit>): T[] {
  if (audits.size === 0) return rows;
  return rows.map((r) => {
    const a = audits.get(r.id);
    return a ? { ...r, data: { ...r.data, ai_audit_step: AI_AUDIT_STAGE_LABELS[a.stage] ?? a.stage, ai_audit_engagement_id: a.engagementId } } : r;
  });
}
