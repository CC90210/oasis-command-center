/**
 * Empire cron_jobs row → the UI's CronJob shape.
 *
 * Extracted from app/api/cron-jobs/route.ts so it can be TESTED. It had none,
 * and it is where the Automations tab died for weeks with
 * "b.toUpperCase is not a function".
 *
 * THE BUG THIS FILE EXISTS TO PREVENT. The old code read:
 *
 *     const lastResult = row.last_result || "";
 *     const upper = lastResult.toUpperCase();
 *
 * which is correct against Postgres, where a text column returns text. Against
 * Turso it is not. lib/turso-postgrest.ts fromSql (:129-135) JSON-parses any
 * TEXT value that starts with `{` or `[`, so a last_result holding JSON arrives
 * as an OBJECT or ARRAY. `|| ""` only rejects falsy values, and `{}` and `[]`
 * are both truthy — so the wrong-typed value reached .toUpperCase() and threw.
 *
 * Four live jobs store JSON there (Inbound Email Sweep, Event Bus Offline
 * Drain, Review Harvest, Booking Reminders — the last one stores a bare `[]`).
 * Inbound Email Sweep runs every five minutes, which is why the board broke
 * constantly rather than occasionally.
 *
 * The rule for anything crossing the shim: never call a string method on a
 * value the database handed you without coercing it first. The TypeScript
 * annotation says `string | null`; the runtime disagrees, and the runtime wins.
 */

import { coerceInferResultText } from "./infer-result-text";

/** Shape as DECLARED. Field types are aspirational — see the note above. */
export type EmpireCronRow = {
  id: string;
  name: string;
  description: string | null;
  schedule: string;
  action_type: string | null;
  action_config: Record<string, unknown> | null;
  is_active: boolean;
  last_run_at: string | null;
  last_result: string | null;
  next_run_at: string | null;
  run_count: number | null;
  created_at: string;
};

/** Any value → string, without assuming the database kept its word. */
function asText(v: unknown): string {
  return coerceInferResultText(v);
}

/**
 * INTEGER → boolean. The Postgres→SQLite transpiler collapsed booleans into
 * INTEGER and fromSql never restores them, so `is_active` arrives as 0 or 1
 * while every consumer's type says boolean. `!job.enabled` on the number 0 is
 * accidentally right; on any other shape it is quietly wrong, and the toggle
 * is the whole point of this screen.
 */
export function asBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "t" || s === "1";
  }
  return false;
}

function asCount(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Infer the owning agent from the job name for UI grouping. Tenant scoping is
 * done by the query's tenant_id filter, never by this function.
 */
export function inferEmpireAgentKey(name: unknown, actionType: unknown): string {
  const n = asText(name).toLowerCase();
  const t = asText(actionType).toLowerCase();
  if (n.startsWith("atlas") || t.startsWith("atlas_")) return "atlas";
  if (n.startsWith("maven") || t.startsWith("maven_")) return "maven";
  if (n.startsWith("aura") || n.includes("pow wow") || t.startsWith("morning_powwow")) return "aura";
  return "bravo";
}

/**
 * last_result is free-form text written by scripts/scheduler.py. Observed:
 *   "ok" / "<stdout snippet>" / "stripe sync ok: ..."   → success
 *   "ERROR: <reason>" / "FAILED (exit N): <stderr>"     → error
 * Matched case-insensitively, prefix-only, so the UI tag mirrors what the
 * scheduler actually wrote. A JSON document (the shim hands us an object) is
 * serialized back to its stored form and treated as output, not as an error.
 */
export function classifyLastResult(raw: unknown): {
  text: string;
  status: "success" | "error" | null;
} {
  const text = asText(raw);
  if (!text) return { text, status: null };
  const upper = text.toUpperCase();
  const status = upper.startsWith("ERROR") || upper.startsWith("FAILED") ? "error" : "success";
  return { text, status };
}

export function normalizeEmpireRow(row: EmpireCronRow) {
  const { text: lastResult, status } = classifyLastResult(row.last_result);
  return {
    id: row.id,
    agent_key: inferEmpireAgentKey(row.name, row.action_type),
    name: asText(row.name),
    description: row.description,
    schedule: asText(row.schedule),
    action_type: row.action_type,
    action_payload: row.action_config || {},
    enabled: asBool(row.is_active),
    last_run_at: row.last_run_at,
    last_run_status: status,
    last_run_output: status === "success" ? lastResult : null,
    last_run_error: status === "error" ? lastResult : null,
    run_count: asCount(row.run_count),
    created_at: row.created_at,
    updated_at: row.created_at,
    source: "empire" as const,
  };
}
