/**
 * Workflow Step Registry — V6.9.2 substrate.
 *
 * Pattern import from twentyhq/twenty (AGPLv3 — patterns only).
 * Every workflow step is a typed handler with a common interface; the
 * dispatcher in run-step.ts looks up the handler by type. Adding a new
 * step type means a new file in this directory + one line in the
 * dispatcher's REGISTRY — never edits to existing step code.
 */

export type StepStatus = "pending" | "running" | "complete" | "failed";

export type StepContext = {
  /** Tenant uuid the workflow belongs to. */
  tenant_id: string;
  /** workflow_runs.id — the current run id, for cross-step audit. */
  run_id: string;
  /** workflow_runs.trigger_event — what fired this run (record id, user, etc). */
  trigger_event: Record<string, unknown>;
  /** Outputs of preceding steps, keyed by step id. Step inputs can reference these. */
  prior_outputs: Record<string, unknown>;
  /** Per-run step cap (default 100). Prevents runaway loops. */
  step_count_remaining: number;
  /** Operator-overridable cap for mail-sender + send_gateway-routed steps. */
  outbound_cap_remaining: number;
};

export type StepResult =
  | { status: "complete"; output: unknown }
  | { status: "failed"; error: string };

export type WorkflowStep = {
  type: string;
  execute: (input: unknown, ctx: StepContext) => Promise<StepResult>;
};

export type TriggerType = "manual" | "record_mutation" | "cron" | "webhook";

export type ManualTrigger = {
  type: "manual";
  /** Optional set of agent roles that can fire this manually. */
  allowed_roles?: string[];
};

export type RecordMutationTrigger = {
  type: "record_mutation";
  /** object_metadata.slug to watch. */
  object_slug: string;
  /** Which mutation kinds fire this trigger. */
  events: Array<"created" | "updated" | "deleted">;
};

export type CronTrigger = {
  type: "cron";
  /** Crontab expression in tenant-local timezone. */
  cron: string;
};

export type WebhookTrigger = {
  type: "webhook";
  /** Generated path token: POST /api/workflows/<slug>/webhook?token=<token>. */
  token: string;
};

export type Trigger = ManualTrigger | RecordMutationTrigger | CronTrigger | WebhookTrigger;

export type WorkflowDefinition = {
  steps: WorkflowStepDef[];
};

export type WorkflowStepDef = {
  id: string;
  type: string;
  input: Record<string, unknown>;
  /** Optional next-step override on error; default = abort run. */
  on_error?: "abort" | "continue";
};
