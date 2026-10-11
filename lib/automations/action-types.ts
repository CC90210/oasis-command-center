/**
 * What a tenant_cron_jobs row IS, by its action_type.
 *
 * Two kinds of row will share that table:
 *
 *   SCRIPT jobs, the only kind that exists today. The local bridge daemon pulls
 *   them through GET /api/cron-jobs/poll and runs them on the paired machine
 *   (CEO-Agent bravo_cli/cron_runner.py _DISPATCHERS).
 *
 *   DEPARTMENT TASKS (the Automations guided setup): standing instructions a
 *   department runs on the server, under its owner's identity. The bridge must
 *   never see one. Today's poll served every enabled row of any type, and the
 *   runner stamps "unknown action_type" over any row it cannot dispatch, so a
 *   department task reaching it would be overwritten with a false error every
 *   minute it matched. And the old /api/cron-jobs editor must never touch one:
 *   its writes bypass the signed brief, the owner checks and the audit trail.
 *
 * SCRIPT_ACTION_TYPES is an ALLOWLIST on purpose. The poll filters with
 * `.in("action_type", SCRIPT_ACTION_TYPES)`, not `.neq("action_type",
 * DEPARTMENT_TASK)`, so any type added later reaches the bridge only when it is
 * named here. `agent_prompt` is not here: the runner only stubs it with an
 * error (cron_runner.py _exec_agent_prompt), and the create route stopped
 * accepting it long ago.
 *
 * No imports: client components and route handlers can both read this.
 */

export const SCRIPT_ACTION_TYPES = ["script_run", "snapshot_run", "webhook_post"] as const;
export type ScriptActionType = (typeof SCRIPT_ACTION_TYPES)[number];

export const DEPARTMENT_TASK = "department_task" as const;

export function isScriptActionType(value: unknown): value is ScriptActionType {
  return typeof value === "string" && (SCRIPT_ACTION_TYPES as readonly string[]).includes(value);
}

export function isDepartmentTask(value: unknown): boolean {
  return value === DEPARTMENT_TASK;
}
