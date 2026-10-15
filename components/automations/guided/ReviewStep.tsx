/**
 * components/automations/guided/ReviewStep.tsx - the last step: what will happen, what it needs, then Save,
 * Test now and Turn on.
 *
 * The three buttons are the whole safety story, so each says why it is unavailable, in a sentence, and
 * exactly one of them is the primary action at any time. Success lines are built from what the server
 * returned (flow.ts savedLine and activatedLine), never from a request having been made.
 */
import type { ReactNode } from "react";
import type { CloudState, GuidedAutomationView, TestResult } from "@/lib/automations/guided/api-types";
import { activatedLine, savedLine, type Failure } from "@/lib/automations/guided/flow";
import type { GuidedTemplate } from "@/lib/automations/guided/types";
import type { ConnectionRow, Draft, ReviewActions } from "@/lib/automations/guided/view";
import { Check, ConnectionMark, Field, Notice, RepairAnchor, TAP } from "./ui";
import { FailureView, TestResultView } from "./TestResultView";

export type ReviewProps = {
  draft: Draft;
  template: GuidedTemplate | null;
  sentence: string | null;
  nameError: string | null;
  onName: (value: string) => void;
  onNameBlur: () => void;
  actions: ReviewActions;
  /** A save, test, turn on or pause is in flight. */
  busy: boolean;
  savedItem: GuidedAutomationView | null;
  dirty: boolean;
  saveFailure: Failure | null;
  testBusy: boolean;
  /** Only a result that belongs to exactly what is saved. */
  testResult: TestResult | null;
  testFailure: Failure | null;
  expectsDrafts: boolean;
  activationFailure: Failure | null;
  /** The status line after a Turn on the server answered. */
  activationItem: GuidedAutomationView | null;
  nextRunText: string | null;
  skipTest: boolean;
  showSkip: boolean;
  onSkip: (value: boolean) => void;
  blockedApps: readonly ConnectionRow[];
  /** Every app this job needs, connected or not. */
  neededApps: readonly ConnectionRow[];
  cloud: CloudState;
  /** Read the connections and the AI account again (the person fixed one in another tab). */
  onRecheck: () => void;
  rechecking: boolean;
  onSave: () => void;
  onTest: () => void;
  onActivate: () => void;
  onPause: () => void;
  onReset: () => void;
};

function Action({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden="true" className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-hairline bg-bg-deep text-xs font-semibold tabular-nums text-fg-muted">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <h5 className="text-sm font-semibold text-fg">{title}</h5>
        {children}
      </div>
    </li>
  );
}

function Why({ id, text }: { id: string; text: string | null }) {
  return text ? (
    <p id={id} className="text-xs leading-5 text-fg-dim">
      {text}
    </p>
  ) : null;
}

export function ReviewStep(p: ReviewProps) {
  const { actions } = p;
  const btn = (key: "save" | "test" | "activate") =>
    `${actions.primary === key ? "btn-primary" : "btn-secondary"} ${TAP} disabled:cursor-not-allowed disabled:opacity-50`;
  const isOn = p.savedItem?.status === "on" && !p.dirty;
  const allReady = p.cloud.ready && p.blockedApps.length === 0;
  return (
    <div className="space-y-6">
      <Field id="gb-name" label="Name" help="How it appears in your list." error={p.nameError}>
        {(describedBy) => (
          <input
            id="gb-name"
            type="text"
            autoComplete="off"
            value={p.draft.name}
            aria-describedby={describedBy}
            aria-invalid={p.nameError ? true : undefined}
            onChange={(e) => p.onName(e.target.value)}
            onBlur={p.onNameBlur}
            className={`input ${TAP} ${p.nameError ? "border-status-hot" : ""}`}
          />
        )}
      </Field>

      <section aria-labelledby="gb-happen-h" className="space-y-2 rounded-xl border border-hairline bg-bg-deep p-4">
        <h4 id="gb-happen-h" className="text-sm font-semibold text-fg">
          What will happen
        </h4>
        {p.sentence ? (
          <p className="text-base leading-relaxed text-fg">{p.sentence}</p>
        ) : (
          <p className="text-sm text-fg-muted">Finish the earlier steps and this will say exactly what the automation does.</p>
        )}
        {p.template && <p className="text-sm leading-relaxed text-fg-muted">{p.template.never}</p>}
      </section>

      <section aria-labelledby="gb-needs-h" className="space-y-3">
        <h4 id="gb-needs-h" className="text-sm font-semibold text-fg">
          Before it can run
        </h4>
        <ul className="divide-y divide-hairline rounded-xl border border-hairline bg-bg-panel">
          <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-semibold text-fg">Your AI account</p>
              {p.cloud.ready ? (
                <ConnectionMark state="connected" label="Ready" />
              ) : (
                <>
                  <ConnectionMark state="not_connected" label="Not ready" />
                  {p.cloud.reason && <p className="text-xs text-fg-muted">{p.cloud.reason}</p>}
                </>
              )}
            </div>
            {!p.cloud.ready && p.cloud.repair && <RepairAnchor link={p.cloud.repair} />}
          </li>
          {p.neededApps.map((r) => (
            <li key={r.slug} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-semibold text-fg">{r.label}</p>
                <ConnectionMark state={r.state} label={r.stateLabel} />
              </div>
              {r.repair ? (
                <RepairAnchor link={r.repair} />
              ) : r.state !== "connected" ? (
                <p className="text-xs text-fg-muted">Connect it from Settings, under Connections.</p>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="text-sm text-fg-muted">
          {allReady
            ? "Everything it needs is ready. It runs on OASIS's servers, so your computer can be off."
            : "You can save it now and connect what is missing later. It can only be turned on once everything above is ready."}
        </p>
        {!allReady && (
          <button type="button" className={`btn-secondary ${TAP} disabled:cursor-not-allowed disabled:opacity-50`} onClick={p.onRecheck} disabled={p.rechecking}>
            {p.rechecking ? "Checking..." : "I fixed it, check again"}
          </button>
        )}
      </section>

      <section aria-labelledby="gb-actions-h" className="space-y-4">
        <h4 id="gb-actions-h" className="text-sm font-semibold text-fg">
          Save, test, then turn on
        </h4>
        <ol className="space-y-6">
          <Action n={1} title="Save">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <button type="button" className={btn("save")} disabled={!actions.save.enabled} onClick={p.onSave} aria-describedby={actions.save.why ? "gb-save-why" : undefined}>
                {actions.save.label}
              </button>
              <Why id="gb-save-why" text={actions.save.why} />
            </div>
            <div aria-live="polite">
              {p.savedItem && !p.dirty && (
                <p className="inline-flex items-start gap-1.5 text-sm text-status-engaged">
                  <Check className="mt-1 h-3.5 w-3.5 shrink-0" />
                  <span>{savedLine(p.savedItem)}</span>
                </p>
              )}
              {p.savedItem && p.dirty && <p className="text-sm text-fg-muted">You have changes that are not saved yet.</p>}
            </div>
            {p.saveFailure && <FailureView failure={p.saveFailure} />}
          </Action>

          <Action n={2} title="Test now">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <button type="button" className={btn("test")} disabled={!actions.test.enabled} onClick={p.onTest} aria-describedby={actions.test.why ? "gb-test-why" : undefined}>
                {actions.test.label}
              </button>
              <Why id="gb-test-why" text={actions.test.why} />
            </div>
            <div aria-live="polite">{p.testBusy && <p className="text-sm text-fg-muted">Running a preview. It reads your workspace and writes the result here.</p>}</div>
            {p.testResult && <TestResultView result={p.testResult} expectsDrafts={p.expectsDrafts} />}
            {p.testFailure && <FailureView failure={p.testFailure} />}
          </Action>

          <Action n={3} title="Turn on">
            {isOn ? (
              <div className="space-y-2">
                <Notice tone="ok">
                  It is on.{p.nextRunText ? ` ${p.nextRunText}` : ""}
                </Notice>
                <button type="button" className={`btn-secondary ${TAP} disabled:cursor-not-allowed disabled:opacity-50`} onClick={p.onPause} disabled={p.busy}>
                  Pause it
                </button>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <button type="button" className={btn("activate")} disabled={!actions.activate.enabled} onClick={p.onActivate} aria-describedby={actions.activate.why ? "gb-activate-why" : undefined}>
                    {actions.activate.label}
                  </button>
                  <Why id="gb-activate-why" text={actions.activate.why} />
                </div>
                {p.showSkip && (
                  <label className={`flex ${TAP} cursor-pointer items-center gap-3 text-sm text-fg`}>
                    <input type="checkbox" checked={p.skipTest} onChange={(e) => p.onSkip(e.target.checked)} className="h-4 w-4 shrink-0 accent-accent" />
                    <span>Turn it on without testing it first.</span>
                  </label>
                )}
              </>
            )}
            <div aria-live="polite">
              {/* "It is on." is the green notice above; this line speaks only when the server answered with something else. */}
              {p.activationItem && p.activationItem.status !== "on" && <p className="text-sm text-status-warm">{activatedLine(p.activationItem)}</p>}
            </div>
            {p.activationFailure && <FailureView failure={p.activationFailure} />}
          </Action>
        </ol>
      </section>

      {p.savedItem && (
        <div>
          <p className="mb-3 text-sm text-fg-muted">It is in Your automations below. You can come back to it any time.</p>
          <button type="button" className={`btn-secondary ${TAP}`} onClick={p.onReset}>
            Build another automation
          </button>
        </div>
      )}
    </div>
  );
}
