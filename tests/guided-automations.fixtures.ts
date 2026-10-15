/**
 * Shared fixtures for the guided-automations tests (not a test itself: tests/_suite.mjs does not list it).
 *
 * A workspace, drafts for every kind of job, saved automations in every status, and a fake `GuidedApi`
 * that records each call and answers ok unless a method is overridden with a failure shape.
 */
import assert from "node:assert/strict";
import { describePlan, nextRuns, planToCron } from "../lib/automations/schedule-plan";
import type { DepartmentKey } from "../lib/os/types";
import type {
  ApiFailure,
  GuidedApi,
  GuidedAutomationView,
  GuidedContextView,
  GuidedStatus,
  TestResult,
} from "../lib/automations/guided/api-types";
import { readToolsFor, templateById } from "../lib/automations/guided/templates";
import { GUIDED_ZONE } from "../lib/automations/guided/validate";
import { DEPARTMENT_ORDER, emptyDraft, pickDepartment, pickTemplate, setInput, setTool, validateDraft, type Draft } from "../lib/automations/guided/view";

/** Thursday 8:00 AM Toronto time (EDT). */
export const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
export const ALL_DEPARTMENTS: DepartmentKey[] = [...DEPARTMENT_ORDER];

export const REPAIR_GOOGLE = { label: "Connect Google Workspace", href: "/settings/connections?connect=google-workspace" };

export const CTX: GuidedContextView = {
  companyFinancials: true,
  departments: ALL_DEPARTMENTS,
  cloud: { ready: true, reason: null, repair: null },
  connections: [{ slug: "google-workspace", label: "Google Workspace", state: "connected", repair: null }],
};

/** The same workspace with Google Workspace not connected. */
export const CTX_NO_GOOGLE: GuidedContextView = {
  ...CTX,
  connections: [{ slug: "google-workspace", label: "Google Workspace", state: "not_connected", repair: REPAIR_GOOGLE }],
};

/** A draft with a template picked and the person's changes applied. */
export function draftOf(id: string, department: DepartmentKey, change: (d: Draft) => Draft = (d) => d): Draft {
  const template = templateById(id, department);
  assert.ok(template, `template ${id}/${department} exists`);
  return change(pickTemplate(pickDepartment(emptyDraft(), department), template));
}

export function customDraft(department: DepartmentKey, objective = "Which leads from this week have not had a reply?", tools = readToolsFor(department).slice(0, 2)): Draft {
  let d = draftOf("custom", department);
  d = setInput(d, "objective", objective);
  for (const t of tools) d = setTool(d, t, true);
  return d;
}

export function itemFrom(draft: Draft, status: GuidedStatus = "paused", extra: Partial<GuidedAutomationView> = {}): GuidedAutomationView {
  const v = validateDraft(draft, CTX);
  assert.ok(v.ok, `the fixture draft is valid: ${v.ok ? "" : v.message}`);
  const plan = v.payload.schedule.plan;
  return {
    id: "a1",
    name: draft.name,
    department: v.payload.department,
    templateId: v.payload.template.id,
    templateTitle: templateById(v.payload.template.id, v.payload.department)!.title,
    status,
    payload: v.payload,
    scheduleSentence: describePlan(plan),
    nextRuns: status === "on" && plan.mode !== "manual" ? nextRuns(planToCron(plan), GUIDED_ZONE, NOW, 3).map((d) => d.toISOString()) : [],
    lastRun: null,
    problems: [],
    ...extra,
  };
}

export const RESULT_OK: TestResult = { runId: "r1", status: "done", finalText: "Three leads are quiet.", wouldDraft: [], failure: null };

export const RESULT_DRAFTS: TestResult = {
  runId: "r2",
  status: "done",
  finalText: "Two leads are overdue for a follow-up.",
  wouldDraft: [
    { to: "sam@example.com", subject: "Checking in on the proposal", body: "Hi Sam,\nJust checking in." },
    { to: "ana@example.com", subject: "A quick question", body: "Hi Ana, is Thursday still good?" },
  ],
  failure: null,
};

export type Call = { method: string; args: unknown[] };

/** A GuidedApi that records every call and answers ok unless a method is overridden. */
export function fakeApi(overrides: Partial<Record<keyof GuidedApi, (...args: never[]) => unknown>> = {}) {
  const calls: Call[] = [];
  const answer = (method: keyof GuidedApi, fallback: (...args: unknown[]) => unknown) => async (...args: unknown[]) => {
    calls.push({ method, args });
    const fn = (overrides[method] as ((...a: unknown[]) => unknown) | undefined) ?? fallback;
    return fn(...args);
  };
  const base = itemFrom(draftOf("daily_brief", "chief_of_staff"));
  const api = {
    context: answer("context", () => ({ ok: true, context: CTX })),
    list: answer("list", () => ({ ok: true, items: [] })),
    create: answer("create", (input) => {
      const i = input as { name: string; payload: GuidedAutomationView["payload"] };
      return { ok: true, item: { ...base, id: "new-1", name: i.name, department: i.payload.department, templateId: i.payload.template.id, payload: i.payload } };
    }),
    update: answer("update", (id, input) => {
      const i = input as { name: string; payload: GuidedAutomationView["payload"] };
      return { ok: true, item: { ...base, id: String(id), name: i.name, department: i.payload.department, templateId: i.payload.template.id, payload: i.payload } };
    }),
    test: answer("test", () => ({ ok: true, result: RESULT_OK })),
    activate: answer("activate", (id) => ({ ok: true, item: { ...base, id: String(id), status: "on" as const } })),
    pause: answer("pause", (id) => ({ ok: true, item: { ...base, id: String(id), status: "paused" as const } })),
    remove: answer("remove", () => ({ ok: true })),
    runs: answer("runs", () => ({ ok: true, runs: [] })),
    receipt: answer("receipt", (_id, runId) => ({
      ok: true,
      receipt: { id: String(runId), at: "2026-10-15T12:00:00.000Z", origin: "test", status: "done", summary: "Finished.", scheduledFor: null, finishedAt: null, text: "", steps: [], failure: null },
    })),
  } as unknown as GuidedApi;
  return { api, calls };
}

export const failure = (f: Partial<ApiFailure> & { error: string }): ApiFailure => ({ ok: false, message: "", ...f });

const FORBIDDEN_CHARS = [0x2014, 0x2013, 0x2192, 0x2190, 0x21d2, 0x2194].map((c) => String.fromCharCode(c));

/** Fails on a dash, an arrow or a word a person should never read on this page. */
export function assertPlainCopy(text: string, label: string) {
  for (const ch of FORBIDDEN_CHARS) assert.ok(!text.includes(ch), `${label} has a dash or arrow (U+${ch.charCodeAt(0).toString(16)}): ${text.slice(0, 200)}`);
  assert.ok(!/->|=>/.test(text), `${label} has an ascii arrow: ${text.slice(0, 200)}`);
  assert.ok(!/\b(cron|payload|department_task|client_success|tenant_cron_jobs|dept_chat_runs|json)\b/i.test(text), `${label} shows jargon: ${text.slice(0, 200)}`);
  assert.ok(!/\b(gemini|claude|anthropic|openai|gpt-?\d|sonnet|opus|haiku|llama)\b/i.test(text), `${label} names a model: ${text.slice(0, 200)}`);
}
