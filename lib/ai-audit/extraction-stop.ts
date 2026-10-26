/**
 * lib/ai-audit/extraction-stop.ts — calling off a profile draft that is still
 * running: its step, and every window still out on the Mac, whose answer, if
 * it comes, finds the lease gone and is never stored. Window results already
 * in are cleared too: nothing a stopped run read stays behind.
 *
 * A leaf module (it imports nothing of the AI audit), so the writes that must
 * stop a run do it inside their own transaction without importing the
 * extraction runner, which imports them (review of phase 2b, F5): Gate 1's
 * freeze, a declined or cancelled engagement, the client's "no" to AI
 * analysis, a transcript without that consent, and a deleted transcript.
 *
 * PURE: builds statements; runs nothing.
 */
import type { InStatement } from "@libsql/client";

/** The step key of a profile draft run. */
export const EXTRACT_STEP = "extract";
/** The system runner tool a Mac window runs as. */
export const MODEL_TOOL_KEY = "ai_audit_model";

const STOP_JOB = `UPDATE tool_jobs SET
      status = CASE WHEN status IN ('queued', 'claimed', 'running') THEN 'failed' ELSE status END,
      error_code = CASE WHEN status IN ('queued', 'claimed', 'running') THEN 'ai_audit_cancelled' ELSE error_code END,
      finished_at = CASE WHEN status IN ('queued', 'claimed', 'running') THEN ? ELSE finished_at END,
      result_json = CASE WHEN result_json IS NULL THEN NULL ELSE '{"stored":false}' END, updated_at = ?`;

/** One run, by its step. The step's update comes first, so a caller may require that it changed a row. */
export function closeRunStatements(t: string, stepId: string, code: string, at: string): InStatement[] {
  return [
    {
      sql: "UPDATE ai_audit_steps SET status = 'cancelled', error_code = ?, result_ref = NULL, finished_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('queued', 'running', 'waiting_runner')",
      args: [code, at, at, t, stepId],
    },
    { sql: `${STOP_JOB} WHERE tenant_id = ? AND tool_key = ? AND json_extract(input_json, '$.step_id') = ?`, args: [at, at, t, MODEL_TOOL_KEY, stepId] },
  ];
}

/** Every run of an engagement that is still going, and every window job it sent. */
export function stopEngagementRunsStatements(t: string, engagementId: string, code: string, at: string): InStatement[] {
  return [
    {
      sql: `UPDATE ai_audit_steps SET status = 'cancelled', error_code = ?, result_ref = NULL, finished_at = ?, updated_at = ?
             WHERE tenant_id = ? AND engagement_id = ? AND step_key = ? AND status IN ('queued', 'running', 'waiting_runner')`,
      args: [code, at, at, t, engagementId, EXTRACT_STEP],
    },
    { sql: `${STOP_JOB} WHERE tenant_id = ? AND tool_key = ? AND json_extract(input_json, '$.engagement_id') = ?`, args: [at, at, t, MODEL_TOOL_KEY, engagementId] },
  ];
}
