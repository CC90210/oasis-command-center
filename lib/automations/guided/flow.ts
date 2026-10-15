/**
 * lib/automations/guided/flow.ts - what the guided builder does when a person presses a button.
 *
 * Save, Test now, Turn on, Pause, Delete and the two first loads: each one is a function of a
 * `GuidedApi` that answers either the server's own data or a Failure with a sentence. The screen
 * says "saved", "tested" or "on" only from the `ok: true` branch, and only with what the server
 * sent back, so a response the server did not give can never turn into a success line.
 *
 * Nothing here touches React or fetch: the wizard passes its `GuidedApi` (the page's browser client,
 * or a fake in the tests), and the whole flow is exercised without a browser.
 *
 * PURE apart from the injected API. No server imports.
 */
import type {
  ApiFailure,
  ApiResult,
  GuidedApi,
  GuidedAutomationView,
  GuidedContextView,
  GuidedStatus,
  Problem,
  RepairLink,
  TestResult,
} from "./api-types";
import { GENERIC_FAILURE, nameProblem, sentenceFor, snapshotOf, validateDraft, type Draft, type LoadState } from "./view";

/** A refusal in the form the screen shows: one sentence, where it belongs, how to fix it. */
export type Failure = {
  code: string;
  message: string;
  /** The input or section the sentence is about. */
  field: string | null;
  repair: RepairLink | null;
  problems: Problem[];
};

export function toFailure(f: ApiFailure): Failure {
  return {
    code: f.error,
    message: sentenceFor(f.error, f.message),
    field: f.field ?? null,
    repair: f.repair ?? null,
    problems: Array.isArray(f.problems) ? f.problems : [],
  };
}

const unreadable = (what: string): Failure => ({
  code: "bad_response",
  message: `The server answered, but not with ${what}. Nothing is shown as done. Reload the page and check what is saved.`,
  field: null,
  repair: null,
  problems: [],
});

/** A call that throws (a fake, or a future client) is a failure with a sentence, and the trace is kept in the console. */
async function attempt<T>(label: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  try {
    return await run();
  } catch (err) {
    console.error(`[guided.${label}] the call threw`, err);
    return { ok: false, error: "server_error", message: GENERIC_FAILURE };
  }
}

const STATUSES: readonly GuidedStatus[] = ["paused", "on", "needs_attention"];

function isItem(v: unknown): v is GuidedAutomationView {
  if (!v || typeof v !== "object") return false;
  const item = v as Partial<GuidedAutomationView>;
  return typeof item.id === "string" && typeof item.name === "string" && STATUSES.includes(item.status as GuidedStatus) && !!item.payload;
}

function isResult(v: unknown): v is TestResult {
  if (!v || typeof v !== "object") return false;
  const r = v as Partial<TestResult>;
  return typeof r.runId === "string" && (r.status === "done" || r.status === "failed" || r.status === "cancelled") && Array.isArray(r.wouldDraft);
}

// ── loads ────────────────────────────────────────────────────────────────

export async function loadContext(api: GuidedApi): Promise<LoadState<GuidedContextView>> {
  const res = await attempt("context", () => api.context());
  if (!res.ok) {
    const f = toFailure(res);
    return { kind: "error", message: f.message, repair: f.repair };
  }
  const c = res.context;
  if (!c || !Array.isArray(c.departments) || !Array.isArray(c.connections) || !c.cloud) {
    return { kind: "error", message: unreadable("your workspace details").message, repair: null };
  }
  return { kind: "ready", data: c };
}

export async function loadList(api: GuidedApi): Promise<LoadState<GuidedAutomationView[]>> {
  const res = await attempt("list", () => api.list());
  if (!res.ok) {
    const f = toFailure(res);
    return { kind: "error", message: f.message, repair: f.repair };
  }
  if (!Array.isArray(res.items) || !res.items.every(isItem)) {
    return { kind: "error", message: unreadable("your automations").message, repair: null };
  }
  return { kind: "ready", data: res.items };
}

// ── save ─────────────────────────────────────────────────────────────────

export type SaveOutcome = { ok: true; item: GuidedAutomationView; snapshot: string } | { ok: false; failure: Failure };

/**
 * Save the draft: a new automation (paused, always) or, with an id, a change to a saved one.
 * The draft is validated by the same function the API runs, and the payload it returns is the one
 * sent, so the server never receives a field the validator did not normalise.
 */
export async function saveAutomation(api: GuidedApi, draft: Draft, ctx: Pick<GuidedContextView, "companyFinancials">, existingId: string | null): Promise<SaveOutcome> {
  const checked = validateDraft(draft, ctx);
  if (!checked.ok) return { ok: false, failure: { code: checked.error, message: checked.message, field: checked.field ?? null, repair: null, problems: [] } };
  const problem = nameProblem(draft.name);
  if (problem) return { ok: false, failure: { code: "name_invalid", message: problem, field: "name", repair: null, problems: [] } };

  const name = draft.name.trim();
  const res = existingId
    ? await attempt("update", () => api.update(existingId, { name, payload: checked.payload }))
    : await attempt("create", () => api.create({ name, payload: checked.payload }));
  if (!res.ok) return { ok: false, failure: toFailure(res) };
  if (!isItem(res.item)) return { ok: false, failure: unreadable("the saved automation") };
  return { ok: true, item: res.item, snapshot: snapshotOf(name, checked.payload) };
}

// ── test, turn on, pause, delete ─────────────────────────────────────────

export type TestOutcome = { ok: true; result: TestResult } | { ok: false; failure: Failure };

export async function runTest(api: GuidedApi, id: string): Promise<TestOutcome> {
  const res = await attempt("test", () => api.test(id));
  if (!res.ok) return { ok: false, failure: toFailure(res) };
  if (!isResult(res.result)) return { ok: false, failure: unreadable("a test result") };
  return { ok: true, result: res.result };
}

export type ItemOutcome = { ok: true; item: GuidedAutomationView } | { ok: false; failure: Failure };

export async function activateAutomation(api: GuidedApi, id: string): Promise<ItemOutcome> {
  const res = await attempt("activate", () => api.activate(id));
  if (!res.ok) return { ok: false, failure: toFailure(res) };
  if (!isItem(res.item)) return { ok: false, failure: unreadable("the automation") };
  return { ok: true, item: res.item };
}

export async function pauseAutomation(api: GuidedApi, id: string): Promise<ItemOutcome> {
  const res = await attempt("pause", () => api.pause(id));
  if (!res.ok) return { ok: false, failure: toFailure(res) };
  if (!isItem(res.item)) return { ok: false, failure: unreadable("the automation") };
  return { ok: true, item: res.item };
}

export type RemoveOutcome = { ok: true } | { ok: false; failure: Failure };

export async function removeAutomation(api: GuidedApi, id: string): Promise<RemoveOutcome> {
  const res = await attempt("remove", () => api.remove(id));
  return res.ok ? { ok: true } : { ok: false, failure: toFailure(res) };
}

// ── what the screen may say after a success ──────────────────────────────

/** Said only from the item the server returned: what it is, not what we hoped. */
export function savedLine(item: GuidedAutomationView): string {
  if (item.status === "paused") return "Saved and paused. Nothing will run until you turn it on.";
  if (item.status === "on") return "Saved. It is on.";
  return "Saved, but it needs attention before it can run. See the problems below.";
}

export function activatedLine(item: GuidedAutomationView): string {
  if (item.status === "on") return "It is on.";
  if (item.status === "paused") return "The server did not turn it on: it is still paused.";
  return "It could not be turned on cleanly: it needs attention. See the problems below.";
}
