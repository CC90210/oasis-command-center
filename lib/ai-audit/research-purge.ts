/**
 * lib/ai-audit/research-purge.ts — stored research goes when the
 * authorization behind it does (review of phase 3, F4).
 *
 * A research run (ai_audit_research, bravo__243) holds the profile's answers
 * as CC authorized them at Gate 1. When that authorization stops holding, the
 * runs built on it are deleted, so none of what the client said outlives the
 * authorization in research:
 *   - a transcript deleted after Gate 1: in the same transaction as the delete
 *     (lib/ai-audit/transcripts.ts deleteTranscript);
 *   - the engagement moved back to correct the profile, declined or
 *     cancelled: in the same write as the move (lib/ai-audit/store.ts
 *     moveStage), with the tick's sweep as the backstop (lib/ai-audit/tick.ts);
 *   - a run stored while its authorization was being voided: taken back by
 *     the run itself (lib/ai-audit/research.ts), and by the tick's sweep.
 * Research runs again after CC authorizes again. A run is never edited (its
 * trigger refuses UPDATE); it is only ever deleted whole.
 *
 * Kept apart from lib/ai-audit/research.ts so the transcript store can use it
 * without importing research (which imports the authorization, which imports
 * the transcript store).
 */
import type { Client, InStatement } from "@libsql/client";
import { PROFILE_EDIT_STAGES, TERMINAL_STAGES } from "@/lib/ai-audit/rules";

export async function researchTablesInstalled(db: Client): Promise<boolean> {
  try {
    await db.execute("SELECT (SELECT COUNT(*) FROM ai_audit_research WHERE 0) AS r, (SELECT COUNT(*) FROM ai_audit_assumptions WHERE 0) AS a");
    return true;
  } catch (err) {
    if (/no such table|no such column/i.test(err instanceof Error ? err.message : String(err))) return false;
    throw err;
  }
}

/** The statements that delete an engagement's stored research runs. */
export function researchPurgeStatements(tenantId: string, engagementId: string): InStatement[] {
  return [{ sql: "DELETE FROM ai_audit_research WHERE tenant_id = ? AND engagement_id = ?", args: [tenantId, engagementId] }];
}

/** The runs of engagements moved back before Gate 1, declined or cancelled: deleted. Answers how many. */
export async function purgeVoidedResearch(db: Client, tenantId: string): Promise<number> {
  const stages = [...PROFILE_EDIT_STAGES, ...TERMINAL_STAGES];
  const r = await db.execute({
    sql: `DELETE FROM ai_audit_research WHERE tenant_id = ? AND engagement_id IN
            (SELECT id FROM ai_audit_engagements WHERE tenant_id = ? AND stage IN (${stages.map(() => "?").join(", ")}))
          AND (COALESCE(CASE WHEN json_valid(content) THEN json_extract(content, '$.schema') END, '') <> 'ai_audit_preflight/v1'
            OR engagement_id IN (SELECT id FROM ai_audit_engagements WHERE tenant_id = ? AND stage IN (${TERMINAL_STAGES.map(() => "?").join(", ")})))`,
    args: [tenantId, tenantId, ...stages, tenantId, ...TERMINAL_STAGES],
  });
  return r.rowsAffected;
}
