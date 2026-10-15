/**
 * lib/automations/guided/view.ts - what the guided builder shows, and when it lets a person move on.
 *
 * Everything the wizard decides that is not a pixel lives here, as plain functions, so it is tested
 * without a browser: which steps are done and what blocks Next, the sentence on Review, the next run
 * times, the labels, the three Review buttons and when each is allowed.
 *
 * The truth about a payload is never re-implemented here. A draft is turned into a raw payload and
 * handed to validateGuidedPayload (the same function the API runs), so the refusal sentence a person
 * reads inline is the one the server would give.
 *
 * PURE. No server imports, no React, no new dependency: the Worker bundle is at 99% of its cap.
 */
import type { DepartmentKey } from "@/lib/os/types";
import { DEPARTMENT_PALETTES, DESK_TOOLS, type DeskToolName } from "@/lib/os/desk/catalog";
import { describePlan, formatClock, formatRunInstant, nextRuns, planToCron, type SchedulePlan } from "@/lib/automations/schedule-plan";
import { defaultInputs, readToolsFor, templateById, templatesFor } from "./templates";
import { GUIDED_ZONE, requiredConnectors, validateGuidedPayload } from "./validate";
import {
  GUIDED_PAYLOAD_VERSION,
  type GuidedOutput,
  type GuidedTemplate,
  type GuidedValidation,
  type InputField,
  type InputValues,
  type SchedulePreset,
} from "./types";
import type {
  ConnectionFact,
  ConnectionState,
  GuidedAutomationView,
  GuidedContextView,
  GuidedStatus,
  LastRunView,
  RepairLink,
} from "./api-types";

// ── departments ──────────────────────────────────────────────────────────

/** The order the cards are drawn in. */
export const DEPARTMENT_ORDER: readonly DepartmentKey[] = ["chief_of_staff", "sales", "marketing", "client_success", "finance", "operations"];

/** What a person calls each department, and what a job there is for. "Support" is client_success in the code. */
const DEPARTMENT_COPY: Readonly<Record<DepartmentKey, { label: string; purpose: string }>> = {
  chief_of_staff: { label: "Chief of Staff", purpose: "A read on the whole business: where it stands and what is waiting on you." },
  sales: { label: "Sales", purpose: "Follow-ups that are overdue and leads that have gone quiet." },
  marketing: { label: "Marketing", purpose: "A weekly read of your marketing numbers." },
  client_success: { label: "Support", purpose: "Late support tickets and client projects at risk." },
  finance: { label: "Finance", purpose: "Money collected and progress toward your revenue goal." },
  operations: { label: "Operations", purpose: "Routines that failed and connections that need attention." },
};

export function departmentLabel(key: DepartmentKey): string {
  return DEPARTMENT_COPY[key]?.label ?? "This department";
}

export function departmentPurpose(key: DepartmentKey): string {
  return DEPARTMENT_COPY[key]?.purpose ?? "";
}

type DepartmentAccess = Pick<GuidedContextView, "departments" | "companyFinancials">;

/** The departments this person may build for. Finance only when they may see company financials. */
export function availableDepartments(ctx: DepartmentAccess): DepartmentKey[] {
  return DEPARTMENT_ORDER.filter((d) => ctx.departments.includes(d) && (d !== "finance" || ctx.companyFinancials));
}

/** How many ready-made jobs a department has (the custom brief is offered everywhere and not counted). */
export function readyMadeCount(department: DepartmentKey, ctx: Pick<GuidedContextView, "companyFinancials">): number {
  return templatesFor(department, { companyFinancials: ctx.companyFinancials }).filter((t) => !t.custom).length;
}

// ── the draft the wizard edits ───────────────────────────────────────────

/** A schedule as one tap plus, for the modes that have them, a changed time or changed days. */
export type ScheduleChoice = { presetId: string; time?: string; days?: number[] };

export type Draft = {
  department: DepartmentKey | null;
  templateId: string | null;
  inputs: InputValues;
  /** The ticked reads. Only the custom brief uses it. */
  tools: DeskToolName[];
  /** Only the custom brief lets the person choose it. */
  output: GuidedOutput;
  schedule: ScheduleChoice | null;
  name: string;
  /** Once the person types a name, it is theirs and stops following the template. */
  nameTouched: boolean;
};

export const NAME_MAX = 80;

export function emptyDraft(): Draft {
  return { department: null, templateId: null, inputs: {}, tools: [], output: "digest", schedule: null, name: "", nameTouched: false };
}

export function draftTemplate(draft: Draft): GuidedTemplate | null {
  return draft.department && draft.templateId ? templateById(draft.templateId, draft.department) : null;
}

/** Picking another department starts the job over; picking the same one changes nothing. */
export function pickDepartment(draft: Draft, department: DepartmentKey): Draft {
  return draft.department === department ? draft : { ...emptyDraft(), department };
}

/** A name the person did not write: the template's title, or for the custom brief the start of the objective. */
export function defaultName(template: GuidedTemplate, inputs: InputValues): string {
  if (!template.custom) return template.title;
  const objective = String(inputs.objective ?? "").trim();
  if (!objective) return "Something else";
  if (objective.length <= 60) return objective;
  const cut = objective.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return (space > 20 ? cut.slice(0, space) : cut).trim();
}

export function pickTemplate(draft: Draft, template: GuidedTemplate): Draft {
  if (draft.templateId === template.id && draft.department === template.department) return draft;
  const inputs = defaultInputs(template);
  return {
    department: template.department,
    templateId: template.id,
    inputs,
    tools: [],
    output: template.output,
    schedule: template.schedulePresets[0] ? { presetId: template.schedulePresets[0].id } : null,
    name: defaultName(template, inputs),
    nameTouched: false,
  };
}

function renamed(draft: Draft, template: GuidedTemplate | null, inputs: InputValues): Draft {
  return draft.nameTouched || !template ? { ...draft, inputs } : { ...draft, inputs, name: defaultName(template, inputs) };
}

export function setInput(draft: Draft, name: string, value: string | number): Draft {
  return renamed(draft, draftTemplate(draft), { ...draft.inputs, [name]: value });
}

export function setName(draft: Draft, name: string): Draft {
  return { ...draft, name, nameTouched: true };
}

/** Tick or untick one read, keeping the department's own order. */
export function setTool(draft: Draft, tool: DeskToolName, on: boolean): Draft {
  const wanted = new Set(draft.tools);
  if (on) wanted.add(tool);
  else wanted.delete(tool);
  const order = draft.department ? readToolsFor(draft.department) : [];
  return { ...draft, tools: order.filter((t) => wanted.has(t)) };
}

export function setOutput(draft: Draft, output: GuidedOutput): Draft {
  const next = { ...draft, output };
  if (output !== "email_drafts") return next;
  // A run the person starts only previews, so drafts cannot be "only when I run it": move to the first real schedule.
  const template = draftTemplate(draft);
  if (!template || presetOf(template, draft.schedule)?.plan.mode !== "manual") return next;
  const first = template.schedulePresets.find((p) => p.plan.mode !== "manual");
  return { ...next, schedule: first ? { presetId: first.id } : null };
}

/** Whether a department's teammate can draft emails at all (the custom brief's second output). */
export function canDraftEmails(department: DepartmentKey): boolean {
  return (DEPARTMENT_PALETTES[department] ?? []).includes("propose_email");
}

// ── schedule ─────────────────────────────────────────────────────────────

export function setSchedulePreset(draft: Draft, presetId: string): Draft {
  return { ...draft, schedule: { presetId } };
}

export function setScheduleTime(draft: Draft, time: string): Draft {
  return draft.schedule ? { ...draft, schedule: { ...draft.schedule, time } } : draft;
}

export function setScheduleDays(draft: Draft, days: number[]): Draft {
  return draft.schedule ? { ...draft, schedule: { ...draft.schedule, days: [...days].sort((a, b) => a - b) } } : draft;
}

export function presetOf(template: GuidedTemplate, choice: ScheduleChoice | null): SchedulePreset | null {
  return (choice && template.schedulePresets.find((p) => p.id === choice.presetId)) || null;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A preset's time of day can be changed when it is a daily, weekday or weekly one. */
export function canEditTime(preset: SchedulePreset): boolean {
  return preset.plan.mode === "daily" || preset.plan.mode === "weekdays" || preset.plan.mode === "weekly";
}

export function canEditDays(preset: SchedulePreset): boolean {
  return preset.plan.mode === "weekly";
}

/** The time shown in the time field: the person's change, else the preset's own. */
export function scheduleTime(template: GuidedTemplate, choice: ScheduleChoice | null): string {
  const preset = presetOf(template, choice);
  if (!preset || !choice) return "";
  if (choice.time !== undefined) return choice.time;
  return "time" in preset.plan ? preset.plan.time : "";
}

export function scheduleDays(template: GuidedTemplate, choice: ScheduleChoice | null): number[] {
  const preset = presetOf(template, choice);
  if (!preset || !choice) return [];
  if (choice.days) return choice.days;
  return preset.plan.mode === "weekly" ? [...preset.plan.days] : [];
}

/** The plan to validate and store, in the guided zone. Null when no schedule is chosen yet. */
export function planFor(template: GuidedTemplate, choice: ScheduleChoice | null): SchedulePlan | null {
  const preset = presetOf(template, choice);
  if (!preset || !choice) return null;
  const base = { ...preset.plan, timezone: GUIDED_ZONE } as SchedulePlan;
  if (base.mode === "daily" || base.mode === "weekdays") return choice.time !== undefined ? { ...base, time: choice.time } : base;
  if (base.mode === "weekly") {
    return { ...base, ...(choice.time !== undefined ? { time: choice.time } : {}), ...(choice.days ? { days: choice.days } : {}) };
  }
  return base;
}

const DAY_PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"] as const;
export const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The chip's text: the catalogue's wording until the person changes the time or days, then the same sentence with their change. */
export function chipLabel(preset: SchedulePreset, choice: ScheduleChoice | null): string {
  if (!choice || choice.presetId !== preset.id) return preset.label;
  const p = preset.plan;
  if (p.mode !== "daily" && p.mode !== "weekdays" && p.mode !== "weekly") return preset.label;
  const time = choice.time !== undefined && TIME_RE.test(choice.time) ? choice.time : p.time;
  const clock = formatClock(time);
  if (p.mode === "weekly") {
    const days = choice.days ?? p.days;
    if (days.length === 0) return preset.label;
    const same = time === p.time && days.length === p.days.length && days.every((d, i) => d === p.days[i]);
    return same ? preset.label : `${joinWords(days.map((d) => DAY_PLURAL[d] ?? "A day"))} at ${clock}`;
  }
  if (time === p.time) return preset.label;
  return p.mode === "daily" ? `Every day at ${clock}` : `Weekdays at ${clock}`;
}

/**
 * Read a stored plan back into the chip it came from, with the time or days it was changed to.
 * Null when the guided builder does not offer that schedule (it keeps the person from guessing).
 */
export function scheduleChoiceFromPlan(template: GuidedTemplate, plan: SchedulePlan): ScheduleChoice | null {
  const sameMode = template.schedulePresets.filter((p) => p.plan.mode === plan.mode);
  if (sameMode.length === 0) return null;
  const exact = sameMode.find((p) => JSON.stringify({ ...p.plan, timezone: plan.timezone }) === JSON.stringify(plan));
  if (exact) return { presetId: exact.id };
  const preset = sameMode[0];
  if (plan.mode === "daily" || plan.mode === "weekdays") return { presetId: preset.id, time: plan.time };
  if (plan.mode === "weekly") return { presetId: preset.id, time: plan.time, days: [...plan.days] };
  // every_n_hours with another interval or start is not a chip: it is not offered.
  if (plan.mode === "every_n_hours" && preset.plan.mode === "every_n_hours") {
    const match = sameMode.find((p) => p.plan.mode === "every_n_hours" && p.plan.every_hours === plan.every_hours && p.plan.time === plan.time);
    return match ? { presetId: match.id } : null;
  }
  return null;
}

/** What "next runs" shows for a plan. Manual shows a sentence, not times. */
export type NextRunsView =
  | { kind: "manual"; text: string }
  | { kind: "runs"; lines: string[] }
  | { kind: "none"; text: string };

export const MANUAL_RUNS_TEXT = "Runs only when you press Test now.";

/** The next three run times in Toronto time, computed by the one schedule library. */
export function nextRunsView(plan: SchedulePlan, now: Date, count = 3): NextRunsView {
  if (plan.mode === "manual") return { kind: "manual", text: MANUAL_RUNS_TEXT };
  const runs = nextRuns(planToCron(plan), GUIDED_ZONE, now, count);
  if (runs.length === 0) return { kind: "none", text: "We could not work out the next run for this schedule." };
  return { kind: "runs", lines: runs.map((d) => formatRunInstant(d, GUIDED_ZONE)) };
}

// ── validation ───────────────────────────────────────────────────────────

/** The raw payload a draft proposes. Tools and output are sent only for the custom brief, the only one that chooses them. */
export function toRaw(draft: Draft): unknown {
  const template = draftTemplate(draft);
  if (!template) return null;
  return {
    v: GUIDED_PAYLOAD_VERSION,
    template: { id: template.id, version: template.version },
    department: template.department,
    inputs: draft.inputs,
    ...(template.custom ? { tools: draft.tools, output: draft.output } : {}),
    schedule: { plan: planFor(template, draft.schedule) ?? undefined },
  };
}

/** The draft checked by the same validator the API runs. */
export function validateDraft(draft: Draft, ctx: Pick<GuidedContextView, "companyFinancials">): GuidedValidation {
  if (!draft.department) return { ok: false, error: "template_unknown", message: "Pick a department to continue.", field: "department" };
  if (!draftTemplate(draft)) return { ok: false, error: "template_unknown", message: "Pick a job to continue.", field: "template" };
  return validateGuidedPayload(toRaw(draft), { companyFinancials: ctx.companyFinancials });
}

/** The refusal to show at a field: only for a field the person has touched, and only the one the validator named. */
export function errorAt(validation: GuidedValidation, field: string, touched: ReadonlySet<string>): string | null {
  return !validation.ok && validation.field === field && touched.has(field) ? validation.message : null;
}

/** What goes to the server: the name and the payload the validator normalised. */
export function snapshotOf(name: string, payload: unknown): string {
  return JSON.stringify([name.trim(), payload]);
}

/** Null when the name is fine; otherwise the sentence to show at the name field. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "Give it a name so you can find it in your list.";
  if (n.length > NAME_MAX) return `A name can be at most ${NAME_MAX} characters.`;
  return null;
}

// ── steps and gating ─────────────────────────────────────────────────────

export type StepId = "department" | "job" | "connections" | "runs_on" | "review";

export const STEPS: readonly { id: StepId; label: string; title: string; lead: string }[] = [
  { id: "department", label: "Department", title: "Which department is this for?", lead: "Pick the part of the business the job is about. You can only choose from the departments you have access to." },
  { id: "job", label: "Job", title: "What should it do?", lead: "Pick a ready-made job and set it up with the choices below, or describe your own." },
  { id: "connections", label: "Connections", title: "Which apps does it need?", lead: "Some jobs work through a connected app. Here is what this one needs and whether it is ready." },
  { id: "runs_on", label: "Runs on", title: "Where does it run?", lead: "Automations run in the cloud, so they never touch the files on a computer." },
  { id: "review", label: "Review", title: "Check it, then save, test and turn it on", lead: "Nothing runs until you turn it on. Saving always keeps it paused." },
];

export function stepIndex(id: StepId): number {
  return STEPS.findIndex((s) => s.id === id);
}

export type Gate = { open: boolean; blocker: string | null; field: string | null };

/** Can the person leave this step going forward, and if not, in one sentence why not. */
export function gateFor(step: StepId, draft: Draft, ctx: GuidedContextView): Gate {
  if (step === "review") return { open: false, blocker: null, field: null };
  if (step === "department") {
    if (!draft.department) return { open: false, blocker: "Pick a department to continue.", field: "department" };
    if (!availableDepartments(ctx).includes(draft.department)) {
      return { open: false, blocker: "That department is not available to you. Pick another.", field: "department" };
    }
    return { open: true, blocker: null, field: null };
  }
  const v = validateDraft(draft, ctx);
  if (!v.ok) return { open: false, blocker: v.message, field: v.field ?? null };
  // Connections and Runs on are information: a missing app or an unready Cloud never blocks moving on or saving.
  return { open: true, blocker: null, field: null };
}

/** The furthest step the person may open: every step before it must be open. */
export function furthestStep(draft: Draft, ctx: GuidedContextView): StepId {
  let reached = 0;
  for (let i = 0; i < STEPS.length - 1; i += 1) {
    if (!gateFor(STEPS[i].id, draft, ctx).open) break;
    reached = i + 1;
  }
  return STEPS[reached].id;
}

export function canVisit(step: StepId, draft: Draft, ctx: GuidedContextView): boolean {
  return stepIndex(step) <= stepIndex(furthestStep(draft, ctx));
}

export function stepAfter(step: StepId): StepId {
  return STEPS[Math.min(stepIndex(step) + 1, STEPS.length - 1)].id;
}

export function stepBefore(step: StepId): StepId {
  return STEPS[Math.max(stepIndex(step) - 1, 0)].id;
}

// ── connections and Cloud ────────────────────────────────────────────────

export type ConnectionRow = {
  slug: string;
  label: string;
  state: ConnectionState;
  stateLabel: string;
  repair: RepairLink | null;
  /** True when turning the automation on must wait: the app is not connected or needs attention. */
  blocksTurnOn: boolean;
};

const STATE_LABEL: Record<ConnectionState, string> = {
  connected: "Connected",
  attention: "Needs attention",
  not_connected: "Not connected",
  unknown: "We could not check this app",
};

export function connectionStateLabel(state: ConnectionState): string {
  return STATE_LABEL[state] ?? STATE_LABEL.unknown;
}

/** "google-workspace" as a person would write it, for an app the connections list did not name. */
export function slugLabel(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function connectionRows(slugs: readonly string[], facts: readonly ConnectionFact[]): ConnectionRow[] {
  return slugs.map((slug) => {
    const fact = facts.find((f) => f.slug === slug);
    const state: ConnectionState = fact?.state ?? "unknown";
    return {
      slug,
      label: fact?.label || slugLabel(slug),
      state,
      stateLabel: connectionStateLabel(state),
      repair: state === "connected" ? null : (fact?.repair ?? null),
      blocksTurnOn: state === "not_connected" || state === "attention",
    };
  });
}

/** The connections a draft cannot run without (Connections-hub slugs). */
export function requiredSlugs(draft: Draft): string[] {
  const template = draftTemplate(draft);
  if (!template) return [];
  return requiredConnectors({ template: { id: template.id, version: template.version }, department: template.department, output: template.custom ? draft.output : template.output });
}

// ── review ───────────────────────────────────────────────────────────────

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function optionLabel(field: InputField | undefined, value: unknown): string {
  if (field?.kind === "choice") return field.options.find((o) => o.value === value)?.label ?? String(value);
  return String(value);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The ticked reads as a person would list them ("pipeline, leads and lead history"). */
export function toolsText(tools: readonly DeskToolName[]): string {
  return joinWords(tools.map((t) => lowerFirst(DESK_TOOLS[t]?.label ?? "a lookup")));
}

/** What the automation does, in the words of its own settings. */
function whatItDoes(template: GuidedTemplate, draft: Draft): string {
  const i = draft.inputs;
  switch (template.id) {
    case "daily_brief": {
      const reads = ["your department numbers", "the approvals waiting", "the pipeline", ...(i.calendar === "yes" ? ["today's calendar"] : [])];
      return `write you a ${i.length === "full" ? "full brief (up to 12 lines)" : "short brief (about 5 lines)"} from ${joinWords(reads)}`;
    }
    case "followup_drafts": {
      const n = Number(i.max_drafts) || 0;
      const goal =
        i.goal === "check_in"
          ? "checks in and asks whether anything changed"
          : i.goal === "re_engage"
            ? "re-opens a conversation that went quiet"
            : "invites them to book a short call";
      return `find up to ${plural(n, "lead", "leads")} whose follow-up is overdue and write a ${String(i.tone || "friendly").toLowerCase()} email to each that ${goal}`;
    }
    case "stalled_digest":
      return `list the leads with no activity for ${plural(Number(i.days_quiet) || 0, "day", "days")} or more, grouped by stage, and name the one to call first`;
    case "support_risk":
      return `flag the open support tickets that are late or about to be${i.projects === "yes" ? ", and the client projects due within 7 days that still have open work" : ""}`;
    case "marketing_numbers":
      return "report the numbers your Marketing page shows and how many items are waiting in Needs you";
    case "money_summary": {
      const metric =
        i.metric === "collected_7d"
          ? "the money collected in the last 7 days"
          : i.metric === "goal"
            ? "your progress toward the revenue goal"
            : i.metric === "mrr"
              ? "your recurring revenue"
              : "the money collected in the last 7 days, your progress toward the revenue goal and your recurring revenue";
      return `report ${metric} from your Finance page`;
    }
    case "ops_check":
      return i.only_problems === "no"
        ? "report every routine with its last result, and every connection and whether it is connected"
        : "report only the routines that failed or did not run, and the connections that need attention";
    case "custom": {
      const objective = String(i.objective ?? "").trim();
      const reads = toolsText(draft.tools);
      return `look into "${objective || "what you describe"}"${reads ? ` using ${reads}` : ""}`;
    }
    default: {
      // A template added later still gets an honest sentence: its own promise, and its settings by their labels.
      const settings = template.inputs.map((f) => `${f.label}: ${optionLabel(f, i[f.name])}`);
      return `${lowerFirst(template.promise.replace(/\.$/, ""))}${settings.length ? ` (${settings.join(", ")})` : ""}`;
    }
  }
}

/** The one plain-English sentence of what will happen. Null until a job and a schedule are chosen. */
export function reviewSentence(draft: Draft): string | null {
  const template = draftTemplate(draft);
  if (!template) return null;
  const plan = planFor(template, draft.schedule);
  if (!plan) return null;
  const output = template.custom ? draft.output : template.output;
  const when = plan.mode === "manual" ? "Only when you press Test now" : describePlan(plan);
  const who = template.custom ? "your custom automation" : `your "${template.title}" automation`;
  const where =
    output === "email_drafts"
      ? "; each email is filed in Needs you for your approval"
      : "; each run's summary appears under Your automations";
  return `${when}, ${who} will ${whatItDoes(template, draft)}${where}.`;
}

export function outputLabel(output: GuidedOutput): string {
  return output === "email_drafts" ? "Email drafts for your approval" : "A written summary";
}

export type SummaryRow = { label: string; value: string | null; lines: string[] };

/** The value of one input as a person reads it ("3 drafts", "Friendly"). */
/** "Tone: Friendly", and "What should it look into? Which leads..." when the label is itself a question. */
export function labelledValue(label: string, value: string): string {
  return `${label}${label.endsWith("?") ? "" : ":"} ${value}`;
}

export function inputValueText(field: InputField, value: unknown): string {
  if (field.kind === "choice") return optionLabel(field, value);
  if (field.kind === "number") return `${String(value)}${field.unit ? ` ${field.unit}` : ""}`;
  const text = String(value ?? "").trim();
  return text || "Not filled in yet";
}

/** The choices so far, for the summary rail. A row with no value reads "Not chosen yet". */
export function summaryRows(draft: Draft): SummaryRow[] {
  const template = draftTemplate(draft);
  const plan = template ? planFor(template, draft.schedule) : null;
  const slugs = requiredSlugs(draft);
  const settings: string[] = [];
  if (template) {
    for (const f of template.inputs) settings.push(labelledValue(f.label, inputValueText(f, draft.inputs[f.name])));
    if (template.custom) settings.push(`May read: ${draft.tools.length ? toolsText(draft.tools) : "nothing ticked yet"}`);
  }
  const output = template ? (template.custom ? draft.output : template.output) : null;
  return [
    { label: "Department", value: draft.department ? departmentLabel(draft.department) : null, lines: [] },
    { label: "Job", value: template ? template.title : null, lines: settings },
    { label: "Result", value: output ? outputLabel(output) : null, lines: [] },
    { label: "When", value: plan ? (plan.mode === "manual" ? "Only when you press Test now" : describePlan(plan)) : null, lines: [] },
    { label: "Apps", value: template ? (slugs.length ? joinWords(slugs.map(slugLabel)) : "None needed") : null, lines: [] },
    { label: "Runs on", value: template ? "Cloud" : null, lines: [] },
  ];
}

// ── the three Review buttons ─────────────────────────────────────────────

export type ReviewFacts = {
  valid: boolean;
  /** The sentence for the first reason the draft is not valid, when it is not. */
  validMessage: string | null;
  nameOk: boolean;
  saved: boolean;
  /** Changed since the last save. */
  dirty: boolean;
  /** A test of exactly what is saved finished and came back done. */
  testPassed: boolean;
  /** The person confirmed they want to turn it on without testing. */
  skipTest: boolean;
  status: GuidedStatus | null;
  cloudReady: boolean;
  cloudReason: string | null;
  /** Labels of the required apps that are not connected or need attention. */
  missingApps: readonly string[];
  busy: "save" | "test" | "activate" | "pause" | null;
};

export type ActionState = { enabled: boolean; label: string; why: string | null };
export type ReviewActions = { save: ActionState; test: ActionState; activate: ActionState; primary: "save" | "test" | "activate" | "none" };

export function reviewActions(f: ReviewFacts): ReviewActions {
  const idle = f.busy === null;

  const saveEnabled = idle && f.valid && f.nameOk && (!f.saved || f.dirty);
  const save: ActionState = {
    enabled: saveEnabled,
    label: f.busy === "save" ? "Saving..." : f.saved ? (f.dirty ? "Save changes" : "Saved") : "Save",
    why: saveEnabled
      ? null
      : !f.valid
        ? f.validMessage
        : !f.nameOk
          ? "Give it a name to save."
          : f.saved && !f.dirty
            ? "Nothing has changed since the last save."
            : null,
  };

  const testEnabled = idle && f.saved && !f.dirty;
  const test: ActionState = {
    enabled: testEnabled,
    label: f.busy === "test" ? "Testing..." : "Test now",
    why: testEnabled ? null : !f.saved ? "Save first. Test now runs the saved automation, once, as a preview." : f.dirty ? "Save your changes first, then test." : null,
  };

  const missing = f.missingApps.length > 0;
  const tested = f.testPassed || f.skipTest;
  const alreadyOn = f.status === "on";
  const activateEnabled = idle && f.saved && !f.dirty && tested && f.cloudReady && !missing && !alreadyOn;
  const activate: ActionState = {
    enabled: activateEnabled,
    label: f.busy === "activate" ? "Turning on..." : alreadyOn && !f.dirty ? "On" : "Turn on",
    why: activateEnabled
      ? null
      : !f.saved
        ? "Save first."
        : f.dirty
          ? "Save your changes first."
          : alreadyOn
            ? "It is already on."
            : !f.cloudReady
              ? `Cloud is not ready yet${f.cloudReason ? `: ${f.cloudReason}` : "."}`
              : missing
                ? `Connect ${joinWords(f.missingApps)} first. You can keep it saved until then.`
                : !tested
                  ? "Test it first, or confirm below that you want to skip the test."
                  : null,
  };

  const primary: ReviewActions["primary"] =
    saveEnabled ? "save" : testEnabled && !tested ? "test" : activateEnabled ? "activate" : "none";
  return { save, test, activate, primary };
}

// ── editing a saved automation ───────────────────────────────────────────

/** The draft a saved automation opens as. A note explains anything the builder could not carry over. */
export function draftFromItem(item: GuidedAutomationView): { draft: Draft; note: string | null } {
  const template = templateById(item.payload.template.id, item.payload.department);
  if (!template) {
    return {
      draft: { ...emptyDraft(), department: item.payload.department, name: item.name, nameTouched: true },
      note: "The ready-made job this was built from is no longer available. Pick a job again to keep this automation.",
    };
  }
  const inputs: InputValues = { ...defaultInputs(template), ...item.payload.inputs };
  const schedule = scheduleChoiceFromPlan(template, item.payload.schedule.plan);
  return {
    draft: {
      department: template.department,
      templateId: template.id,
      inputs,
      // The saved list of a drafts job includes the email draft tool; only the reads are ticked boxes.
      tools: template.custom ? item.payload.tools.filter((t) => DESK_TOOLS[t]?.kind === "read") : [],
      output: item.payload.output,
      schedule,
      name: item.name,
      nameTouched: true,
    },
    note: schedule ? null : "This automation has a schedule the builder does not offer. Pick one of the schedules below to save changes.",
  };
}

/** Everything the wizard needs to open a saved automation on Review. A draft that no longer validates opens on Job. */
export function editSession(
  item: GuidedAutomationView,
  ctx: Pick<GuidedContextView, "companyFinancials">,
): { draft: Draft; step: StepId; note: string | null; saved: { item: GuidedAutomationView; snapshot: string } } {
  const { draft, note } = draftFromItem(item);
  const checked = validateDraft(draft, ctx);
  return {
    draft,
    step: checked.ok ? "review" : "job",
    note,
    saved: { item, snapshot: snapshotOf(draft.name, checked.ok ? checked.payload : null) },
  };
}

/** The list after the server returned one automation: replaced in place if it is there, else first. */
export function upsertItem(items: readonly GuidedAutomationView[], item: GuidedAutomationView): GuidedAutomationView[] {
  return items.some((x) => x.id === item.id) ? items.map((x) => (x.id === item.id ? item : x)) : [item, ...items];
}

// ── list wording ─────────────────────────────────────────────────────────

const STATUS_LABEL: Record<GuidedStatus, string> = { paused: "Paused", on: "On", needs_attention: "Needs attention" };

export function statusLabel(status: GuidedStatus): string {
  return STATUS_LABEL[status] ?? "Paused";
}

const RUN_STATUS_LABEL: Record<string, string> = {
  done: "Finished",
  failed: "Failed",
  missed: "Missed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  running: "Running now",
  queued: "Waiting to start",
};

export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABEL[status] ?? "Unknown";
}

/** "in 3 hours", "2 days ago". */
export function relativeTime(targetMs: number, nowMs: number): string {
  const diff = targetMs - nowMs;
  const minutes = Math.round(Math.abs(diff) / 60_000);
  const future = diff >= 0;
  if (minutes < 1) return future ? "in less than a minute" : "just now";
  const [n, unit] = minutes < 60 ? [minutes, "minute"] : minutes < 1440 ? [Math.round(minutes / 60), "hour"] : [Math.round(minutes / 1440), "day"];
  const text = plural(n as number, unit as string, `${unit}s`);
  return future ? `in ${text}` : `${text} ago`;
}

/** An ISO instant in Toronto time with the zone's abbreviation in force then, or null when it is not a time. */
export function instantText(iso: string): string | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? formatRunInstant(ms, GUIDED_ZONE) : null;
}

/** The "Next run" line of a list row, in words. */
export function nextRunLine(item: GuidedAutomationView, nowMs: number | null): string {
  if (item.payload.schedule.plan.mode === "manual") return MANUAL_RUNS_TEXT;
  if (item.status === "paused") return "Not scheduled while it is paused. Turn it on to start the schedule.";
  // With a problem listed it cannot succeed; with none, only its last run failed and it will try again.
  if (item.status === "needs_attention" && item.problems.length > 0) return "Not scheduled until the problem below is fixed.";
  const first = item.nextRuns[0];
  const text = first ? instantText(first) : null;
  if (!first || !text) return "The next run could not be worked out.";
  const when = `${text}${nowMs === null ? "" : ` (${relativeTime(Date.parse(first), nowMs)})`}`;
  return item.status === "needs_attention" ? `Its last run failed. Next try: ${when}` : `Next run: ${when}`;
}

/** The "Last run" line of a list row, before its one-sentence summary. */
export function lastRunHead(run: LastRunView, nowMs: number | null): string {
  const when = instantText(run.at);
  const rel = when && nowMs !== null ? ` (${relativeTime(Date.parse(run.at), nowMs)})` : "";
  return `${runStatusLabel(run.status)}${when ? `, ${when}${rel}` : ""}`;
}

/** The kind of control a choice field is drawn as. */
export function choiceStyle(field: Extract<InputField, { kind: "choice" }>): "segmented" | "list" | "select" {
  const longest = Math.max(...field.options.map((o) => o.label.length));
  if (field.options.length <= 3 && longest <= 26) return "segmented";
  if (field.options.length <= 4) return "list";
  return "select";
}

export function counterText(length: number, max: number): string {
  return `${length} of ${max} characters`;
}

/** Where the list's loading, ready and error states are kept. */
export type LoadState<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string; repair: RepairLink | null };

// ── plain sentences for a refusal ────────────────────────────────────────

const FALLBACK_MESSAGE: Readonly<Record<string, string>> = {
  unauthorized: "You are signed out. Sign in again, then try again.",
  forbidden: "You do not have permission to do that in this workspace.",
  not_found: "That automation is no longer there. Reload the page to see what is saved.",
  cloud_unavailable: "Cloud is not ready to run automations right now.",
  connection_missing: "An app this automation needs is not connected yet.",
  rate_limited: "That was too quick. Wait a moment and try again.",
  server_error: "Something went wrong on our side. Nothing was changed. Try again in a moment.",
};

export const GENERIC_FAILURE = "That did not work, and nothing was changed. Try again in a moment.";

/** A sentence a person can read: the server's own when it is one, else ours for the code. Never a bare code. */
export function sentenceFor(code: string, message: unknown): string {
  const text = typeof message === "string" ? message.trim() : "";
  if (text.length > 3 && /\s/.test(text)) return text;
  return FALLBACK_MESSAGE[code] ?? GENERIC_FAILURE;
}
