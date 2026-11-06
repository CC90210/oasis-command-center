import { isValidCronExpr } from "./cron-grammar";

export const AUTOMATION_DEPARTMENTS = ["marketing", "sales", "operations", "finance", "customer_success", "executive"] as const;
export type AutomationDepartment = (typeof AUTOMATION_DEPARTMENTS)[number];
export const AUTOMATION_TRIGGERS = ["schedule", "event", "manual"] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];
export const GENERATED_SCRIPT_CAPABILITY = "generated_script_v1";

export type AutomationPipeline = {
  department: AutomationDepartment;
  objective: string;
  trigger_kind: AutomationTrigger;
  schedule_hint: string;
  input_parameters: string[];
  expected_outputs: string;
  connector_keys: string[];
  target_pairing_id: string;
};

export class AutomationPipelineError extends Error {
  constructor(public field: keyof AutomationPipeline | "pipeline", message: string) {
    super(message);
    this.name = "AutomationPipelineError";
  }
}

const CONNECTOR_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const PAIRING_ID = /^[A-Za-z0-9_-]{8,128}$/;

function text(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.trim().slice(0, max) : "";
}

export function parseAutomationPipeline(raw: unknown): AutomationPipeline {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AutomationPipelineError("pipeline", "Complete the four setup steps first.");
  const input = raw as Record<string, unknown>;
  const department = text(input.department, 40) as AutomationDepartment;
  if (!(AUTOMATION_DEPARTMENTS as readonly string[]).includes(department)) throw new AutomationPipelineError("department", "Choose a department.");
  const objective = text(input.objective, 2000);
  if (objective.length < 10) throw new AutomationPipelineError("objective", "Describe the workflow objective in at least one full sentence.");
  const triggerKind = text(input.trigger_kind, 20) as AutomationTrigger;
  if (!(AUTOMATION_TRIGGERS as readonly string[]).includes(triggerKind)) throw new AutomationPipelineError("trigger_kind", "Choose how the workflow starts.");
  const scheduleHint = text(input.schedule_hint, 120);
  if (triggerKind === "schedule" && !scheduleHint) throw new AutomationPipelineError("schedule_hint", "Add when the scheduled workflow should run.");
  if (scheduleHint && /^\S+(?:\s+\S+){4}$/.test(scheduleHint) && !isValidCronExpr(scheduleHint)) {
    throw new AutomationPipelineError("schedule_hint", "That cron schedule cannot be run by the connected scheduler.");
  }
  const inputParameters = Array.isArray(input.input_parameters)
    ? input.input_parameters.map((item) => text(item, 120)).filter(Boolean).slice(0, 20)
    : text(input.input_parameters, 1000).split(/[\n,]/).map((item) => item.trim().slice(0, 120)).filter(Boolean).slice(0, 20);
  const expectedOutputs = text(input.expected_outputs, 1000);
  if (expectedOutputs.length < 3) throw new AutomationPipelineError("expected_outputs", "Describe what the workflow should produce.");
  const connectorKeys = Array.isArray(input.connector_keys)
    ? Array.from(new Set(input.connector_keys.map((item) => text(item, 64).toUpperCase()).filter((item) => CONNECTOR_KEY.test(item)))).slice(0, 32)
    : [];
  const targetPairingId = text(input.target_pairing_id, 128);
  if (!PAIRING_ID.test(targetPairingId)) throw new AutomationPipelineError("target_pairing_id", "Choose an online target machine.");
  return {
    department,
    objective,
    trigger_kind: triggerKind,
    schedule_hint: scheduleHint,
    input_parameters: inputParameters,
    expected_outputs: expectedOutputs,
    connector_keys: connectorKeys,
    target_pairing_id: targetPairingId,
  };
}

const DEPARTMENT_CONNECTOR_HINTS: Readonly<Record<AutomationDepartment, readonly string[]>> = {
  marketing: ["HIGGSFIELD", "LATE", "META", "INSTAGRAM", "YOUTUBE", "SHOPIFY"],
  sales: ["GMAIL", "GOOGLE", "CALENDLY", "TWILIO", "TEXTTORRENT", "SHOPIFY", "STRIPE"],
  operations: ["N8N", "SLACK", "NOTION", "TURSO", "SHOPIFY"],
  finance: ["STRIPE", "WISE", "TURSO"],
  customer_success: ["GMAIL", "GOOGLE", "SLACK", "TWILIO", "SHOPIFY"],
  executive: ["TURSO", "GMAIL", "GOOGLE", "SLACK"],
};

/** Select only saved key names that the department or objective actually names. */
export function suggestConnectorKeys(department: AutomationDepartment, objective: string, savedKeys: readonly string[]): string[] {
  const haystack = objective.toUpperCase();
  const hints = DEPARTMENT_CONNECTOR_HINTS[department];
  return Array.from(new Set(savedKeys.map((key) => key.trim().toUpperCase()).filter((key) => {
    if (!CONNECTOR_KEY.test(key)) return false;
    return hints.some((hint) => key.includes(hint)) || key.split("_").some((part) => part.length > 3 && haystack.includes(part));
  }))).sort();
}

export function buildAutomationDescription(pipeline: AutomationPipeline): string {
  const trigger = pipeline.trigger_kind === "schedule"
    ? `Scheduled trigger: ${pipeline.schedule_hint}.`
    : pipeline.trigger_kind === "event"
      ? `Event trigger: poll safely for the event described in the objective; choose a conservative numeric cron schedule.`
      : "Manual trigger: create a paused script job with a conservative daily schedule until the operator changes it.";
  return [
    `Department: ${pipeline.department.replace("_", " ")}.`,
    `Workflow objective: ${pipeline.objective}`,
    trigger,
    `Input parameters: ${pipeline.input_parameters.length ? pipeline.input_parameters.join(", ") : "none"}.`,
    `Expected output: ${pipeline.expected_outputs}`,
    `Bound vault credential names: ${pipeline.connector_keys.length ? pipeline.connector_keys.join(", ") : "none"}. Never print or hardcode credential values.`,
  ].join("\n");
}

export type TargetMachineState = "online" | "idle" | "offline";
export function targetMachineState(lastSeenAt: string | null, nowMs = Date.now()): TargetMachineState {
  const seen = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  if (!Number.isFinite(seen) || seen > nowMs + 60_000 || nowMs - seen > 10 * 60_000) return "offline";
  return nowMs - seen <= 150_000 ? "online" : "idle";
}

export function machineToolCapabilities(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function targetMachineIsSelectable(machine: { revoked_at?: string | null; scope?: string | null; last_seen_at?: string | null; tool_capabilities?: unknown }, nowMs = Date.now()): boolean {
  return !machine.revoked_at
    && (machine.scope === null || machine.scope === undefined || machine.scope === "daemon")
    && targetMachineState(machine.last_seen_at ?? null, nowMs) !== "offline"
    && machineToolCapabilities(machine.tool_capabilities).includes(GENERATED_SCRIPT_CAPABILITY);
}
