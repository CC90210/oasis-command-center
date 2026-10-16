/**
 * tests/guided-automations-ui.test.ts - the guided builder as a person sees it.
 *
 * Two halves:
 *   1. STATIC RENDER. tests/guided-automations-ui.render.ts draws the real components (in a child process,
 *      where react-dom/server loads) for every step and state, and the Automations page with the builder
 *      on and off. The markup is parsed and checked: real catalogue content on each step, the gating, the
 *      validation sentence at the field it names, the Review sentence, the list in every state, the
 *      builder as the only way to make one (the old AI box and form gone), no jargon / dash / arrow, an accessible name on
 *      every control, 44 px targets, errors tied to their fields, reduced-motion safe.
 *   2. DRIVEN. The real GuidedBuilder and list run in this process with a stand-in for React's state
 *      hooks (the technique tests/automation-draft-schedule.test.ts uses), a fake GuidedApi that records
 *      its calls, and the handlers the components wire up are called as a click would: department, job,
 *      settings, schedule, Next, Save, Test now, Turn on, an edit after saving, a refusal, Delete.
 *
 * Run: node --conditions=react-server --import tsx tests/guided-automations-ui.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import * as ReactNS from "react";
import { isValidElement, type ReactNode } from "react";
import { DESK_TOOLS } from "../lib/os/desk/catalog";
import type { GuidedAutomationView, GuidedContextView } from "../lib/automations/guided/api-types";
import { readToolsFor, templateById, templatesFor } from "../lib/automations/guided/templates";
import { toFailure } from "../lib/automations/guided/flow";
import {
  departmentLabel,
  departmentPurpose,
  editSession,
  emptyDraft,
  nextRunsView,
  pickDepartment,
  planFor,
  readyMadeCount,
  reviewSentence,
  setInput,
  setName,
  setOutput,
  setSchedulePreset,
  setScheduleDays,
  setScheduleTime,
  setTool,
  snapshotOf,
  timesADayOptions,
  validateDraft,
  type Draft,
} from "../lib/automations/guided/view";
import {
  ALL_DEPARTMENTS,
  CTX,
  CTX_NO_GOOGLE,
  NOW,
  REPAIR_GOOGLE,
  RESULT_DRAFTS,
  RESULT_OK,
  assertPlainCopy,
  customDraft,
  draftOf,
  failure,
  fakeApi,
  itemFrom,
} from "./guided-automations.fixtures";

const root = join(__dirname, "..");

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

// ═══ a small HTML reader for the static markup ═══════════════════════════

type HNode = { tag: string; attrs: Record<string, string>; kids: HNode[]; text: string; parent: HNode | null };
const decode = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
const VOID = new Set(["input", "br", "hr", "img", "meta", "link"]);

function parse(html: string): HNode {
  const rootNode: HNode = { tag: "#root", attrs: {}, kids: [], text: "", parent: null };
  let cur = rootNode;
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  for (const m of html.matchAll(re)) {
    if (m[5] !== undefined) {
      cur.kids.push({ tag: "#text", attrs: {}, kids: [], text: decode(m[5]), parent: cur });
      continue;
    }
    const [, closing, tag, rawAttrs, selfClose] = m;
    if (closing) {
      let up: HNode | null = cur;
      while (up && up.tag !== tag) up = up.parent;
      if (up?.parent) cur = up.parent;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? "" : decode(a[2]);
    const node: HNode = { tag, attrs, kids: [], text: "", parent: cur };
    cur.kids.push(node);
    if (!selfClose && !VOID.has(tag)) cur = node;
  }
  return rootNode;
}

function all(n: HNode, pred: (x: HNode) => boolean, out: HNode[] = []): HNode[] {
  for (const k of n.kids) {
    if (k.tag !== "#text" && pred(k)) out.push(k);
    all(k, pred, out);
  }
  return out;
}
const tags = (n: HNode, tag: string) => all(n, (x) => x.tag === tag);
const byId = (n: HNode, id: string) => all(n, (x) => x.attrs.id === id)[0] ?? null;
const cls = (n: HNode) => (n.attrs.class ?? "").split(/\s+/).filter(Boolean);
const hasClass = (n: HNode, c: string) => cls(n).includes(c);
/** Text a reader gets: aria-hidden parts are skipped, as they are for an accessible name. */
function textOf(n: HNode | null, skipHidden = true): string {
  if (!n) return "";
  if (n.tag === "#text") return n.text;
  if (skipHidden && n.attrs["aria-hidden"] === "true") return "";
  // A space around every element, none between two text nodes, so "Step 2 of 5: Job" stays whole and "Department" never runs into "Sales".
  return n.kids.map((k) => (k.tag === "#text" ? textOf(k, skipHidden) : ` ${textOf(k, skipHidden)} `)).join("");
}
const flat = (n: HNode | null) => textOf(n).replace(/\s+/g, " ").trim();
function closest(n: HNode, tag: string): HNode | null {
  for (let p = n.parent; p; p = p.parent) if (p.tag === tag) return p;
  return null;
}

/** The accessible name of a control, by the rules that matter here. */
function accName(rootNode: HNode, el: HNode): string {
  if (el.attrs["aria-label"]) return el.attrs["aria-label"].trim();
  if (el.attrs["aria-labelledby"]) {
    return el.attrs["aria-labelledby"]
      .split(/\s+/)
      .map((id) => flat(byId(rootNode, id)))
      .join(" ")
      .trim();
  }
  if (el.tag === "input" || el.tag === "select" || el.tag === "textarea") {
    if (el.attrs.id) {
      const lab = all(rootNode, (x) => x.tag === "label" && x.attrs.for === el.attrs.id)[0];
      if (lab) return flat(lab);
    }
    const wrap = closest(el, "label");
    return wrap ? flat(wrap) : "";
  }
  return flat(el);
}

/** The status word of a list row. */
const pillOf = (li: HNode) => flat(all(li, (x) => x.tag === "span" && hasClass(x, "rounded-md") && hasClass(x, "font-medium") && hasClass(x, "text-xs"))[0] ?? null);
/** The rows of the Connections step's list of apps. */
const appRows = (r: HNode) => all(r, (x) => x.tag === "ul" && hasClass(x, "divide-y")).flatMap((ul) => tags(ul, "li"));
const CONTROLS = (r: HNode) => all(r, (x) => ["button", "select", "textarea", "summary"].includes(x.tag) || (x.tag === "a" && "href" in x.attrs) || (x.tag === "input" && x.attrs.type !== "hidden"));

function radios(r: HNode, name: string) {
  return all(r, (x) => x.tag === "input" && x.attrs.type === "radio" && x.attrs.name === name).map((x) => ({
    value: x.attrs.value,
    checked: "checked" in x.attrs,
    disabled: "disabled" in x.attrs,
    node: x,
  }));
}
const buttonsOf = (r: HNode) => tags(r, "button").map((b) => ({ name: accName(r, b), text: flat(b), disabled: "disabled" in b.attrs, node: b }));
const buttonNamed = (r: HNode, re: RegExp) => {
  const hits = buttonsOf(r).filter((b) => re.test(b.name));
  assert.equal(hits.length, 1, `one button ${re}; saw: ${buttonsOf(r).map((b) => b.name).join(" | ")}`);
  return hits[0];
};
/** The text of every alert, with the control (by id) its sentence is tied to. */
function alerts(r: HNode) {
  return all(r, (x) => x.attrs.role === "alert").map((a) => ({ id: a.attrs.id, text: flat(a) }));
}
const describedBy = (r: HNode, el: HNode) => (el.attrs["aria-describedby"] ?? "").split(/\s+/).filter(Boolean).map((id) => byId(r, id)).filter((x): x is HNode => x !== null);

// ═══ cases for the child process ═════════════════════════════════════════

type Case = { id: string; kind: "section" | "page"; props: Record<string, unknown>; profile?: unknown };
const ready = <T,>(data: T) => ({ kind: "ready" as const, data });
const base = (extra: Record<string, unknown> = {}, ctx: GuidedContextView = CTX, list: GuidedAutomationView[] = []): Case["props"] => ({
  nowMs: NOW,
  initialContext: ready(ctx),
  initialList: ready(list),
  ...extra,
});
const at = (step: string, draft: Draft, extra: Record<string, unknown> = {}) => ({ initialBuilder: { step, draft, ...extra } });

const FOLLOWUP = draftOf("followup_drafts", "sales");
const FOLLOWUP_ITEM = itemFrom(FOLLOWUP, "paused", { id: "f1" });
const savedFor = (draft: Draft, item = itemFrom(draft, "paused")) => {
  const v = validateDraft(draft, CTX);
  assert.ok(v.ok);
  return { item, snapshot: snapshotOf(draft.name, v.ok ? v.payload : null) };
};
const savedFollowup = savedFor(FOLLOWUP, FOLLOWUP_ITEM);

const LIST_ITEMS: GuidedAutomationView[] = [
  itemFrom(draftOf("daily_brief", "chief_of_staff", (d) => setName(d, "Morning brief")), "on", {
    id: "i1",
    lastRun: { at: new Date(NOW - 20 * 3_600_000).toISOString(), status: "done", summary: "Five things are waiting on you.", receiptId: "r9", preview: false },
  }),
  itemFrom(draftOf("followup_drafts", "sales", (d) => setName(d, "Overdue follow-ups")), "paused", {
    id: "i2",
    lastRun: { at: new Date(NOW - 3_600_000).toISOString(), status: "done", summary: "Two drafts would have been filed.", receiptId: "r8", preview: true },
  }),
  itemFrom(draftOf("support_risk", "client_success", (d) => setName(d, "Late tickets")), "needs_attention", {
    id: "i3",
    lastRun: { at: new Date(NOW - 86_400_000).toISOString(), status: "failed", summary: "It could not read the tickets.", receiptId: null, preview: false },
    problems: [{ code: "connection_attention", message: "Help desk needs to be reconnected.", repair: { label: "Reconnect Help desk", href: "/settings/connections?fix=helpdesk" } }],
  }),
  itemFrom(draftOf("stalled_digest", "sales", (d) => setName(d, "Quiet leads")), "paused", { id: "i4" }),
];

const CASES: Case[] = [
  // the page
  { id: "page_off", kind: "page", props: { scriptAccess: "allowed" } },
  { id: "page_off_not_allowed", kind: "page", props: {} },
  { id: "page_on", kind: "page", props: { scriptAccess: "allowed", guidedEnabled: true } },
  { id: "page_on_not_allowed", kind: "page", props: { guidedEnabled: true } },
  { id: "page_on_signed_out", kind: "page", props: { guidedEnabled: true }, profile: null },

  // loading and could-not-load
  { id: "loading", kind: "section", props: {} },
  { id: "ctx_error", kind: "section", props: { initialContext: { kind: "error", message: "You do not have access to automations in this workspace.", repair: { label: "Open Settings", href: "/settings" } }, initialList: ready([]) } },
  { id: "list_error_only", kind: "section", props: { initialContext: ready(CTX), initialList: { kind: "error", message: "We could not reach the server. Check your connection and try again.", repair: null } } },

  // step 1
  { id: "dept", kind: "section", props: base() },
  { id: "dept_picked", kind: "section", props: base(at("department", pickDepartment(emptyDraft(), "client_success"))) },
  { id: "dept_limited", kind: "section", props: base({}, { ...CTX, departments: ["sales", "operations"], companyFinancials: false }) },
  { id: "dept_nofin", kind: "section", props: base({}, { ...CTX, companyFinancials: false }) },
  { id: "dept_none", kind: "section", props: base({}, { ...CTX, departments: [] }) },

  // step 2
  { id: "job_pick", kind: "section", props: base(at("job", pickDepartment(emptyDraft(), "sales"))) },
  { id: "job_followup", kind: "section", props: base(at("job", FOLLOWUP)) },
  { id: "job_support", kind: "section", props: base(at("job", draftOf("support_risk", "client_success"))) },
  { id: "job_marketing", kind: "section", props: base(at("job", draftOf("marketing_numbers", "marketing"))) },
  { id: "job_finance", kind: "section", props: base(at("job", draftOf("money_summary", "finance"))) },
  { id: "job_stalled_bad", kind: "section", props: base(at("job", setInput(draftOf("stalled_digest", "sales"), "days_quiet", 99), { touched: ["days_quiet"] })) },
  { id: "job_followup_bad_multi", kind: "section", props: base(at("job", setInput(FOLLOWUP, "max_drafts", 9), { touched: ["max_drafts", "goal", "tone", "schedule", "template"] })) },
  { id: "job_custom_all_touched", kind: "section", props: base(at("job", draftOf("custom", "sales"), { touched: ["objective", "tools", "output", "schedule", "template"] })) },
  { id: "job_stalled_bad_untouched", kind: "section", props: base(at("job", setInput(draftOf("stalled_digest", "sales"), "days_quiet", 99))) },
  { id: "job_custom_empty", kind: "section", props: base(at("job", draftOf("custom", "sales"))) },
  { id: "job_custom_empty_touched", kind: "section", props: base(at("job", draftOf("custom", "sales"), { touched: ["objective"] })) },
  { id: "job_custom_notools", kind: "section", props: base(at("job", setInput(draftOf("custom", "sales"), "objective", "Which leads have gone quiet?"), { touched: ["tools"] })) },
  { id: "job_custom_ready", kind: "section", props: base(at("job", setOutput(customDraft("sales", "Who needs a nudge this week?", ["pipeline_summary", "leads_search"]), "email_drafts"))) },
  { id: "job_custom_marketing", kind: "section", props: base(at("job", customDraft("marketing", "How are the numbers moving?", ["department_numbers"]))) },
  { id: "job_custom_cos", kind: "section", props: base(at("job", draftOf("custom", "chief_of_staff"))) },

  // step 3: When
  { id: "when_followup", kind: "section", props: base(at("when", FOLLOWUP)) },
  { id: "when_no_google", kind: "section", props: base(at("when", FOLLOWUP), CTX_NO_GOOGLE) },
  { id: "when_manual", kind: "section", props: base(at("when", setSchedulePreset(draftOf("daily_brief", "chief_of_staff"), "manual"))) },
  { id: "when_time_cleared", kind: "section", props: base(at("when", setScheduleTime(FOLLOWUP, ""), { touched: ["schedule"] })) },
  { id: "when_weekly", kind: "section", props: base(at("when", setScheduleTime(setScheduleDays(setSchedulePreset(draftOf("daily_brief", "chief_of_staff"), "monday_0800"), [1, 4]), "09:15"))) },
  { id: "when_dst", kind: "section", props: { ...base(at("when", draftOf("support_risk", "client_success", (d) => setSchedulePreset(d, "daily_0730")))), nowMs: Date.UTC(2026, 9, 30, 20, 0, 0) } },
  { id: "when_several", kind: "section", props: base(at("when", setScheduleTime(setSchedulePreset(draftOf("ops_check", "operations"), "every_6h"), "08:00"))) },

  // step 4: what it needs, on the last step
  { id: "needs_missing", kind: "section", props: base(at("review", FOLLOWUP), CTX_NO_GOOGLE) },
  { id: "needs_attention", kind: "section", props: base(at("review", FOLLOWUP), { ...CTX, connections: [{ slug: "google-workspace", label: "Google Workspace", state: "attention", repair: REPAIR_GOOGLE }] }) },
  { id: "needs_ok", kind: "section", props: base(at("review", FOLLOWUP)) },
  { id: "needs_unknown", kind: "section", props: base(at("review", FOLLOWUP), { ...CTX, connections: [] }) },
  { id: "needs_none", kind: "section", props: base(at("review", draftOf("daily_brief", "chief_of_staff"))) },
  { id: "needs_custom_drafts", kind: "section", props: base(at("review", setOutput(customDraft("sales"), "email_drafts")), CTX_NO_GOOGLE) },
  { id: "needs_ai_not_ready", kind: "section", props: base(at("review", FOLLOWUP), { ...CTX, cloud: { ready: false, reason: "No AI account is connected to this workspace.", repair: { label: "Connect an AI account", href: "/settings/ai" } } }) },

  // step 4
  { id: "review_new", kind: "section", props: base(at("review", FOLLOWUP)) },
  { id: "review_daily", kind: "section", props: base(at("review", draftOf("daily_brief", "chief_of_staff"))) },
  { id: "review_stalled", kind: "section", props: base(at("review", draftOf("stalled_digest", "sales", (d) => setInput(d, "days_quiet", 10)))) },
  { id: "review_money", kind: "section", props: base(at("review", draftOf("money_summary", "finance", (d) => setInput(d, "metric", "mrr")))) },
  { id: "review_custom", kind: "section", props: base(at("review", customDraft("sales", "Which leads have not replied?", ["pipeline_summary", "leads_search"]))) },
  { id: "review_unnamed", kind: "section", props: base(at("review", setName(FOLLOWUP, ""), { touched: ["name"] })) },
  { id: "review_saved", kind: "section", props: base(at("review", FOLLOWUP, { saved: savedFollowup })) },
  { id: "review_tested", kind: "section", props: base(at("review", FOLLOWUP, { saved: savedFollowup, test: { result: RESULT_DRAFTS, failure: null, forSnapshot: savedFollowup.snapshot } })) },
  { id: "review_test_failed", kind: "section", props: base(at("review", FOLLOWUP, { saved: savedFollowup, test: { result: { runId: "r3", status: "failed", finalText: "", wouldDraft: [], failure: "It could not read the pipeline." }, failure: null, forSnapshot: savedFollowup.snapshot } })) },
  { id: "review_test_refused", kind: "section", props: base(at("review", FOLLOWUP, { saved: savedFollowup, test: { result: null, failure: toFailure(failure({ error: "rate_limited", message: "You have run too many tests. Wait a minute." })), forSnapshot: savedFollowup.snapshot } })) },
  { id: "review_activation_refused", kind: "section", props: base(at("review", FOLLOWUP, { saved: savedFollowup, test: { result: RESULT_OK, failure: null, forSnapshot: savedFollowup.snapshot }, activation: { failure: toFailure(failure({ error: "connection_missing", message: "Google Workspace is not connected, so this cannot be turned on.", repair: REPAIR_GOOGLE, problems: [{ code: "connection_missing", message: "Google Workspace needs to be connected.", repair: REPAIR_GOOGLE }] })), item: null } })) },
  { id: "review_on", kind: "section", props: base(at("review", draftOf("stalled_digest", "sales"), { saved: savedFor(draftOf("stalled_digest", "sales"), itemFrom(draftOf("stalled_digest", "sales"), "on", { id: "s1" })), test: { result: RESULT_OK, failure: null, forSnapshot: savedFor(draftOf("stalled_digest", "sales")).snapshot } })) },
  { id: "review_dirty", kind: "section", props: base(at("review", setInput(FOLLOWUP, "max_drafts", 2), { saved: savedFollowup, test: { result: RESULT_DRAFTS, failure: null, forSnapshot: savedFollowup.snapshot } })) },
  { id: "review_save_failed", kind: "section", props: base(at("review", FOLLOWUP, { saveFailure: toFailure(failure({ error: "forbidden", message: "Only owners and admins can save automations." })) })) },
  { id: "review_apps_blocked", kind: "section", props: base(at("review", FOLLOWUP, { saved: savedFollowup, test: { result: RESULT_DRAFTS, failure: null, forSnapshot: savedFollowup.snapshot } }), CTX_NO_GOOGLE) },
  { id: "review_cloud_blocked", kind: "section", props: base(at("review", FOLLOWUP, { saved: savedFollowup, skipTest: true }), { ...CTX, cloud: { ready: false, reason: "No AI account is connected to this workspace.", repair: { label: "Connect an AI account", href: "/settings/ai" } } }) },
  { id: "review_skip", kind: "section", props: base(at("review", FOLLOWUP, { saved: savedFollowup })) },
  { id: "review_skip_confirmed", kind: "section", props: base(at("review", FOLLOWUP, { saved: savedFollowup, skipTest: true })) },
  { id: "review_edit", kind: "section", props: base({ initialBuilder: editSession(LIST_ITEMS[1], CTX) }, CTX, LIST_ITEMS) },
  { id: "review_edit_gone", kind: "section", props: base({ initialBuilder: editSession({ ...LIST_ITEMS[1], payload: { ...LIST_ITEMS[1].payload, template: { id: "retired_job", version: 1 } } }, CTX) }) },

  // the list
  { id: "list_items", kind: "section", props: base({}, CTX, LIST_ITEMS) },
  { id: "list_empty", kind: "section", props: base({}, CTX, []) },
  { id: "list_empty_with_others", kind: "section", props: { ...base({}, CTX, []), othersText: "Daily Automation Register" } },
  { id: "list_items_with_others", kind: "section", props: { ...base({}, CTX, LIST_ITEMS), othersText: "Daily Automation Register" } },
  { id: "list_confirm", kind: "section", props: base({ initialRows: { i2: { confirmDelete: true } } }, CTX, LIST_ITEMS) },
  { id: "list_row_failure", kind: "section", props: base({ initialRows: { i1: { note: { kind: "failure", failure: toFailure(failure({ error: "connection_missing", message: "Google Workspace is not connected.", repair: REPAIR_GOOGLE })) } } } }, CTX, LIST_ITEMS) },
  { id: "list_row_test", kind: "section", props: base({ initialRows: { i2: { note: { kind: "test", result: RESULT_DRAFTS } } } }, CTX, LIST_ITEMS) },
  { id: "list_row_text", kind: "section", props: base({ initialRows: { i1: { note: { kind: "text", text: "Paused. It will not run until you turn it on." } } } }, CTX, LIST_ITEMS) },
  { id: "list_no_clock", kind: "section", props: { initialContext: ready(CTX), initialList: ready(LIST_ITEMS) } },
];

/** Per page case, the props the page handed its scheduled-jobs list (CronJobsManager), as the render saw them. */
const olderListProps: Record<string, Record<string, unknown> | null> = {};

function renderMarkup(cases: Case[]): Record<string, string> {
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/guided-automations-ui.render.ts"], {
    cwd: root,
    input: JSON.stringify({ cases }),
    encoding: "utf8",
    // CI sets NODE_OPTIONS=--conditions=react-server for the whole step; react-dom/server refuses to
    // load under it, so the child drops it.
    env: { ...process.env, NODE_OPTIONS: "" },
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `render failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout) as { markup: Record<string, string>; olderList?: Record<string, Record<string, unknown> | null> };
  Object.assign(olderListProps, out.olderList ?? {});
  return out.markup;
}

// ═══ the driven half: React's state hooks stood in for ═══════════════════

// tsconfig sets jsx:"preserve": tsx compiles component JSX with the classic runtime.
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS export object is the one the components read
const R = require("react") as Record<string, unknown>;
let slots: unknown[] = [];
let cursor = 0;
R.useState = (init: unknown) => {
  const i = cursor++;
  const own = slots;
  if (!(i in own)) own[i] = typeof init === "function" ? (init as () => unknown)() : init;
  return [own[i], (v: unknown) => (own[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(own[i]) : v)];
};
R.useRef = (init: unknown) => {
  const i = cursor++;
  if (!(i in slots)) slots[i] = { current: init };
  return slots[i];
};
// Effects need a DOM and never run here. The builder's one effect moves focus to the step heading.
R.useEffect = () => undefined;
R.useCallback = (fn: unknown) => fn;

function mount<P>(component: (props: P) => unknown, props: () => P) {
  const own: unknown[] = [];
  return () => {
    slots = own;
    cursor = 0;
    return component(props());
  };
}
/** Let every promise the last click started finish: the components call their handlers as `void save()`. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type El = { type: unknown; props: Record<string, unknown> };
/** Every element, with plain function components expanded (the hooks live in the root only). */
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (isValidElement(node)) {
    const el = node as unknown as El;
    if (typeof el.type === "function") return elements((el.type as (p: unknown) => unknown)(el.props), out);
    out.push(el);
    elements(el.props.children as ReactNode, out);
  }
  return out;
}
function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement(node)) {
    const el = node as unknown as El;
    if (typeof el.type === "function") return ` ${text((el.type as (p: unknown) => unknown)(el.props))} `;
    return ` ${text(el.props.children as ReactNode)} `;
  }
  return "";
}
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** One frame of a mounted component, with helpers to find controls the way a person would. */
function frame(view: () => unknown) {
  const tree = view();
  const els = elements(tree);
  // A second walk of the same tree starts its hooks from the top again, like the next render would.
  cursor = 0;
  const words = squash(text(tree));
  const radio = (name: string, value: string) => {
    const found = els.filter((e) => e.type === "input" && e.props.type === "radio" && e.props.name === name && e.props.value === value);
    assert.equal(found.length, 1, `radio ${name}=${value} in: ${words.slice(0, 300)}`);
    return found[0];
  };
  const buttons = (re: RegExp) => els.filter((e) => e.type === "button" && (re.test(squash(text(e.props.children))) || re.test(String(e.props["aria-label"] ?? ""))));
  const button = (re: RegExp) => {
    const found = buttons(re);
    assert.equal(found.length, 1, `one button ${re} in: ${words.slice(0, 400)}`);
    return found[0];
  };
  const input = (id: string) => {
    const found = els.filter((e) => e.type === "input" && e.props.id === id);
    assert.equal(found.length, 1, `input #${id}`);
    return found[0];
  };
  return { tree, els, words, radio, button, buttons, input };
}
type Frame = ReturnType<typeof frame>;
const pick = (el: El) => (el.props.onChange as () => void)();
const tick = (el: El, checked: boolean) => (el.props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked } });
const typeInto = (el: El, value: string) => (el.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
const press = async (el: El) => {
  assert.notEqual(el.props.disabled, true, `the button "${squash(text(el.props.children))}" is disabled`);
  await (el.props.onClick as () => unknown)();
  await settle();
};
const isDisabled = (el: El) => el.props.disabled === true;

// ═══ the checks ══════════════════════════════════════════════════════════

async function main() {
  console.log("guided-automations-ui:");
  const markup = renderMarkup(CASES);
  const dom: Record<string, HNode> = {};
  for (const [id, html] of Object.entries(markup)) dom[id] = parse(html);
  const guided = (id: string) => {
    // The page cases keep only the builder's own words: the header, then the builder and its rows, without
    // the older parts of the page (the connection banner, the scheduled-jobs list inside Your automations,
    // the explainer), which keep their own copy.
    const html = markup[id];
    if (!id.startsWith("page_")) return html;
    const banner = html.indexOf('<div class="rounded-xl border border-bg-border bg-bg-deep/40 p-4 flex items-start gap-3">');
    const builder = html.indexOf('<div class="space-y-8">');
    const older = html.indexOf('<div data-testid="automations-made-before">');
    if (banner < 0 || builder < 0 || older < 0) return html;
    return html.slice(0, banner) + html.slice(builder, older);
  };
  const sectionIds = CASES.filter((c) => c.kind === "section").map((c) => c.id);
  const textOnly = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  const attrText = (html: string) => [...html.matchAll(/\b(?:aria-label|placeholder|title|alt)="([^"]*)"/g)].map((m) => decode(m[1])).join(" ");

  // ── step 1 ──
  await check("Department: one card per department the person may build for, with its purpose and its template count from the catalogue", () => {
    const r = dom.dept;
    const cards = radios(r, "department");
    assert.deepEqual(cards.map((c) => c.value), ALL_DEPARTMENTS, "all six, in order");
    for (const d of ALL_DEPARTMENTS) {
      const label = byId(r, `gb-department-${d}-t`);
      const desc = byId(r, `gb-department-${d}-d`);
      assert.equal(flat(label), departmentLabel(d));
      assert.ok(flat(desc).startsWith(departmentPurpose(d)), `${d}: purpose`);
      const n = readyMadeCount(d, CTX);
      assert.ok(flat(desc).endsWith(`${n} ready-made ${n === 1 ? "job" : "jobs"}`), `${d}: count ${n}`);
    }
    assert.equal(flat(byId(r, "gb-department-client_success-t")), "Support");
    assert.ok(cards.every((c) => !c.checked), "nothing is chosen before the person chooses");
  });

  await check("Department: Finance only with company financials; the list is restricted to the person's departments; none says so", () => {
    assert.ok(!radios(dom.dept_nofin, "department").some((c) => c.value === "finance"));
    assert.deepEqual(radios(dom.dept_limited, "department").map((c) => c.value), ["sales", "operations"]);
    assert.equal(radios(dom.dept_none, "department").length, 0);
    assert.match(flat(dom.dept_none), /You do not have access to any part of this workspace yet/);
  });

  await check("Department: the chosen one is checked, and the heading names the step", () => {
    assert.deepEqual(radios(dom.dept_picked, "department").filter((c) => c.checked).map((c) => c.value), ["client_success"]);
    const h3 = tags(dom.dept, "h3")[0];
    assert.equal(flat(h3), "What part of your business is this for?");
  });

  // ── step 2 ──
  await check("Job: one card per template of the department, from the catalogue, the custom brief last", () => {
    const r = dom.job_pick;
    const cards = radios(r, "job");
    const expected = templatesFor("sales", { companyFinancials: true });
    assert.deepEqual(cards.map((c) => c.value), expected.map((t) => t.id));
    assert.equal(cards[cards.length - 1].value, "custom", "Something else is last");
    for (const t of expected) {
      assert.equal(flat(byId(r, `gb-job-${t.id}-t`)), t.title);
      const body = flat(byId(r, `gb-job-${t.id}-d`));
      assert.ok(body.includes(t.promise), `${t.id}: promise`);
      assert.ok(body.includes("Example of what you get (made-up names and numbers)"), `${t.id}: the example is labelled as made up`);
      assert.ok(body.includes(t.example.replace(/\s+/g, " ")), `${t.id}: the example itself`);
      assert.ok(body.includes(t.never), `${t.id}: what it never does`);
    }
    assert.ok(cards.every((c) => !c.checked));
    assert.equal(tags(r, "h4").length, 0, "no settings or schedule before a job is chosen");
    assert.ok(hasClass(closest(cards[cards.length - 1].node, "label")!, "border-dashed"), "the custom card is set apart");
  });

  await check("Job: every department shows only its own templates (Support, Marketing, Finance, Operations and Chief of Staff)", () => {
    const seen: Array<[string, string[]]> = [
      ["job_support", ["support_risk", "custom"]],
      ["job_marketing", ["marketing_numbers", "custom"]],
      ["job_finance", ["money_summary", "custom"]],
      ["job_followup", ["followup_drafts", "stalled_digest", "custom"]],
    ];
    for (const [id, expected] of seen) assert.deepEqual(radios(dom[id], "job").map((c) => c.value), expected, id);
    assert.equal(flat(tags(dom.job_support, "legend")[0]), "Jobs for Support");
  });

  await check("Job: a ready-made job shows its typed settings (segmented, list, stepper) with labels and the unit", () => {
    const r = dom.job_followup;
    const drafts = byId(r, "gb-in-max_drafts");
    assert.equal(drafts.attrs.type, "number");
    assert.equal(drafts.attrs.min, "1");
    assert.equal(drafts.attrs.max, "3");
    assert.equal(drafts.attrs.value, "3");
    assert.ok(flat(drafts.parent!.parent).includes("drafts"), "the unit sits beside the number");
    assert.ok(flat(drafts.parent!.parent!.parent).includes("1 to 3"), "the range is stated");
    const label = all(r, (x) => x.tag === "label" && x.attrs.for === "gb-in-max_drafts")[0];
    assert.equal(flat(label), "At most this many drafts per run");
    assert.deepEqual(radios(r, "gb-in-tone").map((c) => [c.value, c.checked]), [["friendly", true], ["direct", false], ["formal", false]], "tone is a segmented control");
    assert.deepEqual(radios(r, "gb-in-goal").map((c) => [c.value, c.checked]), [["book_call", true], ["check_in", false], ["re_engage", false]], "the long answers are a list");
    for (const name of ["gb-in-tone", "gb-in-goal"]) assert.ok(radios(r, name).every((c) => closest(c.node, "label")), `${name}: every option has a label`);
    const decrease = buttonsOf(r).find((b) => /^Decrease/.test(b.name))!;
    assert.ok(decrease.disabled === false, "the default 3 can still go down");
    const increase = buttonsOf(r).find((b) => /^Increase/.test(b.name))!;
    assert.ok(increase.disabled, "3 is the most, so Increase is off");
  });

  await check("Job: a job with nothing to set up says so", () => {
    assert.match(flat(dom.job_marketing), /This job has nothing to set up/);
  });

  await check("When: How often offers one plain answer per kind of schedule, with What time of day and the next three runs", () => {
    const r = dom.when_followup;
    const t = templateById("followup_drafts", "sales")!;
    assert.equal(flat(tags(r, "h3")[0]), "When should it run?");
    const often = radios(r, "gb-when");
    assert.deepEqual(often.map((c) => c.value), t.schedulePresets.map((p) => p.id));
    assert.deepEqual(often.map((c) => flat(closest(c.node, "label"))), ["Monday to Friday", "On certain days of the week"]);
    assert.equal(often.filter((c) => c.checked).length, 1);
    assert.match(flat(r), /How often should it run\?/);
    const heading = all(r, (x) => x.tag === "p" && flat(x) === "Next runs:");
    assert.equal(heading.length, 1);
    const items = tags(heading[0].parent!, "li").map((li) => flat(li));
    const expected = nextRunsView(planFor(t, { presetId: t.schedulePresets[0].id })!, new Date(NOW));
    assert.deepEqual(items, expected.kind === "runs" ? expected.lines : []);
    assert.deepEqual(items, ["Thu, Oct 15, 9:00 AM EDT", "Fri, Oct 16, 9:00 AM EDT", "Mon, Oct 19, 9:00 AM EDT"]);
    const time = byId(r, "gb-when-time")!;
    assert.equal(time.attrs.value, "09:00");
    assert.equal(flat(all(r, (x) => x.tag === "label" && x.attrs.for === "gb-when-time")[0]), "What time of day?");
    assert.equal(byId(r, "gb-when-days"), null, "no day question for Monday to Friday");
    assert.equal(radios(r, "gb-when-count").length, 0, "no times-a-day question for a once-a-day job");
  });

  await check("When: next runs follow the clock across the fall-back weekend (EDT then EST)", () => {
    const items = tags(all(dom.when_dst, (x) => x.tag === "p" && flat(x) === "Next runs:")[0].parent!, "li").map(flat);
    assert.deepEqual(items, ["Sat, Oct 31, 7:30 AM EDT", "Sun, Nov 1, 7:30 AM EST", "Mon, Nov 2, 7:30 AM EST"]);
  });

  await check("When: Only when I ask says it runs when you press Test now, with no time question", () => {
    const r = dom.when_manual;
    assert.equal(radios(r, "gb-when").find((c) => c.checked)!.value, "manual");
    assert.equal(flat(closest(radios(r, "gb-when").find((c) => c.checked)!.node, "label")), "Only when I ask");
    assert.match(flat(r), /Runs only when you press Test now on its card\./);
    assert.equal(all(r, (x) => x.tag === "p" && flat(x) === "Next runs:").length, 0);
    assert.equal(byId(r, "gb-when-time"), null);
  });

  await check("When: On certain days of the week asks Which days? and keeps the time chosen", () => {
    const r = dom.when_weekly;
    const dayInputs = all(r, (x) => x.tag === "input" && x.attrs.name === "gb-when-days");
    assert.equal(dayInputs.length, 7);
    assert.deepEqual(dayInputs.filter((d) => "checked" in d.attrs).map((d) => accName(r, d)), ["Monday", "Thursday"]);
    assert.match(flat(r), /Which days\?/);
    assert.equal(byId(r, "gb-when-time")!.attrs.value, "09:15");
    assert.equal(flat(closest(radios(r, "gb-when").find((c) => c.checked)!.node, "label")), "On certain days of the week");
  });

  await check("When: Several times a day asks for the first time and How many times a day?, each answer with its times", () => {
    const r = dom.when_several;
    assert.equal(flat(closest(radios(r, "gb-when").find((c) => c.checked)!.node, "label")), "Several times a day");
    assert.equal(flat(all(r, (x) => x.tag === "label" && x.attrs.for === "gb-when-time")[0]), "What time is the first one?");
    assert.match(flat(r), /How many times a day\?/);
    const counts = radios(r, "gb-when-count");
    const t = templateById("ops_check", "operations")!;
    const expected = timesADayOptions(t, { presetId: "every_6h", time: "08:00" }, "digest");
    assert.deepEqual(counts.map((c) => c.value), expected.map((o) => String(o.everyHours)));
    assert.deepEqual(counts.filter((c) => c.checked).map((c) => c.value), ["6"], "the job's own interval until the person answers");
    const three = closest(counts.find((c) => c.value === "6")!.node, "label")!;
    assert.equal(flat(three), "3 times a day 8:00 AM, 2:00 PM and 8:00 PM");
    const items = tags(all(r, (x) => x.tag === "p" && flat(x) === "Next runs:")[0].parent!, "li").map(flat);
    assert.deepEqual(items, ["Thu, Oct 15, 2:00 PM EDT", "Thu, Oct 15, 8:00 PM EDT", "Fri, Oct 16, 8:00 AM EDT"]);
  });

  await check("Job: the custom brief has an objective with a live counter, the department's reads as a checklist, and the result choice", () => {
    const r = dom.job_custom_empty;
    const objective = byId(r, "gb-in-objective");
    assert.equal(objective.attrs.type, "text");
    assert.equal(objective.attrs.placeholder, "e.g. Which leads from this week have not had a reply?");
    assert.equal(flat(byId(r, "gb-in-objective-count")), "0 of 400 characters");
    assert.ok(describedBy(r, objective).some((n) => n.attrs.id === "gb-in-objective-count"), "the counter is read with the field");
    const boxes = all(r, (x) => x.tag === "input" && x.attrs.type === "checkbox" && x.attrs.name === "tools");
    const reads = readToolsFor("sales");
    assert.deepEqual(boxes.map((b) => b.attrs.id), reads.map((t) => `gb-tool-${t}`));
    for (const t of reads) {
      assert.equal(flat(byId(r, `gb-tool-${t}-t`)), DESK_TOOLS[t].label);
      assert.equal(flat(byId(r, `gb-tool-${t}-d`)), DESK_TOOLS[t].summary);
    }
    assert.ok(boxes.every((b) => !("checked" in b.attrs)), "nothing is ticked until the person ticks it");
    assert.ok(!boxes.some((b) => b.attrs.id === "gb-tool-propose_email"), "the email draft tool is never a tick box");
    assert.deepEqual(radios(r, "gb-output").map((c) => [c.value, c.checked, c.disabled]), [["digest", true, false], ["email_drafts", false, false]]);
    assert.ok(boxes.length > 0 && readToolsFor("chief_of_staff").length === all(dom.job_custom_cos, (x) => x.tag === "input" && x.attrs.type === "checkbox" && x.attrs.name === "tools").length);
  });

  await check("Job: the custom brief's emails option is off, with its reason, in a department that cannot draft emails", () => {
    const r = dom.job_custom_marketing;
    assert.deepEqual(radios(r, "gb-output").map((c) => [c.value, c.disabled]), [["digest", false], ["email_drafts", true]]);
    assert.match(flat(r), /Marketing cannot draft emails yet/);
    const ready = dom.job_custom_ready;
    assert.match(flat(ready), /Each email waits in Needs you until a person approves it\. Nothing is sent without that\./);
    assert.deepEqual(radios(ready, "gb-output").filter((c) => c.checked).map((c) => c.value), ["email_drafts"]);
    assert.equal(all(ready, (x) => x.tag === "input" && x.attrs.type === "checkbox" && "checked" in x.attrs).length, 2);
  });

  // ── gating ──
  await check("gating: Next is off until the step is complete, and the reason is said beside it", () => {
    const why = (id: string) => {
      const next = buttonsOf(dom[id]).find((b) => /^Next:/.test(b.name))!;
      return { next, why: flat(byId(dom[id], "gb-next-why")) };
    };
    const noDept = why("dept");
    assert.ok(noDept.next.disabled);
    assert.equal(noDept.why, "Pick an area of your business to continue.");
    assert.equal(noDept.next.name, "Next: Job");
    assert.equal(noDept.next.node.attrs["aria-describedby"], "gb-next-why");
    assert.ok(!why("dept_picked").next.disabled, "a department is chosen");
    assert.equal(byId(dom.dept_picked, "gb-next-why"), null, "no reason when nothing blocks");

    const noJob = why("job_pick");
    assert.ok(noJob.next.disabled, "cannot go Next without a template");
    assert.equal(noJob.why, "Pick a job to continue.");
    assert.ok(!why("job_followup").next.disabled);
    assert.equal(why("job_followup").next.name, "Next: When");
    assert.ok(!why("job_marketing").next.disabled, "a job with nothing to set up is complete");
  });

  await check("gating: the custom brief needs an objective and at least one ticked read", () => {
    const empty = buttonsOf(dom.job_custom_empty).find((b) => /^Next:/.test(b.name))!;
    assert.ok(empty.disabled);
    assert.match(flat(byId(dom.job_custom_empty, "gb-next-why")), /What should it look into\?/);
    const noTools = buttonsOf(dom.job_custom_notools).find((b) => /^Next:/.test(b.name))!;
    assert.ok(noTools.disabled);
    assert.equal(flat(byId(dom.job_custom_notools, "gb-next-why")), "Tick at least one thing it may read.");
    const ok = buttonsOf(dom.job_custom_ready).find((b) => /^Next:/.test(b.name))!;
    assert.ok(!ok.disabled);
  });

  await check("gating: When lets the person move on with an app missing; a cleared time holds them with the reason", () => {
    for (const id of ["when_followup", "when_no_google", "when_manual", "when_weekly", "when_several"]) {
      const next = buttonsOf(dom[id]).find((b) => /^Next:/.test(b.name))!;
      assert.ok(next, id);
      assert.equal(next.name, "Next: Finish", id);
      assert.equal(next.disabled, false, id);
    }
    const cleared = buttonsOf(dom.when_time_cleared).find((b) => /^Next:/.test(b.name))!;
    assert.ok(cleared.disabled);
    assert.match(flat(byId(dom.when_time_cleared, "gb-next-why")), /Pick a time of day/);
    assert.equal(buttonsOf(dom.review_new).filter((b) => /^Next:/.test(b.name)).length, 0, "the last step has no Next");
  });

  // ── validation sentences at the field ──
  await check("validation: the validator's sentence appears under the field it names, tied to it and announced", () => {
    const r = dom.job_stalled_bad;
    const input = byId(r, "gb-in-days_quiet");
    const msg = '"Count a lead as stalled after" must be a whole number from 3 to 30.';
    const err = byId(r, "gb-in-days_quiet-error");
    assert.equal(flat(err), msg);
    assert.equal(err.attrs.role, "alert");
    assert.ok(describedBy(r, input).includes(err), "the field points at its error");
    assert.equal(input.attrs["aria-invalid"], "true");
    assert.deepEqual(alerts(r).map((a) => a.text), [msg], "only that one sentence is announced");
    // The reason Next is waiting is the same sentence.
    assert.equal(flat(byId(r, "gb-next-why")), msg);
  });

  await check("validation: with several fields touched, the sentence is shown at the one field the validator names and nowhere else", () => {
    const r = dom.job_followup_bad_multi;
    const msg = '"At most this many drafts per run" must be a whole number from 1 to 3.';
    assert.deepEqual(alerts(r), [{ id: "gb-in-max_drafts-error", text: msg }]);
    assert.equal(byId(r, "gb-in-goal-error"), null);
    assert.equal(byId(r, "gb-in-tone-error"), null);
    assert.equal(byId(r, "gb-when-error"), null);
    const c = dom.job_custom_all_touched;
    assert.deepEqual(alerts(c).map((a) => a.id), ["gb-in-objective-error"], "the reads, the result and the schedule are fine, so only the objective is refused");
  });

  await check("validation: an untouched field shows no error yet, only the reason beside Next", () => {
    const r = dom.job_stalled_bad_untouched;
    assert.equal(byId(r, "gb-in-days_quiet-error"), null);
    assert.equal(alerts(r).length, 0);
    assert.match(flat(byId(r, "gb-next-why")), /whole number from 3 to 30/);
    assert.equal(alerts(dom.job_custom_empty).length, 0, "an empty required field is not an error before it is touched");
  });

  await check("validation: the objective's sentence, the reads' sentence and the schedule's sentence each land at their own field", () => {
    const o = byId(dom.job_custom_empty_touched, "gb-in-objective-error");
    assert.match(flat(o), /Tell us a little more in "What should it look into\?" \(at least 5 characters\)\./);
    assert.ok(describedBy(dom.job_custom_empty_touched, byId(dom.job_custom_empty_touched, "gb-in-objective")).includes(o));
    const tools = byId(dom.job_custom_notools, "gb-tools-error");
    assert.equal(flat(tools), "Tick at least one thing it may read.");
    assert.equal(tools.parent!.tag, "fieldset", "the error sits in the reads group");
    assert.equal(byId(dom.job_custom_notools, "gb-in-objective-error"), null, "not under the objective");
    const sched = byId(dom.when_time_cleared, "gb-when-error");
    assert.match(flat(sched), /Pick a time of day, written like 09:00\./);
    assert.equal(sched.attrs.role, "alert");
  });

  await check("validation: the counter turns into a refusal when the objective is over its limit", () => {
    const over = renderMarkup([{ id: "over", kind: "section", props: base(at("job", setTool(setInput(draftOf("custom", "sales"), "objective", "x".repeat(412)), "leads_search", true), { touched: ["objective"] })) }]).over;
    const r = parse(over);
    assert.equal(flat(byId(r, "gb-in-objective-count")), "412 of 400 characters");
    assert.ok(hasClass(byId(r, "gb-in-objective-count")!, "text-status-hot"));
    assert.match(flat(byId(r, "gb-in-objective-error")), /at most 400 characters/);
    assert.equal(byId(r, "gb-in-objective")!.attrs.maxlength, undefined, "typing past the limit is told, never silently cut");
  });

  // ── what it needs, on the last step ──
  await check("Finish: Before it can run lists the AI account and every app the job needs, each with its state and a real repair link", () => {
    const missing = dom.needs_missing;
    assert.match(flat(missing), /Before it can run/);
    const [ai, google] = appRows(missing);
    assert.match(flat(ai), /Your AI account\s*Ready/);
    assert.match(flat(google), /Google Workspace/);
    assert.match(flat(google), /Not connected/);
    const link = tags(google, "a")[0];
    assert.equal(link.attrs.href, REPAIR_GOOGLE.href);
    assert.equal(link.attrs.target, "_blank");
    assert.match(link.attrs.rel, /noopener/);
    assert.match(flat(link), /^Connect Google Workspace \(opens in a new tab\)$/);
    assert.match(flat(missing), /You can save it now and connect what is missing later\. It can only be turned on once everything above is ready\./);
    assert.ok(buttonsOf(missing).some((b) => b.name === "I fixed it, check again"));
    const att = appRows(dom.needs_attention)[1];
    assert.match(flat(att), /Needs attention/);
    assert.equal(tags(att, "a")[0].attrs.href, REPAIR_GOOGLE.href);
    const ok = dom.needs_ok;
    assert.match(flat(appRows(ok)[1]), /Connected/);
    assert.equal(tags(appRows(ok)[1], "a").length, 0, "a connected app needs no repair link");
    assert.match(flat(ok), /Everything it needs is ready\. It runs on OASIS's servers, so your computer can be off\./);
    assert.ok(!buttonsOf(ok).some((b) => b.name === "I fixed it, check again"), "nothing to check again");
  });

  await check("Finish: a job with no apps lists only the AI account; an app the list did not name is unchecked, not hidden; custom drafts need Google Workspace", () => {
    assert.equal(appRows(dom.needs_none).length, 1);
    assert.match(flat(appRows(dom.needs_none)[0]), /Your AI account/);
    const unknown = appRows(dom.needs_unknown)[1];
    assert.match(flat(unknown), /Google Workspace/);
    assert.match(flat(unknown), /We could not check this app/);
    assert.match(flat(appRows(dom.needs_custom_drafts)[1]), /Google Workspace.*Not connected/);
  });

  await check("Finish: an AI account that is not ready says so in plain words, with the reason and the link to fix it", () => {
    const r = dom.needs_ai_not_ready;
    const ai = appRows(r)[0];
    assert.match(flat(ai), /Your AI account\s*Not ready\s*No AI account is connected to this workspace\./);
    assert.equal(tags(ai, "a")[0].attrs.href, "/settings/ai");
    assert.doesNotMatch(flat(r), /\bCloud\b/, "no Cloud jargon");
  });

  // ── step 5 ──
  await check("Review: the sentence, the Never line and three actions in order: Save, Test now, Turn on", () => {
    const r = dom.review_new;
    const sentence = flat(byId(r, "gb-happen-h")!.parent!.kids.find((k) => k.tag === "p")!);
    assert.equal(sentence, reviewSentence(FOLLOWUP));
    assert.match(sentence, /^Every weekday \(Monday to Friday\) at 9:00 AM, Toronto time, your "Follow-up drafts" automation will find up to 3 leads/);
    assert.match(flat(byId(r, "gb-happen-h")!.parent), /Never sends an email\. Each draft waits in Needs you until a person approves it\./);
    const order = tags(r, "h5").map(flat);
    assert.deepEqual(order, ["Save", "Test now", "Turn on"]);
    const names = buttonsOf(r).filter((b) => ["Save", "Test now", "Turn on"].includes(b.name)).map((b) => b.name);
    assert.deepEqual(names, ["Save", "Test now", "Turn on"], "the buttons come in that order");
  });

  await check("Review: before the first save only Save is available; Save is the one primary action; the others say why not", () => {
    const r = dom.review_new;
    const save = buttonNamed(r, /^Save$/);
    const test = buttonNamed(r, /^Test now$/);
    const on = buttonNamed(r, /^Turn on$/);
    assert.deepEqual([save.disabled, test.disabled, on.disabled], [false, true, true]);
    assert.ok(hasClass(save.node, "btn-primary") && hasClass(test.node, "btn-secondary") && hasClass(on.node, "btn-secondary"));
    assert.equal(flat(byId(r, "gb-test-why")), "Save first. Test now runs the saved automation, once, as a preview.");
    assert.equal(flat(byId(r, "gb-activate-why")), "Save first.");
    assert.equal(test.node.attrs["aria-describedby"], "gb-test-why");
    assert.equal(tags(r, "button").filter((b) => hasClass(b, "btn-primary")).length, 1, "exactly one primary action on the step");
  });

  await check("Review: the sentence is built from the template, its settings, the schedule and the result, for several templates", () => {
    const cases: Array<[string, Draft, RegExp]> = [
      ["review_daily", draftOf("daily_brief", "chief_of_staff"), /your "Daily brief" automation will write you a short brief \(about 5 lines\) from your department numbers, the approvals waiting, the pipeline and today's calendar; each run's summary appears under Your automations\.$/],
      ["review_stalled", draftOf("stalled_digest", "sales", (d) => setInput(d, "days_quiet", 10)), /^Every weekday \(Monday to Friday\) at 8:30 AM, Toronto time, your "Stalled-lead digest" automation will list the leads with no activity for 10 days or more/],
      ["review_money", draftOf("money_summary", "finance", (d) => setInput(d, "metric", "mrr")), /^Every Monday at 7:00 AM, Toronto time, your "Weekly money summary" automation will report your recurring revenue from your Finance page/],
      ["review_custom", customDraft("sales", "Which leads have not replied?", ["pipeline_summary", "leads_search"]), /your custom automation will look into "Which leads have not replied\?" using pipeline and leads/],
    ];
    for (const [id, draft, re] of cases) {
      const s = flat(byId(dom[id], "gb-happen-h")!.parent!.kids.find((k) => k.tag === "p")!);
      assert.equal(s, reviewSentence(draft), id);
      assert.match(s, re, id);
    }
  });

  await check("Review: a name is required, and its sentence is tied to the field", () => {
    const r = dom.review_unnamed;
    const err = byId(r, "gb-name-error");
    assert.equal(flat(err), "Give it a name so you can find it in your list.");
    assert.ok(describedBy(r, byId(r, "gb-name")).includes(err));
    assert.ok(buttonNamed(r, /^Save$/).disabled);
    assert.equal(flat(byId(r, "gb-save-why")), "Give it a name to save.");
  });

  await check("Review: saved means paused in the server's words; Test now becomes the primary; Turn on waits for a test", () => {
    const r = dom.review_saved;
    assert.match(flat(r), /Saved and paused\. Nothing will run until you turn it on\./);
    const save = buttonNamed(r, /^Saved$/);
    const test = buttonNamed(r, /^Test now$/);
    const on = buttonNamed(r, /^Turn on$/);
    assert.deepEqual([save.disabled, test.disabled, on.disabled], [true, false, true]);
    assert.ok(hasClass(test.node, "btn-primary"));
    assert.equal(flat(byId(r, "gb-activate-why")), "Test it first, or confirm below that you want to skip the test.");
    const skip = all(r, (x) => x.tag === "input" && x.attrs.type === "checkbox")[0];
    assert.equal(accName(r, skip), "Turn it on without testing it first.");
    assert.ok(!("checked" in skip.attrs));
    assert.match(flat(r), /Build another automation/);
  });

  await check("Review: a finished test shows the run's text and every would-be draft marked Preview only", () => {
    const r = dom.review_tested;
    assert.match(flat(r), /The test finished\. This is what it found:/);
    assert.match(flat(r), /Two leads are overdue for a follow-up\./);
    assert.match(flat(r), /It would have drafted 2 emails:/);
    const cards = all(r, (x) => x.tag === "li" && hasClass(x, "border-dashed"));
    assert.equal(cards.length, 2);
    for (const c of cards) {
      assert.match(flat(c), /Preview only\. Nothing was sent or filed\./);
      assert.match(flat(c), /To: .*@example\.com/);
      assert.match(flat(c), /Subject: /);
    }
    assert.match(flat(cards[0]), /Subject: Checking in on the proposal/);
    assert.ok(hasClass(cards[0], "border-dashed"), "a preview card is drawn differently from a real draft");
    assert.ok(buttonNamed(r, /^Turn on$/).disabled === false, "tested, so Turn on is available");
    assert.ok(hasClass(buttonNamed(r, /^Turn on$/).node, "btn-primary"));
    assert.equal(all(r, (x) => x.tag === "input" && x.attrs.type === "checkbox").length, 0, "no skip box once tested");
  });

  await check("Review: a failed, cancelled or refused test says so and never reads as a pass", () => {
    const failed = dom.review_test_failed;
    assert.match(flat(failed), /It could not read the pipeline\./);
    assert.doesNotMatch(flat(failed), /The test finished/);
    assert.ok(buttonNamed(failed, /^Turn on$/).disabled, "a failed test does not unlock Turn on");
    assert.ok(alerts(failed).some((a) => /could not read the pipeline/.test(a.text)));
    const refused = dom.review_test_refused;
    assert.ok(alerts(refused).some((a) => a.text === "You have run too many tests. Wait a minute."));
    assert.ok(buttonNamed(refused, /^Turn on$/).disabled);
  });

  await check("Review: a refused Turn on shows the server's sentence, the repair link and each problem with its own link", () => {
    const r = dom.review_activation_refused;
    const a = alerts(r);
    assert.ok(a.some((x) => x.text === "Google Workspace is not connected, so this cannot be turned on."));
    const links = tags(r, "a").filter((l) => l.attrs.href === REPAIR_GOOGLE.href);
    assert.ok(links.length >= 2, "the repair link and the problem's link");
    assert.match(flat(r), /Google Workspace needs to be connected\./);
    assert.doesNotMatch(flat(r), /It is on\./, "a refusal is never shown as on");
  });

  await check("Review: when it is on, it says so, offers Pause, and does not offer Turn on again", () => {
    const r = dom.review_on;
    assert.match(flat(r), /It is on\. Next run: /);
    assert.equal(buttonsOf(r).filter((b) => b.name === "Turn on").length, 0);
    assert.ok(buttonsOf(r).some((b) => b.name === "Pause it" && !b.disabled));
  });

  await check("Review: a change after saving takes Test now and Turn on away until it is saved again", () => {
    const r = dom.review_dirty;
    assert.match(flat(r), /You have changes that are not saved yet\./);
    const save = buttonNamed(r, /^Save changes$/);
    assert.ok(!save.disabled && hasClass(save.node, "btn-primary"));
    assert.ok(buttonNamed(r, /^Test now$/).disabled);
    assert.ok(buttonNamed(r, /^Turn on$/).disabled);
    assert.equal(flat(byId(r, "gb-test-why")), "Save your changes first, then test.");
    assert.doesNotMatch(flat(r), /The test finished/, "the old test does not count for the new version");
    assert.doesNotMatch(flat(r), /Saved and paused/, "and the old save line is gone");
  });

  await check("Review: a missing app or an unready Cloud blocks Turn on only, says which, and links the fix", () => {
    const apps = dom.review_apps_blocked;
    assert.ok(buttonNamed(apps, /^Turn on$/).disabled);
    assert.equal(flat(byId(apps, "gb-activate-why")), "Connect Google Workspace first. You can keep it saved until then.");
    assert.equal(tags(apps, "a").filter((l) => l.attrs.href === REPAIR_GOOGLE.href).length, 1);
    assert.ok(buttonNamed(apps, /^Test now$/).disabled === false, "a missing app does not stop Test now");
    const cloud = dom.review_cloud_blocked;
    assert.ok(buttonNamed(cloud, /^Turn on$/).disabled);
    assert.equal(flat(byId(cloud, "gb-activate-why")), "Your AI account is not ready yet: No AI account is connected to this workspace.");
    assert.equal(tags(cloud, "a").filter((l) => l.attrs.href === "/settings/ai").length, 1);
  });

  await check("Review: the skip-the-test box is shown only for a saved, untested version, and ticking it unlocks Turn on", () => {
    const off = dom.review_skip;
    assert.ok(buttonNamed(off, /^Turn on$/).disabled);
    const on = dom.review_skip_confirmed;
    const box = all(on, (x) => x.tag === "input" && x.attrs.type === "checkbox")[0];
    assert.ok("checked" in box.attrs);
    assert.ok(!buttonNamed(on, /^Turn on$/).disabled);
    assert.equal(all(dom.review_new, (x) => x.tag === "input" && x.attrs.type === "checkbox").length, 0, "nothing to skip before a save");
  });

  await check("Review: a refused Save shows the server's sentence and nothing says saved", () => {
    const r = dom.review_save_failed;
    assert.ok(alerts(r).some((a) => a.text === "Only owners and admins can save automations."));
    assert.doesNotMatch(flat(r), /Saved and paused|Saved\./);
    assert.ok(!buttonNamed(r, /^Save$/).disabled, "the person can try again");
  });

  await check("Review: editing a saved automation opens on Review with its values and nothing changed", () => {
    const r = dom.review_edit;
    assert.equal(tags(r, "h3")[0].kids.length > 0, true);
    assert.equal(flat(tags(r, "h3")[0]), "Check it, then turn it on");
    assert.equal(byId(r, "gb-name")!.attrs.value, "Overdue follow-ups");
    assert.match(flat(r), /Saved and paused\./);
    assert.ok(buttonNamed(r, /^Saved$/).disabled, "no change since the save");
    assert.ok(!buttonNamed(r, /^Test now$/).disabled);
    const gone = dom.review_edit_gone;
    assert.equal(flat(tags(gone, "h3")[0]), "What should it do?", "a job that no longer exists reopens on Job");
    assert.match(flat(gone), /The ready-made job this was built from is no longer available/);
  });

  // ── steps nav, summary, focus ──
  await check("the steps are an ordered list with aria-current=step on the current one, and the heading can take focus", () => {
    const expectCurrent: Array<[string, string]> = [["dept", "Area"], ["job_followup", "Job"], ["when_followup", "When"], ["review_new", "Finish"]];
    for (const [id, label] of expectCurrent) {
      const r = dom[id];
      const nav = tags(r, "nav").find((n) => n.attrs["aria-label"] === "Steps")!;
      const ol = tags(nav, "ol")[0];
      assert.equal(tags(ol, "li").length, 4, id);
      const current = tags(ol, "li").filter((li) => li.attrs["aria-current"] === "step");
      assert.equal(current.length, 1, id);
      assert.match(flat(current[0]), new RegExp(`${label}`), id);
      assert.equal(tags(r, "h3")[0].attrs.tabindex, "-1", `${id}: the step heading is focusable`);
    }
  });

  await check("the steps before the current one are buttons the person can go back to; the ones ahead are not", () => {
    const r = dom.review_new;
    const nav = tags(r, "nav").find((n) => n.attrs["aria-label"] === "Steps")!;
    const names = tags(nav, "button").map((b) => accName(r, b));
    assert.deepEqual(names, ["Step 1: Area, done", "Step 2: Job, done", "Step 3: When, done"]);
    const first = dom.dept;
    const navFirst = tags(first, "nav").find((n) => n.attrs["aria-label"] === "Steps")!;
    assert.equal(tags(navFirst, "button").length, 0, "nothing to go back to, and nothing ahead is open");
  });

  await check("the summary rail shows the choices so far: a closed disclosure on a phone, a column on a desktop", () => {
    const r = dom.job_followup;
    const aside = tags(r, "aside").find((a) => a.attrs["aria-label"] === "Your choices so far")!;
    const details = tags(aside, "details")[0];
    assert.ok(hasClass(details, "lg:hidden"), "the phone version is hidden on a desktop");
    assert.ok(!("open" in details.attrs), "closed by default");
    const column = aside.kids.find((k) => k.tag === "div")!;
    assert.ok(hasClass(column, "hidden") && hasClass(column, "lg:block"));
    const rows = (n: HNode) => tags(n, "dt").map(flat);
    assert.deepEqual(rows(details), ["Area", "Job", "Result", "When", "Needs"]);
    assert.match(flat(column), /Area Sales Job Follow-up drafts/);
    assert.match(flat(column), /At most this many drafts per run: 3 drafts/);
    assert.match(flat(column), /Result Email drafts for your approval/);
    assert.match(flat(column), /Needs Google Workspace/);
    assert.match(flat(dom.dept), /Area Not chosen yet Job Not chosen yet/);
    assert.match(flat(tags(details, "summary")[0]), /Your choices so far\s*\d of 5 chosen/);
  });

  // ── the list ──
  await check("the list: each status is a word, with the schedule, the next run and the last run", () => {
    const r = dom.list_items;
    const items = tags(r, "li").filter((li) => tags(li, "h3").length > 0 && li.parent?.tag === "ul" && hasClass(li, "rounded-xl"));
    assert.equal(items.length, 4);
    const text = items.map(flat);
    assert.match(text[0], /Morning brief/);
    assert.match(text[0], /Chief of Staff: Daily brief/);
    assert.equal(pillOf(items[0]), "On");
    assert.match(text[0], /Every weekday \(Monday to Friday\) at 7:30 AM, Toronto time/);
    assert.match(text[0], /Next run: Fri, Oct 16, 7:30 AM EDT \(in 24 hours\)/);
    assert.match(text[0], /Last run: Finished, Wed, Oct 14, 12:00 PM EDT \(20 hours ago\)\. Five things are waiting on you\./);
    assert.equal(pillOf(items[1]), "Paused");
    assert.match(text[1], /Sales: Follow-up drafts/);
    assert.match(text[1], /Not scheduled while it is paused\. Turn it on to start the schedule\./);
    assert.match(text[1], /Last run: Finished.*Two drafts would have been filed\.\s*Preview/);
    assert.equal(pillOf(items[2]), "Needs attention");
    assert.match(text[2], /Support: At-risk tickets and projects/);
    assert.match(text[2], /Last run: Failed/);
    assert.match(text[2], /It could not read the tickets\./);
    assert.match(text[2], /Not scheduled until the problem below is fixed\./);
    assert.equal(pillOf(items[3]), "Paused");
    assert.match(text[3], /Last run: It has not run yet\./);
    assert.equal(flat(tags(r, "h2").find((h) => h.attrs.id === "guided-list-h")!), "Your automations 4");
  });

  await check("the list: problems come with their repair link; actions are Edit, Test now, Turn on or Pause, Delete, each named for its automation", () => {
    const r = dom.list_items;
    const li = tags(r, "li").find((x) => /Late tickets/.test(flat(x)) && tags(x, "h3").length)!;
    assert.match(flat(li), /What needs fixing\s*Help desk needs to be reconnected\./);
    assert.equal(tags(li, "a")[0].attrs.href, "/settings/connections?fix=helpdesk");
    const names = (item: HNode) => tags(item, "button").map((b) => accName(r, b));
    assert.deepEqual(names(li), ["Edit Late tickets", "Test now: Late tickets", "Turn on: Late tickets", "Pause: Late tickets", "Delete: Late tickets"]);
    const on = tags(r, "li").find((x) => /Morning brief/.test(flat(x)) && tags(x, "h3").length)!;
    assert.deepEqual(names(on), ["Edit Morning brief", "Test now: Morning brief", "Pause: Morning brief", "Delete: Morning brief"], "an automation that is on offers Pause, not Turn on");
    const paused = tags(r, "li").find((x) => /Quiet leads/.test(flat(x)) && tags(x, "h3").length)!;
    assert.deepEqual(names(paused), ["Edit Quiet leads", "Test now: Quiet leads", "Turn on: Quiet leads", "Delete: Quiet leads"]);
  });

  await check("the list: with no clock yet it shows the time alone, never a made-up 'in 3 hours'", () => {
    const r = dom.list_no_clock;
    const first = flat(tags(r, "li").filter((li) => tags(li, "h3").length)[0]);
    assert.match(first, /Next run: Fri, Oct 16, 7:30 AM EDT(?! \()/);
    assert.doesNotMatch(first, /ago|\(in /);
  });

  await check("the list: Delete asks first, inline, in the page", () => {
    const r = dom.list_confirm;
    const group = all(r, (x) => x.attrs.role === "group")[0];
    assert.equal(group.attrs["aria-label"], "Delete Overdue follow-ups?");
    assert.match(flat(group), /Delete this automation\?/);
    assert.deepEqual(tags(group, "button").map(flat), ["Yes, delete", "No, keep it"]);
    const plain = tags(dom.list_items, "button").filter((b) => /^Delete/.test(accName(dom.list_items, b)));
    assert.equal(plain.length, 4, "every row starts with a plain Delete, not a confirmation");
  });

  await check("the list: a test result and a refusal on a row read the same as on Review", () => {
    assert.match(flat(dom.list_row_test), /It would have drafted 2 emails:/);
    assert.equal(all(dom.list_row_test, (x) => x.tag === "li" && hasClass(x, "border-dashed") && /Preview only\. Nothing was sent or filed\./.test(flat(x))).length, 2);
    assert.ok(alerts(dom.list_row_failure).some((a) => a.text === "Google Workspace is not connected."));
    assert.equal(tags(dom.list_row_failure, "a").filter((l) => l.attrs.href === REPAIR_GOOGLE.href).length, 1);
    assert.match(flat(dom.list_row_text), /Paused\. It will not run until you turn it on\./);
  });

  await check("the list: nothing saved yet teaches in one sentence and points at the builder", () => {
    const r = dom.list_empty;
    const sentence = "Automations you save show up here with their next run and last result, so build your first one above.";
    assert.ok(flat(r).includes(sentence));
    assert.equal(tags(r, "li").filter((li) => tags(li, "h3").length && hasClass(li, "rounded-xl")).length, 0);
    assert.equal(flat(tags(r, "h2").find((h) => h.attrs.id === "guided-list-h")!), "Your automations", "no count when there is nothing");
  });

  await check("automations made before the builder are listed INSIDE Your automations, after its rows, and never hidden by a 'nothing yet'", () => {
    // CC, 2026-10-16: "my automations aren't being displayed - the ones I previously built aren't showing up".
    const empty = dom.list_empty_with_others;
    const section = all(empty, (x) => x.tag === "section" && x.attrs["aria-labelledby"] === "guided-list-h")[0];
    assert.ok(section, "one Your automations section");
    assert.ok(flat(section).includes("Daily Automation Register"), "the older automations are inside it");
    assert.ok(!flat(empty).includes("build your first one above"), "no 'nothing yet' above real automations");
    assert.equal(flat(tags(empty, "h2").find((h) => h.attrs.id === "guided-list-h")!), "Your automations", "no count that leaves the older ones out");
    const withRows = dom.list_items_with_others;
    const rowsSection = all(withRows, (x) => x.tag === "section" && x.attrs["aria-labelledby"] === "guided-list-h")[0];
    const text = flat(rowsSection);
    assert.ok(text.indexOf("Daily Automation Register") > text.indexOf(flat(tags(rowsSection, "li")[0])), "the builder's rows first, then the older ones");
    assert.equal(flat(tags(withRows, "h2").find((h) => h.attrs.id === "guided-list-h")!), "Your automations");
    assert.ok(!markup.list_empty.includes("automations-made-before"), "no empty wrapper when there is nothing older");
  });

  await check("loading and could-not-load states are real: words, a way to try again, never an empty box", () => {
    const loading = dom.loading;
    assert.ok(flat(loading).includes("Loading the builder..."));
    assert.ok(flat(loading).includes("Loading your automations..."));
    assert.equal(all(loading, (x) => x.tag === "section" && x.attrs["aria-busy"] === "true").length, 1);
    const list = dom.list_error_only;
    assert.match(flat(list), /Your automations could not be loaded\./);
    assert.ok(alerts(list).some((a) => a.text === "We could not reach the server. Check your connection and try again."));
    assert.ok(buttonsOf(list).some((b) => b.name === "Try again"));
    const ctx = dom.ctx_error;
    assert.match(flat(ctx), /The builder could not be opened\./);
    assert.ok(alerts(ctx).some((a) => /do not have access to automations/.test(a.text)));
    assert.equal(tags(ctx, "a")[0].attrs.href, "/settings");
    assert.ok(buttonsOf(ctx).some((b) => b.name === "Try again"));
    assert.match(flat(ctx), /Loading|Your automations/, "the list still renders when the builder could not open");
  });

  // ── the page ──
  await check("integration: with the builder off, the page is exactly what it was (no fold, no builder, the old header)", () => {
    const off = markup.page_off;
    assert.ok(!off.includes("Other scheduled jobs"));
    assert.ok(!off.includes("guided-builder-h") && !off.includes("Pick a job, say when it should run"));
    assert.ok(!off.includes("guided-list-h") && !off.includes("Your automations"));
    assert.ok(off.includes("Scheduled jobs your agents run for you"));
    assert.ok(off.includes("Draft with AI"), "the composer is on the page");
    assert.ok(off.includes("How automations work, in plain English"));
  });

  await check("integration: with the builder on, it is the ONE way to make an automation, and every automation already made is in plain sight", () => {
    const on = dom.page_on;
    const top = on.kids[0];
    const children = top.kids;
    const idxGuided = children.findIndex((k) => k.tag === "div" && tags(k, "section").some((s) => s.attrs["aria-labelledby"] === "guided-list-h"));
    assert.ok(idxGuided > 0, "the builder and Your automations near the top");
    // Nothing the person built is closed away: the only disclosure left is the plain-English explainer.
    assert.ok(!markup.page_on.includes("Other scheduled jobs"), "no 'Other scheduled jobs' box");
    const disclosures = all(on, (x) => x.tag === "details");
    assert.equal(disclosures.length, 1, "one disclosure");
    assert.match(flat(tags(disclosures[0], "summary")[0]), /How automations work, in plain English/);
    // The scheduled-jobs list (CronJobsManager: its count line reads "Loading..." before it fetches) is
    // INSIDE the Your automations section, not after it and not inside any disclosure.
    const yours = all(on, (x) => x.tag === "section" && x.attrs["aria-labelledby"] === "guided-list-h")[0];
    const before = all(yours, (x) => x.attrs["data-testid"] === "automations-made-before");
    assert.equal(before.length, 1, "the older automations are listed inside Your automations");
    assert.match(flat(before[0]), /Loading/, "and it is the scheduled-jobs list");
    assert.ok(!all(disclosures[0], (x) => x.attrs["data-testid"] === "automations-made-before").length);
    // The connection status, the modules board and the explainer keep their places on the page.
    // The render stubs no paired computer, so the banner's own headline for that case must be on the page,
    // before the builder (it says whether scheduled jobs can run at all).
    const bannerAt = markup.page_on.indexOf("Computer not connected yet.");
    assert.ok(bannerAt > 0 && bannerAt < markup.page_on.indexOf("guided-list-h"), "the connection status is on the page, above the list");
    for (const html of [markup.page_on, markup.page_on_not_allowed]) {
      assert.ok(!html.includes("Draft with AI"), "the AI box is gone");
      assert.ok(!html.includes("Describe what you want"), "and its heading");
      assert.ok(!html.includes("New automations are coming to this page."), "no placeholder for a path that is not offered");
      assert.ok(!html.includes("Run a Python script"), "no script form");
    }
    assert.ok(markup.page_on.includes("Use New automation at the top of this page."));
    assert.ok(markup.page_on.includes("Pick a job, say when it should run and try it once before you turn it on."));
    assert.ok(!markup.page_on.includes("lead scoring"), "the header no longer promises what no tenant job does");
  });

  await check("integration: with the builder on, an empty workspace's list points at New automation; with it off, the old words alone (CC 2026-10-16)", async () => {
    // The builder's own "build your first one above" never shows on the page (the older list is always
    // passed under it), so the scheduled-jobs list's empty line is the one a brand-new workspace reads.
    // That line is drawn only after a fetch, so here: the prop the real page passes, and the words it makes.
    const { emptyListLine } = await import("../components/automations/CronJobsManager");
    const hint = olderListProps.page_on?.emptyHint;
    assert.equal(hint, "Build your first one with New automation above.", "the page passes the builder's hint");
    assert.equal(olderListProps.page_on_not_allowed?.emptyHint, hint, "for every viewer the builder is on for");
    assert.equal(emptyListLine(hint as string), "You have no automations yet. Build your first one with New automation above.");
    assert.ok(olderListProps.page_off && !("emptyHint" in olderListProps.page_off), "with the builder off the page passes no hint");
    assert.equal(emptyListLine(undefined), "You have no automations yet.", "and the empty line keeps O2's exact words");
    assert.equal(emptyListLine(null), "", "told to stay quiet, it says nothing");
  });

  await check("integration: signed out, the builder is not offered and the page is the old one", () => {
    const html = markup.page_on_signed_out;
    assert.ok(!html.includes("guided-builder-h") && !html.includes("Pick a job, say when it should run"));
    assert.ok(!html.includes("Other scheduled jobs"));
    assert.ok(html.includes("Sign in to manage your automations."));
  });

  // ── hygiene across every rendered state ──
  await check("no jargon, model name, dash or arrow in anything a person reads (text, labels, placeholders), in any state", () => {
    for (const id of [...sectionIds, "page_on", "page_on_not_allowed"]) {
      const html = guided(id);
      assertPlainCopy(textOnly(html), id);
      assertPlainCopy(attrText(html), `${id} (labels)`);
    }
  });

  await check("every control has an accessible name", () => {
    for (const id of sectionIds) {
      const r = dom[id];
      for (const el of CONTROLS(r)) {
        assert.ok(accName(r, el).length > 0, `${id}: <${el.tag} ${JSON.stringify(el.attrs).slice(0, 120)}> has no name`);
      }
    }
  });

  await check("every control is a 44 px target (min-h-11) and a native radio or box sits in a labelled target of that size", () => {
    for (const id of sectionIds) {
      const r = dom[id];
      for (const el of all(r, (x) => ["button", "select", "summary"].includes(x.tag) || (x.tag === "a" && "href" in x.attrs) || (x.tag === "input" && ["text", "number", "time"].includes(x.attrs.type)))) {
        assert.ok(hasClass(el, "min-h-11"), `${id}: <${el.tag}> ${flat(el).slice(0, 60)} (${el.attrs.class})`);
      }
      for (const el of all(r, (x) => x.tag === "input" && (x.attrs.type === "radio" || x.attrs.type === "checkbox"))) {
        const label = closest(el, "label");
        assert.ok(label, `${id}: ${el.attrs.name} has no label`);
        assert.ok(hasClass(label!, "min-h-11") || all(label!, (x) => hasClass(x, "min-h-11")).length > 0, `${id}: ${el.attrs.name}=${el.attrs.value} is not a 44 px target`);
      }
    }
  });

  await check("errors are announced and tied: every alert that sits at a field is described-by from its control", () => {
    for (const id of sectionIds) {
      const r = dom[id];
      for (const err of all(r, (x) => x.attrs.role === "alert" && /-error$/.test(x.attrs.id ?? ""))) {
        const owner = all(r, (x) => (x.attrs["aria-describedby"] ?? "").split(/\s+/).includes(err.attrs.id));
        assert.ok(owner.length >= 1, `${id}: ${err.attrs.id} is not tied to a control`);
      }
    }
  });

  await check("reduced motion: no animation, and every transition is motion-safe", () => {
    for (const id of [...sectionIds, "page_on"]) {
      const html = guided(id);
      assert.ok(!/animate-(?!fade-in)/.test(html), `${id}: animation`);
      for (const m of html.matchAll(/class="([^"]*)"/g)) {
        for (const token of m[1].split(/\s+/)) {
          if (/(^|:)transition/.test(token)) assert.ok(token.startsWith("motion-safe:"), `${id}: ${token}`);
        }
      }
    }
  });

  await check("a narrow screen: nothing fixed wider than the screen, the rail stacks, long text wraps", () => {
    for (const id of sectionIds) {
      const html = markup[id];
      assert.ok(!/\b(?:min-)?w-\[(\d{3,})px\]/.test(html), `${id}: a fixed pixel width`);
      assert.ok(!/\bwhitespace-nowrap\b/.test(html), `${id}: text that cannot wrap`);
    }
    const r = dom.job_followup;
    const grid = all(r, (x) => hasClass(x, "lg:grid-cols-[minmax(0,1fr)_17rem]"))[0];
    assert.ok(grid, "two columns only from the lg breakpoint");
    assert.ok(hasClass(grid.kids[0], "order-2") && hasClass(grid.kids[1], "order-1"), "on a phone the choices-so-far comes first");
    assert.ok(all(dom.review_tested, (x) => hasClass(x, "break-words")).length > 0, "email text wraps");
  });

  await check("one clear primary action per step (and none competing on the list)", () => {
    for (const id of ["dept_picked", "job_followup", "when_followup", "review_new", "review_saved", "review_tested"]) {
      const primaries = tags(dom[id], "button").filter((b) => hasClass(b, "btn-primary")).filter((b) => !("disabled" in b.attrs));
      assert.equal(primaries.length, 1, `${id}: ${primaries.map(flat).join(" | ")}`);
    }
    const none = tags(dom.dept, "button").filter((b) => hasClass(b, "btn-primary") && !("disabled" in b.attrs));
    assert.equal(none.length, 0, "nothing to press until a department is chosen");
    assert.equal(tags(dom.list_items, "button").filter((b) => hasClass(b, "btn-primary") && !("disabled" in b.attrs)).length, 0, "the list adds no primary action of its own");
  });

  // ═══ driven: a founder builds an automation ═══

  const GuidedBuilder = (await import("../components/automations/guided/GuidedBuilder")).GuidedBuilder;
  const GuidedAutomationsList = (await import("../components/automations/guided/GuidedAutomationsList")).GuidedAutomationsList;

  type Harness = {
    f: () => Frame;
    calls: ReturnType<typeof fakeApi>["calls"];
    items: GuidedAutomationView[];
    tested: number;
    resets: number;
    setCtx: (c: GuidedContextView) => void;
  };
  function build(overrides: Parameters<typeof fakeApi>[0] = {}, startCtx: GuidedContextView = CTX_NO_GOOGLE, initial?: Parameters<typeof GuidedBuilder>[0]["initial"]): Harness {
    const { api, calls } = fakeApi(overrides);
    let ctx = startCtx;
    const h: Harness = { f: () => frame(() => null), calls, items: [], tested: 0, resets: 0, setCtx: (c) => (ctx = c) };
    const view = mount(GuidedBuilder, () => ({
      api,
      context: ctx,
      onRecheck: () => undefined,
      rechecking: false,
      onItem: (item: GuidedAutomationView) => h.items.push(item),
      onTested: () => (h.tested += 1),
      onReset: () => (h.resets += 1),
      nowMs: NOW,
      initial,
    }));
    h.f = () => frame(view);
    return h;
  }

  await check("driven: the wizard walks Area, Job, When, Finish and every Next is earned", async () => {
    const h = build();
    let f = h.f();
    assert.match(f.words, /What part of your business is this for\?/);
    assert.equal(isDisabled(f.button(/^Next: Job$/)), true);
    assert.match(f.words, /Pick an area of your business to continue\./);
    pick(f.radio("department", "sales"));
    f = h.f();
    assert.match(f.words, /Area Sales/, "the summary follows the choice");
    await press(f.button(/^Next: Job$/));

    f = h.f();
    assert.match(f.words, /What should it do\?/);
    assert.match(f.words, /Example of what you get \(made-up names and numbers\)/);
    assert.equal(isDisabled(f.button(/^Next: When$/)), true, "no job yet");
    assert.match(f.words, /Pick a job to continue\./);
    pick(f.radio("job", "followup_drafts"));
    f = h.f();
    assert.match(f.words, /Job Follow-up drafts/);
    assert.equal(isDisabled(f.button(/^Next: When$/)), false);
    assert.doesNotMatch(f.words, /How often should it run\?/, "the schedule is its own step");
    await press(f.button(/^Next: When$/));

    f = h.f();
    assert.match(f.words, /When should it run\?/);
    assert.match(f.words, /How often should it run\?/);
    assert.match(f.words, /What time of day\?/);
    assert.match(f.words, /Next runs:/);
    await press(f.button(/^Next: Finish$/));
    f = h.f();
    assert.match(f.words, /What will happen/);
    assert.match(f.words, /Before it can run/);
    assert.match(f.words, /Google Workspace/);
    assert.match(f.words, /Not connected/);
    assert.equal(h.calls.length, 0, "walking the steps calls nothing");
  });

  await check("driven: a typed setting, a changed time, a different How often and a day pick change the summary and the Review sentence", async () => {
    const h = build();
    let f = h.f();
    pick(f.radio("department", "chief_of_staff"));
    await press(h.f().button(/^Next: Job$/));
    pick(h.f().radio("job", "daily_brief"));
    f = h.f();
    pick(f.radio("gb-in-length", "full"));
    pick(h.f().radio("gb-in-calendar", "no"));
    f = h.f();
    assert.match(f.words, /How long: Full \(up to 12 lines\)/);
    assert.match(f.words, /Include today's calendar: No/);
    await press(f.button(/^Next: When$/));
    f = h.f();
    typeInto(f.input("gb-when-time"), "06:15");
    f = h.f();
    assert.match(f.words, /Every weekday \(Monday to Friday\) at 6:15 AM/, "the summary says the new time");
    assert.match(f.words, /Next runs: Fri, Oct 16, 6:15 AM EDT/);
    pick(f.radio("gb-when", "monday_0800"));
    f = h.f();
    assert.equal(f.input("gb-when-time").props.value, "06:15", "the time chosen carries over to the new answer");
    const dayBoxes = f.els.filter((e) => e.type === "input" && e.props.name === "gb-when-days");
    assert.equal(dayBoxes.length, 7);
    pick(dayBoxes.find((e) => e.props.value === "4")!);
    f = h.f();
    assert.match(f.words, /Every Monday and Thursday at 6:15 AM/);
    await press(f.button(/^Next: Finish$/));
    f = h.f();
    assert.match(f.words, /Every Monday and Thursday at 6:15 AM, Toronto time/);
    assert.match(f.words, /a full brief \(up to 12 lines\) from your department numbers, the approvals waiting and the pipeline/);
    assert.match(f.words, /Everything it needs is ready\./, "a brief needs no app, and the AI account is ready");
  });

  await check("driven: Several times a day asks How many times a day?, and the answer changes the runs", async () => {
    const h = build({}, CTX);
    pick(h.f().radio("department", "operations"));
    await press(h.f().button(/^Next: Job$/));
    pick(h.f().radio("job", "ops_check"));
    await press(h.f().button(/^Next: When$/));
    let f = h.f();
    pick(f.radio("gb-when", "every_6h"));
    f = h.f();
    assert.match(f.words, /What time is the first one\?/);
    assert.match(f.words, /How many times a day\?/);
    typeInto(f.input("gb-when-time"), "08:00");
    f = h.f();
    const twice = f.els.find((e) => e.type === "input" && e.props.name === "gb-when-count" && e.props.value === "8")!;
    pick(twice);
    f = h.f();
    assert.match(f.words, /2 times a day at 8:00 AM and 4:00 PM, Toronto time/, "the summary says it the way the question asked it");
    assert.match(f.words, /Next runs: Thu, Oct 15, 4:00 PM EDT Fri, Oct 16, 8:00 AM EDT Fri, Oct 16, 4:00 PM EDT/);
    await press(f.button(/^Next: Finish$/));
    await press(h.f().button(/^Save$/));
    const sent = h.calls[0].args[0] as { payload: { schedule: { plan: unknown } } };
    assert.deepEqual(sent.payload.schedule.plan, { mode: "every_n_hours", time: "08:00", every_hours: 8, timezone: "America/Toronto" });
  });

  await check("driven: the custom brief cannot move on without an objective and a ticked read; the stepper stays in range", async () => {
    const h = build();
    pick(h.f().radio("department", "sales"));
    await press(h.f().button(/^Next: Job$/));
    pick(h.f().radio("job", "custom"));
    let f = h.f();
    assert.equal(isDisabled(f.button(/^Next: When$/)), true);
    typeInto(f.input("gb-in-objective"), "ab");
    f = h.f();
    assert.equal(isDisabled(f.button(/^Next: When$/)), true, "two characters is not an objective");
    assert.match(f.words, /Tell us a little more in "What should it look into\?" \(at least 5 characters\)\./, "the sentence appears once the field has been touched");
    typeInto(f.input("gb-in-objective"), "Which leads have gone quiet?");
    f = h.f();
    assert.equal(isDisabled(f.button(/^Next: When$/)), true, "still no read ticked");
    assert.match(f.words, /Tick at least one thing it may read\./);
    tick(f.els.find((e) => e.type === "input" && e.props.id === "gb-tool-pipeline_summary")!, true);
    f = h.f();
    assert.equal(isDisabled(f.button(/^Next: When$/)), false);
    assert.match(f.words, /May read: pipeline/);

    // The stepper never leaves the template's range.
    const h2 = build();
    pick(h2.f().radio("department", "sales"));
    await press(h2.f().button(/^Next: Job$/));
    pick(h2.f().radio("job", "stalled_digest"));
    const up = () => h2.f().button(/^Increase/);
    for (let i = 0; i < 40; i += 1) if (!isDisabled(up())) await press(up());
    assert.match(h2.f().words, /Count a lead as stalled after: 30 days with no activity/);
    assert.equal(isDisabled(up()), true);
    typeInto(h2.f().input("gb-in-days_quiet"), "99");
    assert.match(h2.f().words, /"Count a lead as stalled after" must be a whole number from 3 to 30\./);
    assert.equal(isDisabled(h2.f().button(/^Next: When$/)), true);
  });

  await check("driven: Save creates paused, Test now runs the saved one, Turn on waits for the app and then works, and each line is the server's", async () => {
    const h = build({ test: () => ({ ok: true, result: RESULT_DRAFTS }) });
    pick(h.f().radio("department", "sales"));
    await press(h.f().button(/^Next: Job$/));
    pick(h.f().radio("job", "followup_drafts"));
    await press(h.f().button(/^Next: When$/));
    await press(h.f().button(/^Next: Finish$/));

    let f = h.f();
    assert.equal(isDisabled(f.button(/^Test now$/)), true);
    assert.equal(isDisabled(f.button(/^Turn on$/)), true);
    typeInto(f.input("gb-name"), "  Overdue follow-ups  ");
    await press(h.f().button(/^Save$/));
    assert.deepEqual(h.calls.map((c) => c.method), ["create"]);
    const sent = h.calls[0].args[0] as { name: string; payload: { template: { id: string }; output: string; target: { kind: string }; approval: string } };
    assert.equal(sent.name, "Overdue follow-ups");
    assert.equal(sent.payload.template.id, "followup_drafts");
    assert.equal(sent.payload.output, "email_drafts");
    assert.deepEqual(sent.payload.target, { kind: "cloud" });
    assert.equal(sent.payload.approval, "proposal_only");
    assert.equal(h.items.length, 1, "the list is told");
    f = h.f();
    assert.match(f.words, /Saved and paused\. Nothing will run until you turn it on\./);
    assert.equal(isDisabled(f.button(/^Saved$/)), true);

    // Test now: the saved one, once.
    await press(f.button(/^Test now$/));
    assert.deepEqual(h.calls.map((c) => [c.method, c.args[0]]), [["create", sent], ["test", "new-1"]]);
    assert.equal(h.tested, 1, "the list is told to refresh the last run");
    f = h.f();
    assert.match(f.words, /It would have drafted 2 emails:/);
    assert.match(f.words, /Preview only\. Nothing was sent or filed\./);

    // Google Workspace is not connected: Turn on stays off, and says why, and the fix is a link.
    assert.equal(isDisabled(f.button(/^Turn on$/)), true);
    assert.match(f.words, /Connect Google Workspace first\. You can keep it saved until then\./);
    assert.ok(f.els.some((e) => e.type === "a" && e.props.href === REPAIR_GOOGLE.href));
    assert.equal(h.calls.filter((c) => c.method === "activate").length, 0);

    // The person connects it (in another tab) and checks again.
    h.setCtx(CTX);
    f = h.f();
    assert.equal(isDisabled(f.button(/^Turn on$/)), false);
    await press(f.button(/^Turn on$/));
    assert.deepEqual(h.calls.map((c) => c.method), ["create", "test", "activate"]);
    assert.equal(h.calls[2].args[0], "new-1");
    f = h.f();
    assert.match(f.words, /It is on\./);
    assert.equal(f.buttons(/^Turn on$/).length, 0);
    assert.equal(h.items.length, 2);
    assert.equal(h.items[1].status, "on");
  });

  await check("driven: an edit after saving takes Test and Turn on away and Save calls update, not create", async () => {
    const h = build({}, CTX);
    pick(h.f().radio("department", "sales"));
    await press(h.f().button(/^Next: Job$/));
    pick(h.f().radio("job", "stalled_digest"));
    for (const next of [/^Next: When$/, /^Next: Finish$/]) await press(h.f().button(next));
    await press(h.f().button(/^Save$/));
    await press(h.f().button(/^Test now$/));
    assert.equal(isDisabled(h.f().button(/^Turn on$/)), false, "tested, so ready");

    await press(h.f().button(/^Back$/));
    await press(h.f().button(/^Back$/));
    assert.match(h.f().words, /What should it do\?/);
    typeInto(h.f().input("gb-in-days_quiet"), "12");
    for (const next of [/^Next: When$/, /^Next: Finish$/]) await press(h.f().button(next));
    const f = h.f();
    assert.match(f.words, /You have changes that are not saved yet\./);
    assert.equal(isDisabled(f.button(/^Test now$/)), true);
    assert.equal(isDisabled(f.button(/^Turn on$/)), true);
    assert.doesNotMatch(f.words, /The test finished/);
    await press(f.button(/^Save changes$/));
    assert.deepEqual(h.calls.map((c) => c.method), ["create", "test", "update"]);
    assert.equal(h.calls[2].args[0], "new-1");
    assert.equal((h.calls[2].args[1] as { payload: { inputs: { days_quiet: number } } }).payload.inputs.days_quiet, 12);
    const after = h.f();
    assert.equal(isDisabled(after.button(/^Test now$/)), false);
    assert.equal(isDisabled(after.button(/^Turn on$/)), true, "the new version has not been tested");
    assert.match(after.words, /Test it first, or confirm below that you want to skip the test\./);
  });

  await check("driven: skipping the test is an explicit confirmation, and it applies to one version only", async () => {
    const h = build({}, CTX);
    pick(h.f().radio("department", "chief_of_staff"));
    await press(h.f().button(/^Next: Job$/));
    pick(h.f().radio("job", "daily_brief"));
    for (const next of [/^Next: When$/, /^Next: Finish$/]) await press(h.f().button(next));
    await press(h.f().button(/^Save$/));
    let f = h.f();
    assert.equal(isDisabled(f.button(/^Turn on$/)), true);
    const box = f.els.find((e) => e.type === "input" && e.props.type === "checkbox")!;
    tick(box, true);
    f = h.f();
    assert.equal(isDisabled(f.button(/^Turn on$/)), false);
    typeInto(f.input("gb-name"), "A new name");
    f = h.f();
    assert.equal(isDisabled(f.button(/^Turn on$/)), true, "a change cancels the confirmation");
    await press(f.button(/^Save changes$/));
    assert.equal(h.f().els.some((e) => e.type === "input" && e.props.type === "checkbox" && e.props.checked === true), false, "and it is asked again");
  });

  await check("driven: a refused Save, Test and Turn on show the server's sentence, never success", async () => {
    const repair = REPAIR_GOOGLE;
    const problems = [{ code: "connection_missing", message: "Google Workspace is not connected.", repair }];
    const h = build({
      create: () => failure({ error: "forbidden", message: "Only owners and admins can save automations." }),
    }, CTX);
    pick(h.f().radio("department", "chief_of_staff"));
    await press(h.f().button(/^Next: Job$/));
    pick(h.f().radio("job", "daily_brief"));
    for (const next of [/^Next: When$/, /^Next: Finish$/]) await press(h.f().button(next));
    await press(h.f().button(/^Save$/));
    let f = h.f();
    assert.match(f.words, /Only owners and admins can save automations\./);
    assert.doesNotMatch(f.words, /Saved/);
    assert.equal(h.items.length, 0, "the list is not told of a save that did not happen");
    assert.equal(isDisabled(f.button(/^Save$/)), false, "the person can try again");

    // A save that works, then a refused test and a refused Turn on.
    const h2 = build({
      test: () => failure({ error: "rate_limited", message: "" }),
      activate: () => failure({ error: "connection_missing", message: "Google Workspace is not connected, so this cannot be turned on.", repair, problems }),
    }, CTX);
    pick(h2.f().radio("department", "chief_of_staff"));
    await press(h2.f().button(/^Next: Job$/));
    pick(h2.f().radio("job", "daily_brief"));
    for (const next of [/^Next: When$/, /^Next: Finish$/]) await press(h2.f().button(next));
    await press(h2.f().button(/^Save$/));
    await press(h2.f().button(/^Test now$/));
    f = h2.f();
    assert.match(f.words, /That was too quick\. Wait a moment and try again\./, "a bare code becomes a sentence");
    assert.equal(isDisabled(f.button(/^Turn on$/)), true, "a refused test does not unlock Turn on");
    const box = f.els.find((e) => e.type === "input" && e.props.type === "checkbox")!;
    tick(box, true);
    await press(h2.f().button(/^Turn on$/));
    f = h2.f();
    assert.match(f.words, /Google Workspace is not connected, so this cannot be turned on\./);
    assert.match(f.words, /Google Workspace is not connected\./, "each problem is listed");
    assert.ok(f.els.filter((e) => e.type === "a" && e.props.href === repair.href).length >= 2);
    assert.doesNotMatch(f.words, /It is on\./);
    assert.equal(h2.items.length, 1, "only the save reached the list");
  });

  await check("driven: while a call is in flight nothing else can be pressed, and a double press is one call", async () => {
    let release: (v: unknown) => void = () => undefined;
    const slow = new Promise((resolve) => (release = resolve));
    const h = build({ create: () => slow }, CTX);
    pick(h.f().radio("department", "chief_of_staff"));
    await press(h.f().button(/^Next: Job$/));
    pick(h.f().radio("job", "daily_brief"));
    for (const next of [/^Next: When$/, /^Next: Finish$/]) await press(h.f().button(next));
    const save = h.f().button(/^Save$/);
    const onClick = save.props.onClick as () => unknown;
    onClick();
    await settle();
    const f = h.f();
    assert.equal(isDisabled(f.button(/^Saving\.\.\.$/)), true, "the button shows it is working and cannot be pressed");
    assert.equal(isDisabled(f.button(/^Test now$/)), true);
    onClick(); // a second press on the same, now stale, handler (a double click before the redraw)
    await settle();
    assert.equal(h.calls.filter((c) => c.method === "create").length, 1, "the second press did nothing");
    release({ ok: true, item: itemFrom(draftOf("daily_brief", "chief_of_staff"), "paused", { id: "slow-1" }) });
    await settle();
    assert.match(h.f().words, /Saved and paused/);
  });

  await check("driven: opening a saved automation to edit starts on Review with the values, Save is off until something changes, and Pause stops it", async () => {
    const item = itemFrom(draftOf("stalled_digest", "sales", (d) => setName(d, "Quiet leads")), "on", { id: "s9" });
    const session = editSession(item, CTX);
    const h = build({}, CTX, session);
    let f = h.f();
    assert.match(f.words, /What will happen/);
    assert.equal(f.input("gb-name").props.value, "Quiet leads");
    assert.equal(isDisabled(f.button(/^Saved$/)), true);
    assert.match(f.words, /It is on\./);
    await press(f.button(/^Pause it$/));
    assert.deepEqual(h.calls.map((c) => [c.method, c.args[0]]), [["pause", "s9"]]);
    f = h.f();
    assert.equal(f.buttons(/^Pause it$/).length, 0, "the server said paused");
    assert.equal(h.items[0].status, "paused");
    typeInto(f.input("gb-name"), "Quiet leads, weekly");
    await press(h.f().button(/^Save changes$/));
    assert.deepEqual(h.calls.map((c) => c.method), ["pause", "update"]);
    assert.equal(h.calls[1].args[0], "s9");
  });

  await check("driven: the list's Test now, Turn on, Pause and Delete call the API for that row only; Delete asks first", async () => {
    const { api, calls } = fakeApi({ test: () => ({ ok: true, result: RESULT_DRAFTS }) });
    const changed: GuidedAutomationView[] = [];
    const removed: string[] = [];
    let tested = 0;
    const view = mount(GuidedAutomationsList, () => ({
      state: { kind: "ready" as const, data: LIST_ITEMS },
      api,
      nowMs: NOW,
      onEdit: () => undefined,
      onItem: (i: GuidedAutomationView) => changed.push(i),
      onRemoved: (id: string) => removed.push(id),
      onTested: () => (tested += 1),
      onRetry: () => undefined,
    }));
    let f = frame(view);
    await press(f.button(/^Test now: Overdue follow-ups$/));
    assert.deepEqual(calls.map((c) => [c.method, c.args[0]]), [["test", "i2"]]);
    assert.equal(tested, 1);
    f = frame(view);
    assert.match(f.words, /It would have drafted 2 emails:/);

    await press(f.button(/^Turn on: Overdue follow-ups$/));
    assert.deepEqual(calls.at(-1)?.method, "activate");
    assert.equal(calls.at(-1)?.args[0], "i2");
    assert.equal(changed.at(-1)?.status, "on");
    await press(frame(view).button(/^Pause: Morning brief$/));
    assert.equal(calls.at(-1)?.method, "pause");
    assert.equal(calls.at(-1)?.args[0], "i1");

    // Delete is a two-step: the first press only asks.
    const before = calls.length;
    f = frame(view);
    await press(f.button(/^Delete: Quiet leads$/));
    assert.equal(calls.length, before, "asking is not deleting");
    f = frame(view);
    assert.match(f.words, /Delete this automation\?/);
    await press(f.button(/^No, keep it$/));
    assert.equal(calls.length, before);
    assert.equal(frame(view).buttons(/^Yes, delete$/).length, 0, "No puts it back");
    await press(frame(view).button(/^Delete: Quiet leads$/));
    await press(frame(view).button(/^Yes, delete$/));
    assert.equal(calls.at(-1)?.method, "remove");
    assert.equal(calls.at(-1)?.args[0], "i4");
    assert.deepEqual(removed, ["i4"]);
  });

  await check("driven: the older list says 'none yet' and points at the builder only when the builder's list loaded empty (CC 2026-10-16)", async () => {
    const { CronJobsManager } = await import("../components/automations/CronJobsManager");
    const HINT = "Build your first one with New automation above.";
    const { api } = fakeApi();
    const listWith = (state: Parameters<typeof GuidedAutomationsList>[0]["state"]) =>
      GuidedAutomationsList({
        state,
        api,
        nowMs: NOW,
        onEdit: () => undefined,
        onItem: () => undefined,
        onRemoved: () => undefined,
        onTested: () => undefined,
        onRetry: () => undefined,
        others: ReactNS.createElement(CronJobsManager, { agentKeys: [], emptyHint: HINT }),
      });
    /** The CronJobsManager element the list renders, as it hands it on (not drawn). */
    const handed = (node: unknown): El | null => {
      if (Array.isArray(node)) return node.map(handed).find(Boolean) ?? null;
      if (!isValidElement(node)) return null;
      const el = node as unknown as El;
      return el.type === CronJobsManager ? el : handed(el.props.children);
    };
    /** The words a person reads once the older list has loaded with no jobs: its first state slot is `jobs`. */
    const loadedEmpty = (tree: unknown) => {
      slots = [[]];
      cursor = 0;
      return squash(text(tree));
    };

    const empty = listWith(ready([]));
    assert.equal(handed(empty)?.props.emptyHint, HINT, "a brand-new workspace: the hint reaches the older list");
    assert.match(loadedEmpty(empty), /You have no automations yet\. Build your first one with New automation above\./);

    for (const [why, state] of [
      ["the builder's rows are on screen", ready(LIST_ITEMS)],
      ["the builder's list is still loading", { kind: "loading" as const }],
      ["the builder's list could not load", { kind: "error" as const, message: "We could not reach the server.", repair: null }],
    ] as const) {
      const tree = listWith(state as Parameters<typeof GuidedAutomationsList>[0]["state"]);
      assert.equal(handed(tree)?.props.emptyHint, null, `${why}: the older list is told to stay quiet when empty`);
      if (state.kind !== "ready") assert.doesNotMatch(loadedEmpty(tree), /no automations yet|Build your first one/, `${why}: no "none yet"`);
    }

    // Drawn alone (the builder off): the exact old words.
    slots = [[]];
    cursor = 0;
    const alone = squash(text(CronJobsManager({ agentKeys: [] })));
    assert.match(alone, /You have no automations yet\./);
    assert.doesNotMatch(alone, /Build your first one/);
  });

  await check("driven: a teammate's automation offers only Pause, and says why", async () => {
    const { api, calls } = fakeApi();
    const teammate = { ...LIST_ITEMS[0], mine: false };
    const view = mount(GuidedAutomationsList, () => ({
      state: { kind: "ready" as const, data: [teammate] },
      api,
      nowMs: NOW,
      onEdit: () => undefined,
      onItem: () => undefined,
      onRemoved: () => undefined,
      onTested: () => undefined,
      onRetry: () => undefined,
    }));
    const f = frame(view);
    assert.match(f.words, /A teammate made this one\. Only they can change, test, turn on or delete it\. You can pause it\./);
    for (const re of [/^Edit /, /^Test now: /, /^Turn on: /, /^Delete: /]) assert.equal(f.buttons(re).length, 0, `${re} is not offered`);
    await press(f.button(/^Pause: Morning brief$/));
    assert.deepEqual(calls.map((c) => c.method), ["pause"]);
  });

  await check("driven: a slow receipt for one run never lands under another run opened after it", async () => {
    const runs = [
      { id: "r2", at: "2026-10-15T13:00:00.000Z", origin: "test", status: "done", summary: "Second." },
      { id: "r1", at: "2026-10-15T12:00:00.000Z", origin: "scheduled", status: "done", summary: "First." },
    ];
    const pending: Record<string, (v: unknown) => void> = {};
    const receiptFor = (id: string, text: string) => ({ ok: true, receipt: { ...runs.find((r) => r.id === id)!, scheduledFor: null, finishedAt: null, text, steps: [], failure: null } });
    const { api } = fakeApi({
      runs: () => ({ ok: true, runs }),
      receipt: ((_id: string, runId: string) => new Promise((resolve) => (pending[runId] = resolve))) as never,
    });
    const view = mount(GuidedAutomationsList, () => ({
      state: { kind: "ready" as const, data: [LIST_ITEMS[0]] },
      api,
      nowMs: NOW,
      onEdit: () => undefined,
      onItem: () => undefined,
      onRemoved: () => undefined,
      onTested: () => undefined,
      onRetry: () => undefined,
    }));
    let f = frame(view);
    (f.els.find((e) => e.type === "details")!.props.onToggle as (e: unknown) => void)({ currentTarget: { open: true } });
    await settle();
    f = frame(view);
    const runButton = (i: number) => f.els.filter((e) => e.type === "button" && e.props["aria-expanded"] !== undefined)[i];
    // Open the older run, then the newer one before the first answer arrives.
    (runButton(1).props.onClick as () => void)();
    f = frame(view);
    (runButton(0).props.onClick as () => void)();
    pending.r2(receiptFor("r2", "The newer run's text."));
    await settle();
    pending.r1(receiptFor("r1", "The older run's text."));
    await settle();
    f = frame(view);
    assert.match(f.words, /The newer run's text\./);
    assert.doesNotMatch(f.words, /The older run's text\./, "the slower, older answer was dropped");
  });

  await check("driven: a refused delete or turn on in the list says so and removes nothing", async () => {
    const { api } = fakeApi({
      remove: () => failure({ error: "forbidden", message: "Only owners and admins can delete automations." }),
      activate: () => failure({ error: "cloud_unavailable", message: "Cloud has no AI account yet.", repair: { label: "Connect an AI account", href: "/settings/ai" } }),
    });
    const removed: string[] = [];
    const changed: GuidedAutomationView[] = [];
    const view = mount(GuidedAutomationsList, () => ({
      state: { kind: "ready" as const, data: LIST_ITEMS },
      api,
      nowMs: NOW,
      onEdit: () => undefined,
      onItem: (i: GuidedAutomationView) => changed.push(i),
      onRemoved: (id: string) => removed.push(id),
      onTested: () => undefined,
      onRetry: () => undefined,
    }));
    await press(frame(view).button(/^Delete: Quiet leads$/));
    await press(frame(view).button(/^Yes, delete$/));
    let f = frame(view);
    assert.deepEqual(removed, []);
    assert.match(f.words, /Only owners and admins can delete automations\./);
    await press(f.button(/^Turn on: Quiet leads$/));
    f = frame(view);
    assert.match(f.words, /Cloud has no AI account yet\./);
    assert.ok(f.els.some((e) => e.type === "a" && e.props.href === "/settings/ai"));
    assert.deepEqual(changed, []);
  });


  await check("driven: Recent runs stays closed and reads nothing until opened; a run opens as a receipt; a failed read says so", async () => {
    const runs = [
      { id: "r2", at: "2026-10-15T13:00:00.000Z", origin: "test", status: "done", summary: "Two leads are quiet." },
      { id: "r1", at: "2026-10-15T12:00:00.000Z", origin: "scheduled", status: "failed", summary: "It took longer than its time limit and was stopped." },
    ];
    const receipt = {
      ...runs[0],
      scheduledFor: null,
      finishedAt: null,
      text: "Call Dana first.",
      steps: [{ label: "Looking up the pipeline", ok: true }, { label: "Reading lead history", ok: false }],
      failure: null,
    };
    let fail = false;
    const { api, calls } = fakeApi({
      runs: () => (fail ? failure({ error: "server_error", message: "We could not load the runs." }) : { ok: true, runs }),
      receipt: () => ({ ok: true, receipt }),
    });
    const view = mount(GuidedAutomationsList, () => ({
      state: { kind: "ready" as const, data: [LIST_ITEMS[0]] },
      api,
      nowMs: NOW,
      onEdit: () => undefined,
      onItem: () => undefined,
      onRemoved: () => undefined,
      onTested: () => undefined,
      onRetry: () => undefined,
    }));
    let f = frame(view);
    assert.equal(calls.length, 0, "closed: nothing is read");
    assert.match(f.words, /Recent runs/);
    const toggle = (open: boolean) => (f.els.find((e) => e.type === "details")!.props.onToggle as (e: unknown) => void)({ currentTarget: { open } });
    toggle(true);
    await settle();
    f = frame(view);
    assert.deepEqual(calls.map((c) => [c.method, c.args[0]]), [["runs", LIST_ITEMS[0].id]]);
    assert.match(f.words, /Finished/);
    assert.match(f.words, /Failed/);
    assert.match(f.words, /Preview/);
    assert.match(f.words, /Scheduled/);
    assert.match(f.words, /Two leads are quiet\./);
    const runButtons = () => f.els.filter((e) => e.type === "button" && e.props["aria-expanded"] !== undefined);
    assert.equal(runButtons().length, 2);
    assert.equal(runButtons()[0].props["aria-expanded"], false);
    await press(runButtons()[0]);
    f = frame(view);
    assert.deepEqual(calls.at(-1)?.args, [LIST_ITEMS[0].id, "r2"]);
    assert.match(f.words, /What it looked up/);
    assert.match(f.words, /Looking up the pipeline/);
    assert.match(f.words, /Reading lead history \(could not be read\)/);
    assert.match(f.words, /What it wrote/);
    assert.match(f.words, /Call Dana first\./);
    assert.match(f.words, /Preview only\. Nothing was sent or filed\./);
    assert.equal(runButtons()[0].props["aria-expanded"], true);
    await press(runButtons()[0]);
    f = frame(view);
    assert.equal(runButtons()[0].props["aria-expanded"], false, "pressing again closes it");
    // A failed read is said, not shown as an empty list.
    fail = true;
    toggle(false);
    f = frame(view);
    toggle(true);
    await settle();
    f = frame(view);
    assert.match(f.words, /We could not load the runs\./);
    assertPlainCopy(f.words, "Recent runs");
  });

  console.log(failures ? `guided-automations-ui: ${failures} failure(s)` : "guided-automations-ui: all passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
