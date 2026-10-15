/**
 * lib/automations/guided/validate.ts - turn a request body into a payload that is safe to store and run.
 *
 * The browser proposes {template, department, inputs, output, schedule}. Everything that decides what
 * a run may DO is the server's, recomputed here and never read back from the body: the tools (the
 * template's list, or for the custom brief the person's ticked reads inside the department's palette),
 * the target (cloud), the approval policy (proposal only) and the time limit. The result is the payload
 * to store, with the template's current version and only its own fields.
 *
 * Fails closed with a stable error code and a sentence a person can act on: an unknown key, an unknown
 * template or version, an input that is not what the template declares, a tool outside the allowed set,
 * a schedule that runs too often. A hand-written validator: zod is not a dependency (it alone is ~443 KiB
 * of Worker bundle, see ci.yml).
 *
 * PURE. No server imports: the wizard can call it to show the same refusal the API would give.
 */
import { DEPARTMENT_PALETTES, type DeskToolName } from "@/lib/os/desk/catalog";
import type { DepartmentKey } from "@/lib/os/types";
import { minGapOver7Days, planToCron, validatePlan, type SchedulePlan } from "@/lib/automations/schedule-plan";
import { defaultInputs, readToolsFor, templateById } from "./templates";
import {
  GUIDED_PAYLOAD_VERSION,
  TEXT_FIELD_MAX,
  type GuidedContext,
  type GuidedErrorCode,
  type GuidedOutput,
  type GuidedPayload,
  type GuidedTemplate,
  type GuidedValidation,
  type InputValues,
} from "./types";

export const GUIDED_ZONE = "America/Toronto";

/** The shortest gap between two runs a schedule may have, by output: a digest costs a model call, drafts cost more and wait on a person. */
export const MIN_GAP_MINUTES: Readonly<Record<GuidedOutput, number>> = { digest: 60, email_drafts: 720 };

const TOP_KEYS = new Set(["v", "template", "department", "inputs", "tools", "output", "target", "approval", "runtime_cap_sec", "schedule"]);

function refuse(error: GuidedErrorCode, message: string, field?: string): GuidedValidation {
  return field ? { ok: false, error, message, field } : { ok: false, error, message };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);

/** Any control character. Built from code points: this file never carries a backslash-u escape. */
export function hasControlChars(text: string): boolean {
  return CONTROL.test(text);
}

/** One input value, checked against its declaration. Returns the clean value or an error sentence. */
function checkInput(template: GuidedTemplate, name: string, raw: unknown): { ok: true; value: string | number } | { ok: false; message: string } {
  const field = template.inputs.find((f) => f.name === name);
  if (!field) return { ok: false, message: "That setting does not exist on this template." };
  if (field.kind === "choice") {
    if (typeof raw === "string" && field.options.some((o) => o.value === raw)) return { ok: true, value: raw };
    return { ok: false, message: `Pick one of the choices for "${field.label}".` };
  }
  if (field.kind === "number") {
    const n = typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+$/.test(raw.trim()) ? Number(raw) : NaN;
    if (Number.isInteger(n) && n >= field.min && n <= field.max) return { ok: true, value: n };
    return { ok: false, message: `"${field.label}" must be a whole number from ${field.min} to ${field.max}.` };
  }
  if (typeof raw !== "string") return { ok: false, message: `"${field.label}" must be text.` };
  const text = raw.trim();
  if (CONTROL.test(text)) return { ok: false, message: `"${field.label}" must be a single line of plain text.` };
  if (text.length > Math.min(field.maxLength, TEXT_FIELD_MAX)) {
    return { ok: false, message: `"${field.label}" can be at most ${Math.min(field.maxLength, TEXT_FIELD_MAX)} characters.` };
  }
  if (field.required && text.length < 5) return { ok: false, message: `Tell us a little more in "${field.label}" (at least 5 characters).` };
  return { ok: true, value: text };
}

/** The tools a stored payload may use: the template's own, or for the custom brief the ticked reads inside the palette. */
function resolveTools(template: GuidedTemplate, department: DepartmentKey, output: GuidedOutput, raw: unknown): { ok: true; tools: DeskToolName[] } | { ok: false; message: string } {
  if (!template.custom) return { ok: true, tools: [...template.tools] };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 12) return { ok: false, message: "Tick at least one thing it may read." };
  const allowed = new Set<DeskToolName>(readToolsFor(department));
  const picked: DeskToolName[] = [];
  for (const t of raw) {
    // A stored drafts payload already ends in the draft tool this function appends below, so the
    // payload it returned reads back as valid. For a digest that name is still not a read: refused.
    if (output === "email_drafts" && t === "propose_email") continue;
    if (typeof t !== "string" || !allowed.has(t as DeskToolName)) return { ok: false, message: "One of the ticked reads is not available in this department." };
    if (!picked.includes(t as DeskToolName)) picked.push(t as DeskToolName);
  }
  if (picked.length === 0) return { ok: false, message: "Tick at least one thing it may read." };
  if (output === "email_drafts") {
    if (!(DEPARTMENT_PALETTES[department] ?? []).includes("propose_email")) {
      return { ok: false, message: "This department cannot draft emails." };
    }
    picked.push("propose_email");
  }
  return { ok: true, tools: picked };
}

/**
 * Validate a guided payload from a request body and return the one to store.
 * `ctx` comes from the session, never the body.
 */
export function validateGuidedPayload(raw: unknown, ctx: GuidedContext): GuidedValidation {
  if (!isObject(raw)) return refuse("payload_invalid", "The automation is missing or is not in a form this page can read.");
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) return refuse("payload_unknown_key", "The automation has a setting this page does not know.", key);
  }
  if (raw.v !== GUIDED_PAYLOAD_VERSION) return refuse("payload_version_unsupported", "This automation was made with a version this page cannot run. Rebuild it from a template.");

  const tpl = raw.template;
  if (!isObject(tpl) || typeof tpl.id !== "string" || typeof tpl.version !== "number") return refuse("template_unknown", "Pick a template.", "template");
  const department = raw.department;
  const template = typeof department === "string" ? templateById(tpl.id, department as DepartmentKey) : null;
  if (!template) return refuse("template_unknown", "That template does not exist for this department.", "template");
  if (department !== template.department) return refuse("department_mismatch", "That template belongs to a different department.", "department");
  if (tpl.version !== template.version) return refuse("template_version_unknown", "That template has changed since this automation was made. Rebuild it from the template.", "template");
  if (template.companyFinancialsOnly && !ctx.companyFinancials) return refuse("template_not_available", "That template is not available to you.", "template");

  const output = template.custom ? raw.output : template.output;
  if (output !== "digest" && output !== "email_drafts") return refuse("output_invalid", "Choose whether the result is a written digest or email drafts for approval.", "output");
  if (!template.custom && raw.output !== undefined && raw.output !== template.output) {
    return refuse("output_invalid", "This template's result type cannot be changed.", "output");
  }

  // Inputs: only the template's own fields; a missing one takes its default.
  const given = raw.inputs === undefined ? {} : raw.inputs;
  if (!isObject(given)) return refuse("input_invalid", "The settings are not in a form this page can read.", "inputs");
  const inputs: InputValues = defaultInputs(template);
  for (const [name, value] of Object.entries(given)) {
    if (!template.inputs.some((f) => f.name === name)) return refuse("input_unknown", "A setting was sent that this template does not have.", name);
    const checked = checkInput(template, name, value);
    if (!checked.ok) return refuse("input_invalid", checked.message, name);
    inputs[name] = checked.value;
  }
  for (const field of template.inputs) {
    if (field.kind === "text" && field.required) {
      const checked = checkInput(template, field.name, inputs[field.name]);
      if (!checked.ok) return refuse("input_invalid", checked.message, field.name);
    }
  }

  // Tools: server-owned. The body's list is read only for the custom brief's ticked reads.
  const tools = resolveTools(template, template.department, output, raw.tools);
  if (!tools.ok) return refuse("tools_invalid", tools.message, "tools");
  if (!template.custom && raw.tools !== undefined && JSON.stringify(raw.tools) !== JSON.stringify(template.tools)) {
    return refuse("tools_invalid", "A template's lookups cannot be changed.", "tools");
  }

  // Target, approval, time limit: fixed. A body that asks for anything else is refused, not corrected.
  if (raw.target !== undefined && !(isObject(raw.target) && raw.target.kind === "cloud" && Object.keys(raw.target).length === 1)) {
    return refuse("target_invalid", "Guided automations run in the cloud.", "target");
  }
  if (raw.approval !== undefined && raw.approval !== "proposal_only") return refuse("target_invalid", "Guided automations only ever draft for approval.", "approval");
  if (raw.runtime_cap_sec !== undefined && raw.runtime_cap_sec !== template.runtimeCapSec) {
    return refuse("target_invalid", "The time limit is set by the template.", "runtime_cap_sec");
  }

  // Schedule: the schedule library's own validator, then the guided rules (no raw cron, not too often).
  const sched = raw.schedule;
  const planInput = isObject(sched) ? sched.plan : undefined;
  const plan = validatePlan(isObject(planInput) && planInput.timezone === undefined ? { ...planInput, timezone: GUIDED_ZONE } : planInput);
  if (!plan.ok) return refuse("schedule_invalid", plan.message, "schedule");
  if (plan.plan.mode === "custom") return refuse("schedule_invalid", "Pick one of the schedules offered. A custom schedule is in Advanced.", "schedule");
  if (plan.plan.mode === "manual" && output === "email_drafts") {
    // A run the person starts is always a preview that files nothing, so a drafts automation with no schedule could never file a draft.
    return refuse("schedule_invalid", "Email drafts need a schedule. A run you start yourself only previews them and files nothing, so pick a time.", "schedule");
  }
  const tooFrequent = checkFrequency(plan.plan, output);
  if (tooFrequent) return refuse("schedule_too_frequent", tooFrequent, "schedule");

  const payload: GuidedPayload = {
    v: GUIDED_PAYLOAD_VERSION,
    template: { id: template.id, version: template.version },
    department: template.department,
    inputs,
    tools: tools.tools,
    output,
    target: { kind: "cloud" },
    approval: "proposal_only",
    runtime_cap_sec: template.runtimeCapSec,
    schedule: { plan: plan.plan },
  };
  return { ok: true, payload };
}

function checkFrequency(plan: SchedulePlan, output: GuidedOutput): string | null {
  if (plan.mode === "manual") return null;
  const gap = minGapOver7Days(planToCron(plan), plan.timezone, Date.now());
  // null means the cron or zone was refused: fail closed, never "fine".
  if (gap === null) return "That schedule could not be read. Pick one of the schedules offered.";
  const need = MIN_GAP_MINUTES[output];
  if (gap < need) {
    return output === "email_drafts"
      ? "Email drafts can run at most twice a day, so a person can keep up with approving them."
      : "A digest can run at most once an hour.";
  }
  return null;
}

/** The connections a payload cannot run without (Connections-hub slugs). */
export function requiredConnectors(payload: Pick<GuidedPayload, "template" | "department" | "output">): string[] {
  const template = templateById(payload.template.id, payload.department);
  const fixed = template ? [...template.requires] : [];
  if (template?.custom && payload.output === "email_drafts" && !fixed.includes("google-workspace")) fixed.push("google-workspace");
  return fixed;
}

/** The task message a run is given for a stored payload. Null when its template is gone. */
export function taskMessageFor(payload: GuidedPayload): string | null {
  const template = templateById(payload.template.id, payload.department);
  return template && template.version === payload.template.version ? template.instruction(payload.inputs) : null;
}
