"use client";

/**
 * components/automations/guided/GuidedBuilder.tsx - the four-step "New automation" wizard.
 *
 * Area, Job (a ready-made job with an example of what it hands back, and its few details), When (how
 * often, what time, which days or how many times a day), and Turn on (what it needs, then Save, Test
 * now and Turn on). A person can
 * only move on when the step is complete (lib/automations/guided/view.ts gateFor), and the reason Next
 * is waiting is said beside it. Review holds the three real actions: Save (always paused), Test now (a
 * preview) and Turn on (explicit). The wizard takes its `GuidedApi` as a prop, so it never touches
 * fetch itself and the tests drive it with a fake.
 *
 * State that matters is derived, not remembered: "changed since the last save" compares the validated
 * payload with the snapshot taken at the save, and a test counts only while it matches that snapshot,
 * so an edit after a test can never be turned on as if it had been tested.
 */
import { useEffect, useRef, useState } from "react";
import type { GuidedApi, GuidedAutomationView, GuidedContextView, TestResult } from "@/lib/automations/guided/api-types";
import { activateAutomation, pauseAutomation, runTest, saveAutomation, type Failure } from "@/lib/automations/guided/flow";
import {
  STEPS,
  canVisit,
  connectionRows,
  draftTemplate,
  emptyDraft,
  gateFor,
  nameProblem,
  nextRunLine,
  requiredSlugs,
  reviewActions,
  reviewSentence,
  setName,
  snapshotOf,
  stepAfter,
  stepBefore,
  stepIndex,
  validateDraft,
  type Draft,
  type StepId,
} from "@/lib/automations/guided/view";
import { DepartmentStep, JobStep, WhenStep } from "./steps";
import { ReviewStep } from "./ReviewStep";
import { SummaryRail } from "./SummaryRail";
import { Check, Notice, TAP } from "./ui";

/** Where the wizard starts. Used to open a saved automation for editing, and by the tests to draw any state. */
export type BuilderInitial = {
  draft?: Draft;
  step?: StepId;
  saved?: { item: GuidedAutomationView; snapshot: string } | null;
  note?: string | null;
  touched?: readonly string[];
  test?: { result: TestResult | null; failure: Failure | null; forSnapshot: string | null };
  saveFailure?: Failure | null;
  activation?: { failure: Failure | null; item: GuidedAutomationView | null };
  skipTest?: boolean;
};

export type GuidedBuilderProps = {
  api: GuidedApi;
  context: GuidedContextView;
  /** Read the connections again (the person fixed one in another tab). */
  onRecheck: () => void;
  rechecking: boolean;
  /** An automation the server returned after a save, turn on or pause: the list should show it. */
  onItem: (item: GuidedAutomationView) => void;
  /** A test finished: the list's last run is out of date. */
  onTested: () => void;
  /** Start over with an empty wizard. */
  onReset: () => void;
  editing?: boolean;
  /** The clock for "next run in 3 hours"; the page leaves it out and the browser's is used. */
  nowMs?: number;
  initial?: BuilderInitial;
  /** Move focus to the step heading when it first appears (editing a saved automation, or starting over), so a keyboard user is not left on a button that is gone. */
  focusOnMount?: boolean;
};

type Busy = "save" | "test" | "activate" | "pause" | null;

export function GuidedBuilder({ api, context: ctx, onRecheck, rechecking, onItem, onTested, onReset, editing = false, nowMs, initial, focusOnMount = false }: GuidedBuilderProps) {
  const [draft, setDraft] = useState<Draft>(() => initial?.draft ?? emptyDraft());
  const [step, setStep] = useState<StepId>(() => initial?.step ?? "department");
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set(initial?.touched ?? []));
  const [saved, setSaved] = useState<{ item: GuidedAutomationView; snapshot: string } | null>(() => initial?.saved ?? null);
  const [busy, setBusy] = useState<Busy>(null);
  const [saveFailure, setSaveFailure] = useState<Failure | null>(() => initial?.saveFailure ?? null);
  const [test, setTest] = useState(() => initial?.test ?? { result: null, failure: null, forSnapshot: null });
  const [activation, setActivation] = useState(() => initial?.activation ?? { failure: null, item: null });
  // The confirmation to skip a test belongs to exactly one saved version.
  const [skipFor, setSkipFor] = useState<string | null>(() => (initial?.skipTest && initial.saved ? initial.saved.snapshot : null));

  const headingRef = useRef<HTMLHeadingElement>(null);
  const working = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      if (!focusOnMount) return;
    }
    headingRef.current?.focus();
  }, [step, focusOnMount]);

  const touch = (field: string) => setTouched((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));
  const update = (next: Draft) => {
    // A different department or job starts that part over, so an old error does not follow it.
    if (next.department !== draft.department || next.templateId !== draft.templateId) setTouched(new Set());
    setDraft(next);
  };

  // ── what is true right now ──
  const validation = validateDraft(draft, ctx);
  const currentSnapshot = validation.ok ? snapshotOf(draft.name, validation.payload) : null;
  const dirty = saved !== null && currentSnapshot !== saved.snapshot;
  const template = draftTemplate(draft);
  const nameMessage = nameProblem(draft.name);
  // What the builder could not carry over from a saved automation is said until the person has put it right.
  const showNote = Boolean(initial?.note) && (template === null || draft.schedule === null);
  const matchesSaved = saved !== null && !dirty && test.forSnapshot === saved.snapshot;
  const testResult = matchesSaved ? test.result : null;
  const testPassed = testResult?.status === "done";
  const skipTest = saved !== null && !dirty && skipFor === saved.snapshot;
  const rows = connectionRows(requiredSlugs(draft), ctx.connections);
  const blockedApps = rows.filter((r) => r.blocksTurnOn);
  const actions = reviewActions({
    valid: validation.ok,
    validMessage: validation.ok ? null : validation.message,
    nameOk: nameMessage === null,
    saved: saved !== null,
    dirty,
    testPassed,
    skipTest,
    status: saved?.item.status ?? null,
    cloudReady: ctx.cloud.ready,
    cloudReason: ctx.cloud.reason,
    missingApps: blockedApps.map((r) => r.label),
    busy,
  });

  // ── actions ──
  /** One call at a time: a second press before the screen has redrawn does nothing. */
  async function once(run: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    try {
      await run();
    } finally {
      working.current = false;
    }
  }

  const save = () =>
    once(async () => {
      if (!actions.save.enabled) return;
      setBusy("save");
      setSaveFailure(null);
      const out = await saveAutomation(api, draft, ctx, saved?.item.id ?? null);
      setBusy(null);
      if (!out.ok) {
        setSaveFailure(out.failure);
        return;
      }
      setSaved({ item: out.item, snapshot: out.snapshot });
      setActivation({ failure: null, item: null });
      onItem(out.item);
    });

  const runPreview = () =>
    once(async () => {
      if (!saved || !actions.test.enabled) return;
      const forSnapshot = saved.snapshot;
      setBusy("test");
      setTest({ result: null, failure: null, forSnapshot });
      const out = await runTest(api, saved.item.id);
      setBusy(null);
      if (out.ok) {
        setTest({ result: out.result, failure: null, forSnapshot });
        onTested();
      } else {
        setTest({ result: null, failure: out.failure, forSnapshot });
      }
    });

  const turnOn = () =>
    once(async () => {
      if (!saved || !actions.activate.enabled) return;
      setBusy("activate");
      setActivation({ failure: null, item: null });
      const out = await activateAutomation(api, saved.item.id);
      setBusy(null);
      if (!out.ok) {
        setActivation({ failure: out.failure, item: null });
        return;
      }
      setSaved((s) => (s ? { item: out.item, snapshot: s.snapshot } : s));
      setActivation({ failure: null, item: out.item });
      onItem(out.item);
    });

  const pause = () =>
    once(async () => {
      if (!saved) return;
      setBusy("pause");
      setActivation({ failure: null, item: null });
      const out = await pauseAutomation(api, saved.item.id);
      setBusy(null);
      if (!out.ok) {
        setActivation({ failure: out.failure, item: null });
        return;
      }
      setSaved((s) => (s ? { item: out.item, snapshot: s.snapshot } : s));
      onItem(out.item);
    });

  // ── navigation ──
  const index = Math.max(0, stepIndex(step));
  const gate = gateFor(step, draft, ctx);
  const current = STEPS[index];
  const next = STEPS[Math.min(index + 1, STEPS.length - 1)];
  const goNext = () => {
    if (gate.open) setStep(stepAfter(step));
  };
  const clock = nowMs ?? Date.now();

  return (
    <section aria-labelledby="guided-builder-h" className="rounded-xl border border-hairline bg-bg-panel">
      <header className="space-y-3 border-b border-hairline px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h2 id="guided-builder-h" className="text-base font-semibold text-fg">
              {editing ? "Edit automation" : "New automation"}
            </h2>
            <p className="mt-1 max-w-prose text-sm leading-relaxed text-fg-muted">
              Pick a job, say when it should run, and try it once before you turn it on. It writes you a summary or drafts emails for you to approve. Nothing is sent without you.
            </p>
          </div>
          {editing && (
            <button type="button" className={`btn-secondary ${TAP}`} onClick={onReset}>
              Stop editing
            </button>
          )}
        </div>
        <nav aria-label="Steps">
          <ol className="flex flex-wrap gap-x-1 gap-y-1 sm:gap-x-4">
            {STEPS.map((s, i) => {
              const isCurrent = s.id === step;
              const reachable = canVisit(s.id, draft, ctx);
              const done = i < index && reachable;
              const marker = (
                <span
                  aria-hidden="true"
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-xs font-semibold tabular-nums ${
                    isCurrent ? "border-fg bg-fg text-bg" : done ? "border-fg-dim text-fg" : "border-hairline text-fg-dim"
                  }`}
                >
                  {done ? <Check /> : i + 1}
                </span>
              );
              const label = <span className={`text-sm ${isCurrent ? "font-semibold text-fg" : done ? "text-fg" : "text-fg-dim"} ${isCurrent ? "" : "hidden sm:inline"}`}>{s.label}</span>;
              return (
                <li key={s.id} aria-current={isCurrent ? "step" : undefined}>
                  {reachable && !isCurrent ? (
                    <button
                      type="button"
                      onClick={() => setStep(s.id)}
                      aria-label={`Step ${i + 1}: ${s.label}${done ? ", done" : ""}`}
                      className={`flex ${TAP} min-w-11 items-center gap-2 rounded-md px-1 hover:bg-active motion-safe:transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
                    >
                      {marker}
                      {label}
                    </button>
                  ) : (
                    <span className={`flex ${TAP} min-w-11 items-center gap-2 px-1`}>
                      {marker}
                      {label}
                      {isCurrent && <span className="sr-only"> (current step)</span>}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="text-xs text-fg-dim sm:hidden">
            Step {index + 1} of {STEPS.length}: {current.label}
          </p>
        </nav>
      </header>

      <div className="grid gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-8">
        <div className="order-2 min-w-0 space-y-5 lg:order-1">
          <div className="space-y-1">
            <h3 ref={headingRef} tabIndex={-1} className="text-lg font-semibold tracking-tight text-fg focus:outline-none">
              {current.title}
            </h3>
            <p className="max-w-prose text-sm leading-relaxed text-fg-muted">{current.lead}</p>
          </div>
          {showNote && <Notice tone="warn">{initial?.note}</Notice>}

          {step === "department" && <DepartmentStep draft={draft} ctx={ctx} update={update} />}
          {step === "job" && <JobStep draft={draft} ctx={ctx} validation={validation} touched={touched} touch={touch} update={update} />}
          {step === "when" && <WhenStep draft={draft} validation={validation} touched={touched} touch={touch} update={update} now={new Date(clock)} />}
          {step === "review" && (
            <ReviewStep
              draft={draft}
              template={template}
              sentence={reviewSentence(draft)}
              nameError={touched.has("name") ? nameMessage : null}
              onName={(value) => {
                touch("name");
                setDraft(setName(draft, value));
              }}
              onNameBlur={() => touch("name")}
              actions={actions}
              busy={busy !== null}
              savedItem={saved?.item ?? null}
              dirty={dirty}
              saveFailure={saveFailure}
              testBusy={busy === "test"}
              testResult={testResult}
              testFailure={matchesSaved ? test.failure : null}
              expectsDrafts={saved?.item.payload.output === "email_drafts"}
              activationFailure={activation.failure}
              activationItem={activation.item}
              nextRunText={saved ? nextRunLine(saved.item, clock) : null}
              skipTest={skipTest}
              showSkip={saved !== null && !dirty && !testPassed}
              onSkip={(on) => setSkipFor(on && saved ? saved.snapshot : null)}
              blockedApps={blockedApps}
              neededApps={rows}
              cloud={ctx.cloud}
              onRecheck={onRecheck}
              rechecking={rechecking}
              onSave={() => void save()}
              onTest={() => void runPreview()}
              onActivate={() => void turnOn()}
              onPause={() => void pause()}
              onReset={onReset}
            />
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-hairline pt-4">
            {step !== "department" && (
              <button type="button" className={`btn-secondary ${TAP}`} onClick={() => setStep(stepBefore(step))}>
                Back
              </button>
            )}
            {step !== "review" && (
              <button
                type="button"
                className={`btn-primary ${TAP} disabled:cursor-not-allowed disabled:opacity-50`}
                disabled={!gate.open}
                onClick={goNext}
                aria-describedby={gate.blocker ? "gb-next-why" : undefined}
              >
                Next: {next.label}
              </button>
            )}
            {step !== "review" && gate.blocker && (
              <p id="gb-next-why" className="text-xs leading-5 text-fg-dim">
                {gate.blocker}
              </p>
            )}
          </div>
        </div>

        <div className="order-1 min-w-0 lg:order-2">
          <SummaryRail draft={draft} />
        </div>
      </div>
    </section>
  );
}
