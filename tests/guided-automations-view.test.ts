/**
 * tests/guided-automations-view.test.ts - the guided builder's decisions, without a browser.
 *
 * Pins lib/automations/guided/view.ts (step gating, the Review sentence, next runs in Toronto time, the
 * three Review buttons, labels) and lib/automations/guided/flow.ts (Save, Test now, Turn on against a fake
 * GuidedApi that records its calls and can answer ok and every failure shape). The point of the flow
 * checks is the honesty rule: a success line is built only from what the server returned.
 *
 * Run: node --conditions=react-server --import tsx tests/guided-automations-view.test.ts
 */
import assert from "node:assert/strict";
import type { DepartmentKey } from "../lib/os/types";
import type {
  ApiFailure,
  ApiResult,
  GuidedContextView,
  LastRunView,
  Problem,
  TestResult,
} from "../lib/automations/guided/api-types";
import { activatedLine, loadContext, loadList, runTest, saveAutomation, savedLine, toFailure, activateAutomation, pauseAutomation, removeAutomation } from "../lib/automations/guided/flow";
import { ALL_TEMPLATES, templateById, readToolsFor } from "../lib/automations/guided/templates";
import { GUIDED_ZONE, requiredConnectors } from "../lib/automations/guided/validate";
import {
  GENERIC_FAILURE,
  MANUAL_RUNS_TEXT,
  STEPS,
  availableDepartments,
  canDraftEmails,
  canEditDays,
  canEditTime,
  canVisit,
  choiceStyle,
  chipLabel,
  connectionRows,
  counterText,
  defaultName,
  departmentLabel,
  draftFromItem,
  draftTemplate,
  editSession,
  emptyDraft,
  errorAt,
  furthestStep,
  gateFor,
  instantText,
  lastRunHead,
  nameProblem,
  nextRunLine,
  nextRunsView,
  pickDepartment,
  planFor,
  readyMadeCount,
  relativeTime,
  requiredSlugs,
  reviewActions,
  reviewSentence,
  runStatusLabel,
  scheduleChoiceFromPlan,
  sentenceFor,
  setInput,
  setName,
  setOutput,
  setScheduleDays,
  setSchedulePreset,
  setScheduleTime,
  setTool,
  slugLabel,
  snapshotOf,
  statusLabel,
  summaryRows,
  toRaw,
  upsertItem,
  validateDraft,
  type ReviewFacts,
} from "../lib/automations/guided/view";
import { ALL_DEPARTMENTS, CTX, NOW, assertPlainCopy, customDraft, draftOf, failure, fakeApi, itemFrom } from "./guided-automations.fixtures";

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

async function main() {
  console.log("guided-automations-view:");

  // ── departments ──
  await check("departments: Support is the word, Finance only with company financials, the access list is respected", () => {
    assert.equal(departmentLabel("client_success"), "Support");
    assert.deepEqual(availableDepartments(CTX), ALL_DEPARTMENTS);
    assert.ok(!availableDepartments({ departments: ALL_DEPARTMENTS, companyFinancials: false }).includes("finance"));
    assert.deepEqual(availableDepartments({ departments: ["operations", "sales"], companyFinancials: true }), ["sales", "operations"], "catalogue order, restricted to the list");
    assert.deepEqual(availableDepartments({ departments: [], companyFinancials: true }), []);
  });

  await check("departments: the ready-made count is the catalogue's, custom excluded", () => {
    for (const d of ALL_DEPARTMENTS) {
      const fixed = ALL_TEMPLATES.filter((t) => t.department === d && !t.custom && (!t.companyFinancialsOnly || CTX.companyFinancials));
      assert.equal(readyMadeCount(d, CTX), fixed.length, d);
      assert.ok(readyMadeCount(d, CTX) >= 1, `${d} has at least one ready-made job`);
    }
    assert.equal(readyMadeCount("finance", { companyFinancials: false }), 0, "the money summary is hidden without company financials");
    assert.equal(readyMadeCount("sales", CTX), 2);
  });

  // ── the draft ──
  await check("pickDepartment keeps the draft for the same department and starts over for another", () => {
    const d = draftOf("followup_drafts", "sales");
    assert.equal(pickDepartment(d, "sales"), d);
    const other = pickDepartment(d, "marketing");
    assert.equal(other.department, "marketing");
    assert.equal(other.templateId, null);
    assert.deepEqual(other.inputs, {});
  });

  await check("pickTemplate fills the defaults, the first schedule and the template's name; the custom brief starts with nothing ticked", () => {
    const d = draftOf("followup_drafts", "sales");
    assert.deepEqual(d.inputs, { max_drafts: 3, goal: "book_call", tone: "friendly" });
    assert.equal(d.schedule?.presetId, "weekdays_0900");
    assert.equal(d.name, "Follow-up drafts");
    const c = draftOf("custom", "sales");
    assert.deepEqual(c.tools, []);
    assert.equal(c.output, "digest");
    assert.equal(c.name, "Something else");
  });

  await check("a name the person typed stops following the objective; an untouched one follows it", () => {
    let c = draftOf("custom", "sales");
    c = setInput(c, "objective", "Find the quiet leads");
    assert.equal(c.name, "Find the quiet leads");
    c = setName(c, "My name");
    c = setInput(c, "objective", "Something else entirely");
    assert.equal(c.name, "My name");
    const long = "word ".repeat(30).trim();
    const t = templateById("custom", "sales")!;
    assert.ok(defaultName(t, { objective: long }).length <= 60);
    assert.equal(defaultName(t, { objective: "   " }), "Something else");
  });

  await check("setTool keeps the department's own order and unticks", () => {
    let d = draftOf("custom", "sales");
    d = setTool(d, "leads_search", true);
    d = setTool(d, "department_numbers", true);
    assert.deepEqual(d.tools, readToolsFor("sales").filter((t) => t === "department_numbers" || t === "leads_search"));
    d = setTool(d, "leads_search", false);
    assert.deepEqual(d.tools, ["department_numbers"]);
  });

  // ── gating ──
  await check("gating: cannot leave Department without one, and a department that is not yours does not count", () => {
    const g = gateFor("department", emptyDraft(), CTX);
    assert.equal(g.open, false);
    assert.equal(g.blocker, "Pick a department to continue.");
    assert.equal(gateFor("department", pickDepartment(emptyDraft(), "sales"), CTX).open, true);
    const limited = { ...CTX, departments: ["sales"] as DepartmentKey[] };
    const bad = gateFor("department", pickDepartment(emptyDraft(), "marketing"), limited);
    assert.equal(bad.open, false);
    assert.match(bad.blocker ?? "", /not available to you/);
    assert.equal(gateFor("department", pickDepartment(emptyDraft(), "finance"), { ...CTX, companyFinancials: false }).open, false);
  });

  await check("gating: cannot leave Job without a template", () => {
    const d = pickDepartment(emptyDraft(), "sales");
    const g = gateFor("job", d, CTX);
    assert.equal(g.open, false);
    assert.equal(g.blocker, "Pick a job to continue.");
    assert.equal(g.field, "template");
    assert.equal(gateFor("job", draftOf("stalled_digest", "sales"), CTX).open, true);
  });

  await check("gating: the custom brief needs an objective and at least one ticked read", () => {
    const empty = draftOf("custom", "sales");
    const noObjective = gateFor("job", empty, CTX);
    assert.equal(noObjective.open, false);
    assert.equal(noObjective.field, "objective");
    assert.match(noObjective.blocker ?? "", /What should it look into\?/);
    const short = setInput(empty, "objective", "abc");
    assert.equal(gateFor("job", short, CTX).open, false, "four characters is not an objective");
    const noTools = setInput(empty, "objective", "Which leads have gone quiet?");
    const g = gateFor("job", noTools, CTX);
    assert.equal(g.open, false);
    assert.equal(g.field, "tools");
    assert.equal(g.blocker, "Tick at least one thing it may read.");
    const ok = setTool(noTools, "pipeline_summary", true);
    assert.equal(gateFor("job", ok, CTX).open, true);
  });

  await check("gating: Connections and Runs on never block moving on, even with an app missing and Cloud not ready", () => {
    const d = draftOf("followup_drafts", "sales");
    const worst: GuidedContextView = { ...CTX, cloud: { ready: false, reason: "No AI account is connected.", repair: null }, connections: [{ slug: "google-workspace", label: "Google Workspace", state: "not_connected", repair: { label: "Connect Google Workspace", href: "/settings/connections" } }] };
    assert.equal(gateFor("connections", d, worst).open, true);
    assert.equal(gateFor("runs_on", d, worst).open, true);
    assert.equal(gateFor("review", d, worst).open, false, "Review is the last step");
  });

  await check("gating: furthest reachable step follows the draft, and a step is visitable only when all before it are open", () => {
    const order = STEPS.map((s) => s.id);
    assert.deepEqual(order, ["department", "job", "connections", "runs_on", "review"]);
    assert.equal(furthestStep(emptyDraft(), CTX), "department");
    assert.equal(furthestStep(pickDepartment(emptyDraft(), "sales"), CTX), "job");
    assert.equal(furthestStep(draftOf("stalled_digest", "sales"), CTX), "review");
    assert.equal(furthestStep(draftOf("custom", "sales"), CTX), "job");
    assert.equal(canVisit("review", draftOf("custom", "sales"), CTX), false);
    assert.equal(canVisit("department", draftOf("custom", "sales"), CTX), true);
  });

  // ── validation, shown at the field the validator names ──
  await check("every ready-made job is valid on its defaults and with every one of its schedule presets", () => {
    let n = 0;
    for (const t of ALL_TEMPLATES.filter((x) => !x.custom)) {
      for (const p of t.schedulePresets) {
        const d = setSchedulePreset(draftOf(t.id, t.department), p.id);
        const v = validateDraft(d, CTX);
        assert.ok(v.ok, `${t.id} / ${p.id}: ${v.ok ? "" : v.message}`);
        n += 1;
      }
    }
    assert.ok(n >= 20, `checked ${n} combinations`);
  });

  await check("the custom brief is valid in every department once it has an objective and a read; drafts only where the department can draft", () => {
    for (const dept of ALL_DEPARTMENTS) {
      assert.ok(validateDraft(customDraft(dept), CTX).ok, dept);
      const drafts = setOutput(customDraft(dept), "email_drafts");
      const v = validateDraft(drafts, CTX);
      assert.equal(v.ok, canDraftEmails(dept), `${dept}: drafts allowed exactly where the department can draft`);
      if (!v.ok) assert.equal(v.field, "tools");
    }
  });

  await check("an out-of-range number is refused with the validator's sentence, at the number's own field", () => {
    const d = setInput(draftOf("stalled_digest", "sales"), "days_quiet", 99);
    const v = validateDraft(d, CTX);
    assert.ok(!v.ok);
    if (!v.ok) {
      assert.equal(v.field, "days_quiet");
      assert.equal(v.message, '"Count a lead as stalled after" must be a whole number from 3 to 30.');
      assert.equal(errorAt(v, "days_quiet", new Set(["days_quiet"])), v.message);
      assert.equal(errorAt(v, "days_quiet", new Set()), null, "an untouched field shows no error yet");
      assert.equal(errorAt(v, "schedule", new Set(["schedule", "days_quiet"])), null, "an error is shown only at the field it names");
    }
    assert.equal(setInput(draftOf("stalled_digest", "sales"), "days_quiet", "abc").inputs.days_quiet, "abc", "what is typed is kept until it is valid");
    assert.ok(!validateDraft(setInput(draftOf("stalled_digest", "sales"), "days_quiet", "abc"), CTX).ok);
  });

  await check("a text answer that is too long or too short is refused at its field", () => {
    const base = draftOf("custom", "sales");
    const tooLong = validateDraft(setTool(setInput(base, "objective", "x".repeat(401)), "leads_search", true), CTX);
    assert.ok(!tooLong.ok);
    if (!tooLong.ok) {
      assert.equal(tooLong.field, "objective");
      assert.match(tooLong.message, /at most 400 characters/);
    }
    const tooShort = validateDraft(setTool(setInput(base, "objective", "hi"), "leads_search", true), CTX);
    assert.ok(!tooShort.ok && tooShort.field === "objective");
    assert.equal(counterText(37, 400), "37 of 400 characters");
  });

  await check("a time that is cleared is refused at the schedule, and an unknown preset is not a plan", () => {
    const cleared = setScheduleTime(draftOf("daily_brief", "chief_of_staff"), "");
    const v = validateDraft(cleared, CTX);
    assert.ok(!v.ok);
    if (!v.ok) {
      assert.equal(v.field, "schedule");
      assert.match(v.message, /Pick a time of day/);
    }
    const t = templateById("daily_brief", "chief_of_staff")!;
    assert.equal(planFor(t, { presetId: "nope" }), null);
    assert.equal(planFor(t, null), null);
  });

  await check("toRaw sends tools and output only for the custom brief", () => {
    const fixed = toRaw(draftOf("stalled_digest", "sales")) as Record<string, unknown>;
    assert.ok(!("tools" in fixed) && !("output" in fixed), "a ready-made job never proposes its own tools or result");
    const custom = toRaw(customDraft("sales")) as Record<string, unknown>;
    assert.ok(Array.isArray(custom.tools) && custom.output === "digest");
    assert.equal(toRaw(pickDepartment(emptyDraft(), "sales")), null);
  });

  // ── schedule ──
  await check("planFor puts the plan in Toronto time and applies a changed time and days", () => {
    const t = templateById("daily_brief", "chief_of_staff")!;
    assert.deepEqual(planFor(t, { presetId: "weekdays_0730" }), { mode: "weekdays", time: "07:30", timezone: GUIDED_ZONE });
    assert.deepEqual(planFor(t, { presetId: "weekdays_0730", time: "06:15" }), { mode: "weekdays", time: "06:15", timezone: GUIDED_ZONE });
    assert.deepEqual(planFor(t, { presetId: "monday_0800", days: [4, 1], time: "09:00" }), { mode: "weekly", time: "09:00", days: [4, 1], timezone: GUIDED_ZONE });
    assert.deepEqual(planFor(t, { presetId: "manual", time: "09:00" }), { mode: "manual", timezone: GUIDED_ZONE }, "a manual schedule has no time to change");
    const days = setScheduleDays(setSchedulePreset(draftOf("daily_brief", "chief_of_staff"), "monday_0800"), [4, 1]);
    assert.deepEqual(days.schedule?.days, [1, 4], "days are kept in order");
  });

  await check("chips keep the catalogue's wording until the time or days change, then say the change", () => {
    const t = templateById("daily_brief", "chief_of_staff")!;
    const [weekdays, daily, mondays, manual] = t.schedulePresets;
    assert.equal(chipLabel(weekdays, { presetId: weekdays.id }), "Weekdays at 7:30 AM");
    assert.equal(chipLabel(weekdays, { presetId: weekdays.id, time: "06:00" }), "Weekdays at 6:00 AM");
    assert.equal(chipLabel(daily, { presetId: daily.id, time: "18:45" }), "Every day at 6:45 PM");
    assert.equal(chipLabel(mondays, { presetId: mondays.id, days: [1, 4], time: "09:00" }), "Mondays and Thursdays at 9:00 AM");
    assert.equal(chipLabel(mondays, { presetId: mondays.id, days: [] }), mondays.label, "no day left: the catalogue's label, and the validator says why");
    assert.equal(chipLabel(weekdays, { presetId: weekdays.id, time: "" }), weekdays.label, "a cleared time never prints NaN");
    assert.equal(chipLabel(weekdays, { presetId: "other", time: "06:00" }), weekdays.label, "another chip's change is not this chip's");
    assert.equal(chipLabel(manual, { presetId: manual.id }), "Only when I run it");
    assert.ok(canEditTime(weekdays) && canEditTime(mondays) && !canEditTime(manual));
    assert.ok(canEditDays(mondays) && !canEditDays(weekdays));
  });

  await check("a stored plan reads back into its chip, with its changes; an unoffered schedule is null", () => {
    for (const t of ALL_TEMPLATES.filter((x) => !x.custom)) {
      for (const p of t.schedulePresets) {
        const plan = planFor(t, { presetId: p.id })!;
        assert.deepEqual(scheduleChoiceFromPlan(t, plan), { presetId: p.id }, `${t.id}/${p.id}`);
      }
    }
    const t = templateById("daily_brief", "chief_of_staff")!;
    assert.deepEqual(scheduleChoiceFromPlan(t, { mode: "weekdays", time: "06:00", timezone: GUIDED_ZONE }), { presetId: "weekdays_0730", time: "06:00" });
    assert.deepEqual(scheduleChoiceFromPlan(t, { mode: "weekly", time: "09:00", days: [2, 4], timezone: GUIDED_ZONE }), { presetId: "monday_0800", time: "09:00", days: [2, 4] });
    assert.equal(scheduleChoiceFromPlan(t, { mode: "monthly", time: "09:00", day_of_month: 3, timezone: GUIDED_ZONE }), null);
    assert.equal(scheduleChoiceFromPlan(t, { mode: "custom", cron: "5 4 * * *", timezone: GUIDED_ZONE }), null);
    const ops = templateById("ops_check", "operations")!;
    assert.equal(scheduleChoiceFromPlan(ops, { mode: "every_n_hours", time: "06:00", every_hours: 3, timezone: GUIDED_ZONE }), null, "an interval the chips do not offer");
  });

  await check("next runs: three instants in Toronto time from the one schedule library, with the zone's abbreviation", () => {
    const plan = planFor(templateById("daily_brief", "chief_of_staff")!, { presetId: "weekdays_0730" })!;
    const view = nextRunsView(plan, new Date(NOW));
    assert.deepEqual(view, { kind: "runs", lines: ["Fri, Oct 16, 7:30 AM EDT", "Mon, Oct 19, 7:30 AM EDT", "Tue, Oct 20, 7:30 AM EDT"] });
  });

  await check("next runs cross the fall-back weekend with the right abbreviation for each run", () => {
    const plan = planFor(templateById("support_risk", "client_success")!, { presetId: "daily_0730" })!;
    const view = nextRunsView(plan, new Date(Date.UTC(2026, 9, 30, 20, 0, 0)));
    assert.deepEqual(view, { kind: "runs", lines: ["Sat, Oct 31, 7:30 AM EDT", "Sun, Nov 1, 7:30 AM EST", "Mon, Nov 2, 7:30 AM EST"] });
  });

  await check("next runs: a manual schedule says it runs only when you press Test now, and a plan with no runs says so", () => {
    const manual = planFor(templateById("daily_brief", "chief_of_staff")!, { presetId: "manual" })!;
    assert.deepEqual(nextRunsView(manual, new Date(NOW)), { kind: "manual", text: "Runs only when you press Test now." });
    assert.equal(MANUAL_RUNS_TEXT, "Runs only when you press Test now.");
    const broken = nextRunsView({ mode: "daily", time: "", timezone: GUIDED_ZONE }, new Date(NOW));
    assert.equal(broken.kind, "none");
  });

  // ── the Review sentence ──
  await check("Review sentence: Daily brief", () => {
    assert.equal(
      reviewSentence(draftOf("daily_brief", "chief_of_staff")),
      'Every weekday (Monday to Friday) at 7:30 AM, Toronto time, your "Daily brief" automation will write you a short brief (about 5 lines) from your department numbers, the approvals waiting, the pipeline and today\'s calendar; each run\'s summary appears under Your automations.',
    );
    const full = setInput(setInput(draftOf("daily_brief", "chief_of_staff"), "length", "full"), "calendar", "no");
    assert.equal(
      reviewSentence(full),
      'Every weekday (Monday to Friday) at 7:30 AM, Toronto time, your "Daily brief" automation will write you a full brief (up to 12 lines) from your department numbers, the approvals waiting and the pipeline; each run\'s summary appears under Your automations.',
    );
  });

  await check("Review sentence: Follow-up drafts says the emails wait for approval and uses the person's settings", () => {
    assert.equal(
      reviewSentence(draftOf("followup_drafts", "sales")),
      'Every weekday (Monday to Friday) at 9:00 AM, Toronto time, your "Follow-up drafts" automation will find up to 3 leads whose follow-up is overdue and write a friendly email to each that invites them to book a short call; each email is filed in Needs you for your approval.',
    );
    const changed = setSchedulePreset(setInput(setInput(setInput(draftOf("followup_drafts", "sales"), "max_drafts", 1), "goal", "re_engage"), "tone", "formal"), "monday_0900");
    assert.equal(
      reviewSentence(changed),
      'Every Monday at 9:00 AM, Toronto time, your "Follow-up drafts" automation will find up to 1 lead whose follow-up is overdue and write a formal email to each that re-opens a conversation that went quiet; each email is filed in Needs you for your approval.',
    );
  });

  await check("Review sentence: Stalled-lead digest, Weekly money summary, Routines check, Support, Marketing", () => {
    assert.equal(
      reviewSentence(draftOf("stalled_digest", "sales", (d) => setInput(d, "days_quiet", 10))),
      'Every weekday (Monday to Friday) at 8:30 AM, Toronto time, your "Stalled-lead digest" automation will list the leads with no activity for 10 days or more, grouped by stage, and name the one to call first; each run\'s summary appears under Your automations.',
    );
    assert.equal(
      reviewSentence(draftOf("money_summary", "finance", (d) => setInput(d, "metric", "mrr"))),
      'Every Monday at 7:00 AM, Toronto time, your "Weekly money summary" automation will report your recurring revenue from your Finance page; each run\'s summary appears under Your automations.',
    );
    assert.match(reviewSentence(draftOf("ops_check", "operations", (d) => setInput(d, "only_problems", "no"))) ?? "", /report every routine with its last result, and every connection and whether it is connected/);
    assert.match(reviewSentence(draftOf("support_risk", "client_success")) ?? "", /flag the open support tickets that are late or about to be, and the client projects due within 7 days/);
    assert.match(reviewSentence(draftOf("marketing_numbers", "marketing")) ?? "", /report the numbers your Marketing page shows/);
  });

  await check("Review sentence: the custom brief names the objective and the ticked reads, and a manual schedule says Test now", () => {
    assert.equal(
      reviewSentence(customDraft("sales", "Which leads from this week have not had a reply?", ["pipeline_summary", "leads_search"])),
      'Every weekday (Monday to Friday) at 8:00 AM, Toronto time, your custom automation will look into "Which leads from this week have not had a reply?" using pipeline and leads; each run\'s summary appears under Your automations.',
    );
    const drafts = setOutput(customDraft("sales"), "email_drafts");
    assert.match(reviewSentence(drafts) ?? "", /each email is filed in Needs you for your approval\.$/);
    const manual = setSchedulePreset(draftOf("daily_brief", "chief_of_staff"), "manual");
    assert.match(reviewSentence(manual) ?? "", /^Only when you press Test now, your "Daily brief" automation will /);
    assert.equal(reviewSentence(pickDepartment(emptyDraft(), "sales")), null);
  });

  await check("Review sentence: one sentence, plain words, for every job and every schedule", () => {
    for (const t of ALL_TEMPLATES) {
      for (const p of t.schedulePresets) {
        const d = t.custom ? setSchedulePreset(customDraft(t.department), p.id) : setSchedulePreset(draftOf(t.id, t.department), p.id);
        const s = reviewSentence(d);
        assert.ok(s, `${t.id}/${p.id}`);
        assertPlainCopy(s!, `${t.id}/${p.id}`);
        assert.ok(s!.endsWith("."), s);
        assert.equal((s!.match(/\. /g) ?? []).length, 0, `one sentence: ${s}`);
      }
    }
  });

  // ── the summary rail ──
  await check("summary rail: Not chosen yet until chosen, then the settings in the person's words", () => {
    const empty = summaryRows(emptyDraft());
    assert.deepEqual(empty.map((r) => r.label), ["Department", "Job", "Result", "When", "Apps", "Runs on"]);
    assert.ok(empty.every((r) => r.value === null));
    const rows = summaryRows(draftOf("followup_drafts", "sales"));
    const get = (l: string) => rows.find((r) => r.label === l)!;
    assert.equal(get("Department").value, "Sales");
    assert.equal(get("Job").value, "Follow-up drafts");
    assert.deepEqual(get("Job").lines, ["At most this many drafts per run: 3 drafts", "What each email is for: Invite them to book a short call", "Tone: Friendly"]);
    assert.equal(get("Result").value, "Email drafts for your approval");
    assert.equal(get("Apps").value, "Google Workspace");
    assert.equal(get("Runs on").value, "Cloud");
    assert.equal(summaryRows(draftOf("stalled_digest", "sales")).find((r) => r.label === "Apps")!.value, "None needed");
    const custom = summaryRows(customDraft("sales", "Why is it quiet?", ["pipeline_summary"]));
    assert.ok(custom.find((r) => r.label === "Job")!.lines.includes("May read: pipeline"));
    assert.ok(custom.find((r) => r.label === "Job")!.lines.includes("What should it look into? Why is it quiet?"), "a label that is a question takes no colon");
    assert.ok(summaryRows(draftOf("custom", "sales")).find((r) => r.label === "Job")!.lines.includes("May read: nothing ticked yet"));
  });

  // ── connections ──
  await check("required apps come from the same function the API uses; unknown apps are named, not hidden", () => {
    assert.deepEqual(requiredSlugs(draftOf("followup_drafts", "sales")), ["google-workspace"]);
    assert.deepEqual(requiredSlugs(draftOf("daily_brief", "chief_of_staff")), []);
    const drafts = setOutput(customDraft("sales"), "email_drafts");
    assert.deepEqual(requiredSlugs(drafts), requiredConnectors({ template: { id: "custom", version: 1 }, department: "sales", output: "email_drafts" }));
    assert.deepEqual(requiredSlugs(drafts), ["google-workspace"]);
    assert.deepEqual(requiredSlugs(customDraft("sales")), []);
    assert.equal(slugLabel("google-workspace"), "Google Workspace");
  });

  await check("connection rows: state in words, repair link kept for what is not connected, only broken ones block Turn on", () => {
    const repair = { label: "Reconnect Google Workspace", href: "/settings/connections?fix=google" };
    const facts = [{ slug: "google-workspace", label: "Google Workspace", state: "attention" as const, repair }];
    const [row] = connectionRows(["google-workspace"], facts);
    assert.deepEqual({ ...row }, { slug: "google-workspace", label: "Google Workspace", state: "attention", stateLabel: "Needs attention", repair, blocksTurnOn: true });
    const [ok] = connectionRows(["google-workspace"], [{ ...facts[0], state: "connected" }]);
    assert.equal(ok.repair, null, "nothing to repair");
    assert.equal(ok.blocksTurnOn, false);
    const [missing] = connectionRows(["stripe"], []);
    assert.equal(missing.label, "Stripe");
    assert.equal(missing.state, "unknown");
    assert.equal(missing.stateLabel, "We could not check this app");
    assert.equal(missing.blocksTurnOn, false, "an app we could not check is left to the server to decide");
    const [off] = connectionRows(["google-workspace"], [{ ...facts[0], state: "not_connected" }]);
    assert.equal(off.stateLabel, "Not connected");
    assert.equal(off.blocksTurnOn, true);
  });

  // ── the three Review buttons ──
  const facts = (over: Partial<ReviewFacts> = {}): ReviewFacts => ({
    valid: true,
    validMessage: null,
    nameOk: true,
    saved: false,
    dirty: false,
    testPassed: false,
    skipTest: false,
    status: null,
    cloudReady: true,
    cloudReason: null,
    missingApps: [],
    busy: null,
    ...over,
  });

  await check("Review buttons: before the first save only Save is available, and it is the primary", () => {
    const a = reviewActions(facts());
    assert.deepEqual([a.save.enabled, a.test.enabled, a.activate.enabled, a.primary], [true, false, false, "save"]);
    assert.equal(a.save.label, "Save");
    assert.equal(a.test.why, "Save first. Test now runs the saved automation, once, as a preview.");
    assert.equal(a.activate.why, "Save first.");
  });

  await check("Review buttons: Save says why it cannot, in the validator's own sentence", () => {
    const a = reviewActions(facts({ valid: false, validMessage: "Tick at least one thing it may read." }));
    assert.equal(a.save.enabled, false);
    assert.equal(a.save.why, "Tick at least one thing it may read.");
    assert.equal(a.primary, "none");
    assert.equal(reviewActions(facts({ nameOk: false })).save.why, "Give it a name to save.");
  });

  await check("Review buttons: saved and clean, Test now is the primary; Turn on waits for a test or a confirmed skip", () => {
    const saved = reviewActions(facts({ saved: true, status: "paused" }));
    assert.deepEqual([saved.save.enabled, saved.test.enabled, saved.activate.enabled, saved.primary], [false, true, false, "test"]);
    assert.equal(saved.save.label, "Saved");
    assert.equal(saved.activate.why, "Test it first, or confirm below that you want to skip the test.");
    const tested = reviewActions(facts({ saved: true, status: "paused", testPassed: true }));
    assert.deepEqual([tested.activate.enabled, tested.primary], [true, "activate"]);
    const skipped = reviewActions(facts({ saved: true, status: "paused", skipTest: true }));
    assert.equal(skipped.activate.enabled, true);
  });

  await check("Review buttons: an edit after saving turns Test and Turn on off until it is saved again", () => {
    const dirty = reviewActions(facts({ saved: true, dirty: true, status: "paused", testPassed: true }));
    assert.equal(dirty.save.label, "Save changes");
    assert.deepEqual([dirty.save.enabled, dirty.test.enabled, dirty.activate.enabled, dirty.primary], [true, false, false, "save"]);
    assert.equal(dirty.test.why, "Save your changes first, then test.");
    assert.equal(dirty.activate.why, "Save your changes first.");
  });

  await check("Review buttons: a missing app or an unready Cloud blocks Turn on, never Save, and says which", () => {
    const apps = reviewActions(facts({ saved: true, status: "paused", testPassed: true, missingApps: ["Google Workspace"] }));
    assert.equal(apps.save.enabled, false, "already saved");
    assert.equal(apps.activate.enabled, false);
    assert.equal(apps.activate.why, "Connect Google Workspace first. You can keep it saved until then.");
    assert.equal(reviewActions(facts({ missingApps: ["Google Workspace"] })).save.enabled, true, "saving needs no connection");
    const cloud = reviewActions(facts({ saved: true, status: "paused", testPassed: true, cloudReady: false, cloudReason: "No AI account is connected." }));
    assert.equal(cloud.activate.enabled, false);
    assert.equal(cloud.activate.why, "Cloud is not ready yet: No AI account is connected.");
  });

  await check("Review buttons: nothing is available while a call is in flight, and an automation that is on cannot be turned on again", () => {
    for (const busy of ["save", "test", "activate", "pause"] as const) {
      const a = reviewActions(facts({ saved: true, status: "paused", testPassed: true, busy }));
      assert.deepEqual([a.save.enabled, a.test.enabled, a.activate.enabled], [false, false, false], busy);
    }
    assert.equal(reviewActions(facts({ saved: true, status: "paused", testPassed: true, busy: "save" })).save.label, "Saving...");
    const on = reviewActions(facts({ saved: true, status: "on", testPassed: true }));
    assert.equal(on.activate.enabled, false);
    assert.equal(on.activate.label, "On");
    assert.equal(on.activate.why, "It is already on.");
  });

  // ── editing a saved automation ──
  await check("editing: a saved custom drafts job opens with only its reads ticked, validates to the same payload, and is not dirty", () => {
    const original = setOutput(customDraft("sales", "Which leads need a nudge?", ["pipeline_summary", "leads_search"]), "email_drafts");
    const v = validateDraft(original, CTX);
    assert.ok(v.ok);
    if (!v.ok) return;
    assert.ok(v.payload.tools.includes("propose_email"), "the saved list carries the email draft tool");
    const item = itemFrom(original, "paused");
    const { draft, note } = draftFromItem(item);
    assert.equal(note, null);
    assert.deepEqual(draft.tools, ["pipeline_summary", "leads_search"], "the email draft tool is not a tick box");
    assert.equal(draft.output, "email_drafts");
    const again = validateDraft(draft, CTX);
    assert.ok(again.ok);
    if (again.ok) assert.deepEqual(again.payload, v.payload, "round trip");
    const session = editSession(item, CTX);
    assert.equal(session.step, "review");
    assert.equal(session.saved.snapshot, snapshotOf(item.name, v.payload), "no change since the save");
  });

  await check("editing: a changed time comes back as the chip with its time; a job that no longer exists opens on Job with a note", () => {
    const changed = setScheduleTime(draftOf("daily_brief", "chief_of_staff"), "06:00");
    const { draft } = draftFromItem(itemFrom(changed));
    assert.deepEqual(draft.schedule, { presetId: "weekdays_0730", time: "06:00" });
    const gone = itemFrom(draftOf("daily_brief", "chief_of_staff"));
    gone.payload = { ...gone.payload, template: { id: "retired_job", version: 1 } };
    const s = editSession(gone, CTX);
    assert.equal(s.step, "job");
    assert.match(s.note ?? "", /no longer available/);
    assert.equal(draftTemplate(s.draft), null);
    const odd = itemFrom(draftOf("daily_brief", "chief_of_staff"));
    odd.payload = { ...odd.payload, schedule: { plan: { mode: "monthly", time: "09:00", day_of_month: 3, timezone: GUIDED_ZONE } } };
    const o = draftFromItem(odd);
    assert.equal(o.draft.schedule, null);
    assert.match(o.note ?? "", /schedule the builder does not offer/);
  });

  await check("upsertItem replaces in place or adds first", () => {
    const a = itemFrom(draftOf("daily_brief", "chief_of_staff"), "paused", { id: "a" });
    const b = itemFrom(draftOf("stalled_digest", "sales"), "paused", { id: "b" });
    assert.deepEqual(upsertItem([a, b], { ...a, status: "on" }).map((x) => [x.id, x.status]), [["a", "on"], ["b", "paused"]]);
    assert.deepEqual(upsertItem([a], b).map((x) => x.id), ["b", "a"]);
  });

  // ── list wording ──
  await check("statuses and run results are words", () => {
    assert.deepEqual((["paused", "on", "needs_attention"] as const).map(statusLabel), ["Paused", "On", "Needs attention"]);
    assert.deepEqual(["done", "failed", "missed", "cancelled", "running", "queued", "weird"].map(runStatusLabel), ["Finished", "Failed", "Missed", "Cancelled", "Running now", "Waiting to start", "Unknown"]);
  });

  await check("relative time reads like a person", () => {
    const r = (ms: number) => relativeTime(NOW + ms, NOW);
    assert.equal(r(3 * 3_600_000), "in 3 hours");
    assert.equal(r(60_000), "in 1 minute");
    assert.equal(r(5 * 60_000), "in 5 minutes");
    assert.equal(r(2 * 86_400_000), "in 2 days");
    assert.equal(r(-2 * 86_400_000), "2 days ago");
    assert.equal(r(-3_600_000), "1 hour ago");
    assert.equal(r(20_000), "in less than a minute");
    assert.equal(r(-20_000), "just now");
  });

  await check("the next-run line: manual, paused, needs attention and on each say the truth", () => {
    const on = itemFrom(draftOf("daily_brief", "chief_of_staff"), "on", { nextRuns: [new Date(NOW + 3 * 3_600_000).toISOString()] });
    assert.equal(nextRunLine(on, NOW), "Next run: Thu, Oct 15, 11:00 AM EDT (in 3 hours)");
    assert.equal(nextRunLine(on, null), "Next run: Thu, Oct 15, 11:00 AM EDT", "no clock yet: the time alone");
    assert.equal(nextRunLine({ ...on, status: "paused", nextRuns: [] }, NOW), "Not scheduled while it is paused. Turn it on to start the schedule.");
    const problem = { code: "missing_connection:google-workspace", message: "Google is not connected.", repair: null };
    assert.equal(nextRunLine({ ...on, status: "needs_attention", problems: [problem], nextRuns: [] }, NOW), "Not scheduled until the problem below is fixed.");
    // No problem listed means only its last run failed: it is still scheduled, so the line must say when it tries again.
    assert.equal(nextRunLine({ ...on, status: "needs_attention", problems: [] }, NOW), "Its last run failed. Next try: Thu, Oct 15, 11:00 AM EDT (in 3 hours)");
    assert.equal(runStatusLabel("interrupted"), "Interrupted");
    assert.equal(runStatusLabel("something_new"), "Unknown");
    assert.equal(nextRunLine({ ...on, nextRuns: [] }, NOW), "The next run could not be worked out.");
    const manual = itemFrom(draftOf("daily_brief", "chief_of_staff", (d) => setSchedulePreset(d, "manual")), "on");
    assert.equal(nextRunLine(manual, NOW), "Runs only when you press Test now.");
  });

  await check("the last-run head names the result and the time, and a bad time is not printed", () => {
    const run: LastRunView = { at: new Date(NOW - 2 * 3_600_000).toISOString(), status: "failed", summary: "It could not read the pipeline.", receiptId: "r1", preview: false };
    assert.equal(lastRunHead(run, NOW), "Failed, Thu, Oct 15, 6:00 AM EDT (2 hours ago)");
    assert.equal(lastRunHead(run, null), "Failed, Thu, Oct 15, 6:00 AM EDT");
    assert.equal(lastRunHead({ ...run, at: "not a time" }, NOW), "Failed");
    assert.equal(instantText("nope"), null);
  });

  await check("choice fields are drawn as the shape that fits: Yes/No segmented, long answers as a list", () => {
    const style = (templateId: string, dept: DepartmentKey, field: string) => {
      const f = templateById(templateId, dept)!.inputs.find((i) => i.name === field)!;
      assert.equal(f.kind, "choice");
      return choiceStyle(f as Extract<typeof f, { kind: "choice" }>);
    };
    assert.equal(style("daily_brief", "chief_of_staff", "calendar"), "segmented");
    assert.equal(style("daily_brief", "chief_of_staff", "length"), "segmented");
    assert.equal(style("followup_drafts", "sales", "tone"), "segmented");
    assert.equal(style("followup_drafts", "sales", "goal"), "list");
    assert.equal(style("money_summary", "finance", "metric"), "list");
  });

  await check("a bare error code is never shown: the server's sentence, else ours", () => {
    assert.equal(sentenceFor("forbidden", "You cannot do that here."), "You cannot do that here.");
    assert.equal(sentenceFor("rate_limited", "rate_limited"), "That was too quick. Wait a moment and try again.");
    assert.equal(sentenceFor("rate_limited", ""), "That was too quick. Wait a moment and try again.");
    assert.equal(sentenceFor("who_knows", undefined), GENERIC_FAILURE);
    assert.equal(nameProblem("   "), "Give it a name so you can find it in your list.");
    assert.equal(nameProblem("x".repeat(81)), "A name can be at most 80 characters.");
    assert.equal(nameProblem("Morning brief"), null);
  });

  await check("all copy built here is plain: no dash, arrow or jargon", () => {
    for (const s of STEPS) for (const t of [s.label, s.title, s.lead]) assertPlainCopy(t, `step ${s.id}`);
    for (const d of ALL_DEPARTMENTS) assertPlainCopy(departmentLabel(d), d);
    for (const t of ALL_TEMPLATES.filter((x) => !x.custom)) {
      for (const p of t.schedulePresets) {
        const choice = { presetId: p.id, time: "13:05" };
        assertPlainCopy(chipLabel(p, choice), `${t.id}/${p.id}`);
      }
    }
    for (const [code, text] of [["a", GENERIC_FAILURE], ["b", sentenceFor("server_error", "")], ["c", sentenceFor("cloud_unavailable", "")]]) assertPlainCopy(text, code);
  });

  // ── flow: Save, Test now, Turn on against the fake API ──
  await check("flow: Save creates a NEW automation with the validated payload and the typed name, and says what the server returned", async () => {
    const { api, calls } = fakeApi();
    const draft = setName(draftOf("stalled_digest", "sales"), "  Quiet leads  ");
    const out = await saveAutomation(api, draft, CTX, null);
    assert.ok(out.ok);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "create");
    const sent = calls[0].args[0] as { name: string; payload: { template: { id: string }; target: unknown; approval: string; tools: string[] } };
    assert.equal(sent.name, "Quiet leads", "the name is trimmed");
    assert.equal(sent.payload.template.id, "stalled_digest");
    assert.deepEqual(sent.payload.target, { kind: "cloud" });
    assert.equal(sent.payload.approval, "proposal_only");
    assert.deepEqual(sent.payload.tools, ["pipeline_summary", "leads_search"], "the template's tools, normalised by the validator");
    if (out.ok) {
      assert.equal(savedLine(out.item), "Saved and paused. Nothing will run until you turn it on.");
      assert.equal(out.snapshot, snapshotOf("Quiet leads", sent.payload));
    }
  });

  await check("flow: Save of an edited automation calls update with its id, never create", async () => {
    const { api, calls } = fakeApi();
    const out = await saveAutomation(api, draftOf("stalled_digest", "sales"), CTX, "abc-123");
    assert.ok(out.ok);
    assert.deepEqual(calls.map((c) => [c.method, c.args[0]]), [["update", "abc-123"]]);
  });

  await check("flow: an invalid draft or a missing name never reaches the server", async () => {
    const { api, calls } = fakeApi();
    const invalid = await saveAutomation(api, draftOf("custom", "sales"), CTX, null);
    assert.ok(!invalid.ok);
    if (!invalid.ok) {
      assert.equal(invalid.failure.field, "objective");
      assert.match(invalid.failure.message, /What should it look into\?/);
    }
    const unnamed = await saveAutomation(api, setName(draftOf("stalled_digest", "sales"), "   "), CTX, null);
    assert.ok(!unnamed.ok);
    if (!unnamed.ok) assert.equal(unnamed.failure.field, "name");
    assert.equal(calls.length, 0, "nothing was sent");
  });

  await check("flow: every failure shape becomes a sentence with its field, repair link and problems intact", async () => {
    const repair = { label: "Reconnect Google Workspace", href: "/settings/connections" };
    const problems: Problem[] = [{ code: "connection_missing", message: "Google Workspace is not connected.", repair }];
    const shapes: ApiFailure[] = [
      failure({ error: "unauthorized", message: "" }),
      failure({ error: "forbidden", message: "Only owners can build automations." }),
      failure({ error: "not_found", message: "not_found" }),
      failure({ error: "cloud_unavailable", message: "Cloud has no AI account.", repair }),
      failure({ error: "connection_missing", message: "Connect Google Workspace first.", repair, problems }),
      failure({ error: "rate_limited", message: "" }),
      failure({ error: "server_error", message: "" }),
      failure({ error: "payload_invalid", message: "The automation is missing.", field: "template" }),
      failure({ error: "mystery_code", message: "" }),
    ];
    for (const shape of shapes) {
      const f = toFailure(shape);
      assert.match(f.message, /\s/, `${shape.error} is a sentence: ${f.message}`);
      assertPlainCopy(f.message, shape.error);
      assert.equal(f.code, shape.error);
      assert.equal(f.field, shape.field ?? null);
      assert.deepEqual(f.repair, shape.repair ?? null);
      assert.deepEqual(f.problems, shape.problems ?? []);
      const { api, calls } = fakeApi({ create: () => shape, update: () => shape, test: () => shape, activate: () => shape, pause: () => shape, remove: () => shape });
      const saved = await saveAutomation(api, draftOf("stalled_digest", "sales"), CTX, null);
      assert.ok(!saved.ok, `${shape.error}: a refused save is not a save`);
      if (!saved.ok) assert.equal(saved.failure.message, f.message);
      assert.ok(!(await runTest(api, "a1")).ok);
      assert.ok(!(await activateAutomation(api, "a1")).ok);
      assert.ok(!(await pauseAutomation(api, "a1")).ok);
      assert.ok(!(await removeAutomation(api, "a1")).ok);
      assert.equal(calls.length, 5);
    }
  });

  await check("flow: an answer that says ok but is missing the data is not shown as a success", async () => {
    const bad = { ok: true } as unknown as ApiResult<never>;
    const { api } = fakeApi({ create: () => bad, update: () => bad, test: () => bad, activate: () => bad, pause: () => bad, list: () => bad, context: () => bad });
    for (const out of [await saveAutomation(api, draftOf("stalled_digest", "sales"), CTX, null), await runTest(api, "a1"), await activateAutomation(api, "a1"), await pauseAutomation(api, "a1")]) {
      assert.ok(!out.ok);
      if (!out.ok) {
        assert.equal(out.failure.code, "bad_response");
        assert.match(out.failure.message, /Nothing is shown as done/);
      }
    }
    const ctx = await loadContext(api);
    assert.equal(ctx.kind, "error");
    const list = await loadList(api);
    assert.equal(list.kind, "error");
  });

  await check("flow: a call that throws is a failure with a sentence, not a crash", async () => {
    const original = console.error;
    console.error = () => undefined;
    try {
      const boom = () => {
        throw new Error("socket hang up");
      };
      const { api } = fakeApi({ create: boom, test: boom, activate: boom, list: boom, context: boom });
      const saved = await saveAutomation(api, draftOf("stalled_digest", "sales"), CTX, null);
      assert.ok(!saved.ok);
      if (!saved.ok) assert.equal(saved.failure.message, GENERIC_FAILURE);
      assert.ok(!(await runTest(api, "a1")).ok);
      assert.equal((await loadList(api)).kind, "error");
      assert.equal((await loadContext(api)).kind, "error");
    } finally {
      console.error = original;
    }
  });

  await check("flow: Test now returns the run's own result, including what it would have drafted, and a failed or cancelled run is returned as such", async () => {
    const withDrafts: TestResult = { runId: "r2", status: "done", finalText: "Two follow-ups.", wouldDraft: [{ to: "sam@example.com", subject: "Checking in", body: "Hi Sam." }], failure: null };
    const { api, calls } = fakeApi({ test: () => ({ ok: true, result: withDrafts }) });
    const out = await runTest(api, "a1");
    assert.ok(out.ok);
    if (out.ok) assert.deepEqual(out.result, withDrafts);
    assert.deepEqual(calls.map((c) => c.method), ["test"]);
    const failed: TestResult = { runId: "r3", status: "failed", finalText: "", wouldDraft: [], failure: "It could not read the pipeline." };
    const { api: api2 } = fakeApi({ test: () => ({ ok: true, result: failed }) });
    const f = await runTest(api2, "a1");
    assert.ok(f.ok && f.result.status === "failed" && f.result.failure === "It could not read the pipeline.");
  });

  await check("flow: Turn on and Pause hand back the server's item, and the line about it follows the item's status", async () => {
    const { api } = fakeApi();
    const on = await activateAutomation(api, "a1");
    assert.ok(on.ok);
    if (on.ok) assert.equal(activatedLine(on.item), "It is on.");
    const stillPaused = itemFrom(draftOf("daily_brief", "chief_of_staff"), "paused");
    assert.equal(activatedLine(stillPaused), "The server did not turn it on: it is still paused.");
    assert.match(activatedLine({ ...stillPaused, status: "needs_attention" }), /needs attention/);
    assert.match(savedLine({ ...stillPaused, status: "on" }), /It is on/);
    assert.match(savedLine({ ...stillPaused, status: "needs_attention" }), /needs attention/);
  });

  await check("flow: the first loads return the server's data, or an error with the repair link", async () => {
    const { api } = fakeApi({ list: () => ({ ok: true, items: [itemFrom(draftOf("daily_brief", "chief_of_staff"))] }) });
    const ctx = await loadContext(api);
    assert.ok(ctx.kind === "ready" && ctx.data.departments.length === 6);
    const list = await loadList(api);
    assert.ok(list.kind === "ready" && list.data.length === 1);
    const repair = { label: "Open Settings", href: "/settings" };
    const { api: down } = fakeApi({ context: () => failure({ error: "forbidden", message: "You cannot build automations here.", repair }), list: () => failure({ error: "server_error", message: "" }) });
    const c = await loadContext(down);
    assert.deepEqual(c, { kind: "error", message: "You cannot build automations here.", repair });
    const l = await loadList(down);
    assert.equal(l.kind, "error");
    if (l.kind === "error") assert.equal(l.message, "Something went wrong on our side. Nothing was changed. Try again in a moment.");
  });

  await check("every ready-made job has its own Review sentence: none falls back to the generic 'Label: value' one", () => {
    for (const t of ALL_TEMPLATES.filter((x) => !x.custom)) {
      const s = reviewSentence(draftOf(t.id, t.department)) ?? "";
      assert.ok(!s.includes(": "), `${t.id} fell back to the generic sentence: ${s}`);
    }
  });

  console.log(failures ? `guided-automations-view: ${failures} failure(s)` : "guided-automations-view: all passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
