/**
 * lib/automations/guided/types.ts - the shapes of a guided automation.
 *
 * A guided automation is a TEMPLATE the person fills in (typed inputs, a schedule), saved as a
 * tenant_cron_jobs row with action_type "department_task" and this payload in action_payload.
 * Nothing here is free text that can steer the run: every input is a pick, a bounded number or a
 * short line, the tools are fixed by the template, the target is the cloud and the approval policy
 * is "proposal only" (the only write is an email draft waiting in Needs you).
 *
 * PURE. No server imports, no new dependency: the wizard (browser), the API, the dispatcher and the
 * tests all read these, and the Worker bundle is at 99% of its cap.
 */
import type { DepartmentKey } from "@/lib/os/types";
import type { DeskToolName } from "@/lib/os/desk/catalog";
import type { SchedulePlan } from "@/lib/automations/schedule-plan";

/** Bumped when the payload's shape changes; older rows are migrated, never guessed at. */
export const GUIDED_PAYLOAD_VERSION = 1;

/** The one action_type guided automations use (lib/automations/action-types.ts reserves it). */
export const GUIDED_ACTION_TYPE = "department_task";

/** What a run hands back: a short written digest, or email drafts that wait for a person's approval. */
export type GuidedOutput = "digest" | "email_drafts";

/** Where it runs. Cloud only: a connected computer would get the full chat palette (see the plan, section 8). */
export type GuidedTarget = { kind: "cloud" };

/** Nothing a guided automation does goes out without a person: drafts wait in Needs you. */
export type GuidedApproval = "proposal_only";

export type ChoiceField = {
  kind: "choice";
  name: string;
  label: string;
  help?: string;
  options: readonly { value: string; label: string }[];
  default: string;
};

export type NumberField = {
  kind: "number";
  name: string;
  label: string;
  help?: string;
  min: number;
  max: number;
  default: number;
  unit?: string;
};

/** A short single line: never a prompt. The longest any template allows is TEXT_FIELD_MAX. */
export type TextField = {
  kind: "text";
  name: string;
  label: string;
  help?: string;
  placeholder?: string;
  maxLength: number;
  default: string;
  /** The run reads it only as fenced data, never as an instruction. */
  required?: boolean;
};

export type InputField = ChoiceField | NumberField | TextField;

export type InputValues = Record<string, string | number>;

/** A plan without its zone (distributes over the union). */
type WithoutZone<T> = T extends { timezone: string } ? Omit<T, "timezone"> : never;

/**
 * A schedule the wizard offers as one tap. The zone is added when it is chosen (Toronto by default).
 * A raw custom cron is the Advanced composer's, not a guided preset.
 */
export type SchedulePreset = {
  id: string;
  label: string;
  plan: WithoutZone<Exclude<SchedulePlan, { mode: "custom" }>>;
};

export type GuidedTemplate = {
  /** Stable key, stored in the payload. Never reused for a different job. */
  id: string;
  /** Bumped when the template's instruction, tools or inputs change meaning. */
  version: number;
  department: DepartmentKey;
  title: string;
  /** One sentence in the person's words: what happens, on what. */
  promise: string;
  /** "Pipeline, leads and lead history": what it reads. */
  reads: string;
  /** What it will never do. Shown on the card and on Review. */
  never: string;
  /**
   * A short made-up example of what a run hands back, so a person sees the result before choosing.
   * Shown under "Example" and always labelled as made up: it is never workspace data.
   */
  example: string;
  /** The lookups it may use: fixed here, and a subset of the department's palette. */
  tools: readonly DeskToolName[];
  output: GuidedOutput;
  inputs: readonly InputField[];
  /** The first is the default. */
  schedulePresets: readonly SchedulePreset[];
  /** Connections-hub slugs (lib/os/connectors.ts) the job cannot do without. */
  requires: readonly string[];
  /** Company money: only a workspace whose viewer may see company financials can use it. */
  companyFinancialsOnly?: boolean;
  /** The run's time limit in seconds (driveAutomationRun refuses a run without one). */
  runtimeCapSec: number;
  /** The structured custom brief: the person picks the reads and writes one objective line. */
  custom?: boolean;
  /** The task message the run is given: the owner's inputs appear only as fenced data. */
  instruction: (inputs: InputValues) => string;
};

/** What is stored in tenant_cron_jobs.action_payload for a guided automation. */
export type GuidedPayload = {
  v: typeof GUIDED_PAYLOAD_VERSION;
  template: { id: string; version: number };
  department: DepartmentKey;
  inputs: InputValues;
  tools: DeskToolName[];
  output: GuidedOutput;
  target: GuidedTarget;
  approval: GuidedApproval;
  runtime_cap_sec: number;
  schedule: { plan: SchedulePlan };
};

/** Who is asking. Derived on the server from the session, never read from the body. */
export type GuidedContext = {
  /** May this person see company financials (the Finance department)? */
  companyFinancials: boolean;
};

export type GuidedErrorCode =
  | "payload_invalid"
  | "payload_unknown_key"
  | "payload_version_unsupported"
  | "template_unknown"
  | "template_version_unknown"
  | "template_not_available"
  | "department_mismatch"
  | "input_unknown"
  | "input_invalid"
  | "tools_invalid"
  | "output_invalid"
  | "target_invalid"
  | "schedule_invalid"
  | "schedule_too_frequent";

export type GuidedValidation =
  | { ok: true; payload: GuidedPayload }
  | { ok: false; error: GuidedErrorCode; message: string; field?: string };

/** The longest single-line input any template accepts. */
export const TEXT_FIELD_MAX = 400;
