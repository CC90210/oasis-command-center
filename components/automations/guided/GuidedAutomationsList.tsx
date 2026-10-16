"use client";

/**
 * components/automations/guided/GuidedAutomationsList.tsx - "Your automations".
 *
 * One card per saved guided automation: its name, department and job, a status in words (Paused, On or
 * Needs attention), when it runs, when it runs next, how the last run went and anything that needs
 * fixing, with the actions a person needs: Edit, Test now, Turn on or Pause, Delete. Delete asks
 * inline (this viewer blocks confirm()). Loading, "could not load" and "nothing yet" each say so.
 *
 * Every line about a run or a status is the server's: this component states nothing it was not told.
 *
 * `others` (the page's scheduled-jobs list: automations made before this builder) is listed in the same
 * section, after these rows. With it present the section never says "nothing yet" and shows no count of
 * its own: the older list carries its own counts, and claiming an empty list above real automations is
 * exactly what hid CC's on 2026-10-16.
 */
import { useRef, useState, type ReactNode } from "react";
import type { GuidedApi, GuidedAutomationView, TestResult } from "@/lib/automations/guided/api-types";
import { activateAutomation, activatedLine, pauseAutomation, removeAutomation, runTest, type Failure } from "@/lib/automations/guided/flow";
import { departmentLabel, lastRunHead, nextRunLine, type LoadState } from "@/lib/automations/guided/view";
import { RunHistory } from "./RunHistory";
import { FailureView, TestResultView } from "./TestResultView";
import { Notice, RepairAnchor, StatusPill, TAP } from "./ui";

type Busy = "test" | "activate" | "pause" | "remove" | null;
export type RowNote = { kind: "test"; result: TestResult } | { kind: "failure"; failure: Failure } | { kind: "text"; text: string };

/** Where a row starts: only the tests set it, to draw a row mid-delete or after a test. */
export type RowInitial = { confirmDelete?: boolean; note?: RowNote | null };

export type GuidedAutomationsListProps = {
  state: LoadState<GuidedAutomationView[]>;
  api: GuidedApi;
  /** The clock for "in 3 hours"; null until the browser has one, and the lines then show the time alone. */
  nowMs: number | null;
  onEdit: (item: GuidedAutomationView) => void;
  /** The server returned this automation after a turn on or pause: replace it in the list. */
  onItem: (item: GuidedAutomationView) => void;
  onRemoved: (id: string) => void;
  /** A test finished: read the list again so the last run is current. */
  onTested: () => void;
  onRetry: () => void;
  initialRows?: Readonly<Record<string, RowInitial>>;
  /** Automations made another way, listed in this section after the builder's rows. */
  others?: ReactNode;
};

const BUTTON = `btn-secondary ${TAP} disabled:cursor-not-allowed disabled:opacity-50`;

export function GuidedAutomationsList({ state, api, nowMs, onEdit, onItem, onRemoved, onTested, onRetry, initialRows, others }: GuidedAutomationsListProps) {
  const hasOthers = others !== undefined && others !== null && others !== false;
  const count = state.kind === "ready" && !hasOthers ? state.data.length : null;
  return (
    <section aria-labelledby="guided-list-h" aria-busy={state.kind === "loading"} className="space-y-3">
      <h2 id="guided-list-h" className="text-base font-semibold text-fg">
        Your automations
        {count !== null && count > 0 && <span className="ml-2 text-sm font-normal text-fg-dim">{count}</span>}
      </h2>

      {state.kind === "loading" && (
        <p role="status" className="rounded-xl border border-hairline bg-bg-panel p-5 text-sm text-fg-muted">
          Loading your automations...
        </p>
      )}

      {state.kind === "error" && (
        <div className="space-y-3 rounded-xl border border-hairline bg-bg-panel p-5">
          <p className="text-sm font-medium text-fg">Your automations could not be loaded.</p>
          <Notice tone="error">{state.message}</Notice>
          {state.repair && <RepairAnchor link={state.repair} />}
          <button type="button" className={BUTTON} onClick={onRetry}>
            Try again
          </button>
        </div>
      )}

      {state.kind === "ready" && state.data.length === 0 && !hasOthers && (
        <div className="rounded-xl border border-dashed border-bg-border-strong p-5">
          <p className="max-w-prose text-sm leading-relaxed text-fg-muted">Automations you save show up here with their next run and last result, so build your first one above.</p>
        </div>
      )}

      {state.kind === "ready" && state.data.length > 0 && (
        <ul className="space-y-3">
          {state.data.map((item) => (
            <Row key={item.id} item={item} api={api} nowMs={nowMs} onEdit={onEdit} onItem={onItem} onRemoved={onRemoved} onTested={onTested} initial={initialRows?.[item.id]} />
          ))}
        </ul>
      )}

      {hasOthers && <div data-testid="automations-made-before">{others}</div>}
    </section>
  );
}

function Row({
  item,
  api,
  nowMs,
  onEdit,
  onItem,
  onRemoved,
  onTested,
  initial,
}: {
  item: GuidedAutomationView;
  api: GuidedApi;
  nowMs: number | null;
  onEdit: (item: GuidedAutomationView) => void;
  onItem: (item: GuidedAutomationView) => void;
  onRemoved: (id: string) => void;
  onTested: () => void;
  initial?: RowInitial;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmDelete, setConfirmDelete] = useState(initial?.confirmDelete ?? false);
  const [note, setNote] = useState<RowNote | null>(initial?.note ?? null);
  const working = useRef(false);
  const idle = busy === null;

  /** One call at a time: a second press before the row has redrawn does nothing. */
  async function once(kind: Exclude<Busy, null>, run: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(kind);
    setNote(null);
    try {
      await run();
    } finally {
      setBusy(null);
      working.current = false;
    }
  }

  const test = () =>
    once("test", async () => {
      const out = await runTest(api, item.id);
      if (out.ok) {
        setNote({ kind: "test", result: out.result });
        onTested();
      } else setNote({ kind: "failure", failure: out.failure });
    });

  const turnOn = () =>
    once("activate", async () => {
      const out = await activateAutomation(api, item.id);
      if (!out.ok) return setNote({ kind: "failure", failure: out.failure });
      onItem(out.item);
      setNote({ kind: "text", text: activatedLine(out.item) });
    });

  const pause = () =>
    once("pause", async () => {
      const out = await pauseAutomation(api, item.id);
      if (!out.ok) return setNote({ kind: "failure", failure: out.failure });
      onItem(out.item);
      setNote({ kind: "text", text: out.item.status === "paused" ? "Paused. It will not run until you turn it on." : "The server did not pause it. Check its status above." });
    });

  const remove = () =>
    once("remove", async () => {
      const out = await removeAutomation(api, item.id);
      setConfirmDelete(false);
      if (out.ok) onRemoved(item.id);
      else setNote({ kind: "failure", failure: out.failure });
    });

  const run = item.lastRun;
  return (
    <li className="rounded-xl border border-hairline bg-bg-panel p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="break-words text-base font-semibold text-fg">{item.name}</h3>
          <p className="text-sm text-fg-muted">
            {departmentLabel(item.department)}: {item.templateTitle}
          </p>
        </div>
        <StatusPill status={item.status} />
      </div>

      <div className="mt-3 space-y-1 text-sm">
        <p className="text-fg">{item.scheduleSentence}</p>
        <p className="text-fg-muted">{nextRunLine(item, nowMs)}</p>
        <p className="text-fg-muted">
          <span className="font-medium text-fg">Last run:</span>{" "}
          {run ? (
            <>
              {lastRunHead(run, nowMs)}. {run.summary}
              {run.preview && <span className="ml-2 inline-flex rounded border border-hairline bg-bg-elev px-1.5 py-0.5 text-xs font-medium text-fg-muted">Preview</span>}
            </>
          ) : (
            "It has not run yet."
          )}
        </p>
      </div>

      {item.problems.length > 0 && (
        <div className="mt-3 space-y-1 rounded-lg border border-status-warm/40 bg-status-warm/10 p-3">
          <p className="text-sm font-medium text-fg">What needs fixing</p>
          <ul className="space-y-0.5">
            {item.problems.map((p, i) => (
              <li key={`${p.code}-${i}`} className="text-sm text-fg-muted">
                {p.message}
                {p.repair && (
                  <>
                    {" "}
                    <RepairAnchor link={p.repair} />
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!item.mine && <p className="mt-3 text-sm text-fg-muted">A teammate made this one. Only they can change, test, turn on or delete it. You can pause it.</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
        {item.mine && (
          <>
            <button type="button" className={BUTTON} disabled={!idle} onClick={() => onEdit(item)} aria-label={`Edit ${item.name}`}>
              Edit
            </button>
            <button type="button" className={BUTTON} disabled={!idle} onClick={() => void test()} aria-label={`Test now: ${item.name}`}>
              {busy === "test" ? "Testing..." : "Test now"}
            </button>
          </>
        )}
        {item.mine && item.status !== "on" && (
          <button type="button" className={BUTTON} disabled={!idle} onClick={() => void turnOn()} aria-label={`Turn on: ${item.name}`}>
            {busy === "activate" ? "Turning on..." : "Turn on"}
          </button>
        )}
        {item.status !== "paused" && (
          <button type="button" className={BUTTON} disabled={!idle} onClick={() => void pause()} aria-label={`Pause: ${item.name}`}>
            {busy === "pause" ? "Pausing..." : "Pause"}
          </button>
        )}
        {!item.mine ? null : confirmDelete ? (
          <span role="group" aria-label={`Delete ${item.name}?`} className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <span className="text-sm text-fg">Delete this automation?</span>
            <button type="button" className={`btn-danger ${TAP} px-4 disabled:cursor-not-allowed disabled:opacity-50`} disabled={!idle} onClick={() => void remove()}>
              {busy === "remove" ? "Deleting..." : "Yes, delete"}
            </button>
            <button type="button" className={BUTTON} disabled={!idle} onClick={() => setConfirmDelete(false)}>
              No, keep it
            </button>
          </span>
        ) : (
          <button type="button" className={`${BUTTON} sm:ml-auto`} disabled={!idle} onClick={() => setConfirmDelete(true)} aria-label={`Delete: ${item.name}`}>
            Delete
          </button>
        )}
      </div>

      <div aria-live="polite" className="empty:hidden">
        {note?.kind === "text" && <p className="mt-3 text-sm text-fg-muted">{note.text}</p>}
        {busy === "test" && <p className="mt-3 text-sm text-fg-muted">Running a preview. It reads your workspace and writes the result here.</p>}
      </div>
      {note?.kind === "failure" && (
        <div className="mt-3">
          <FailureView failure={note.failure} />
        </div>
      )}
      {note?.kind === "test" && (
        <div className="mt-3 border-t border-hairline pt-3">
          <TestResultView result={note.result} expectsDrafts={item.payload.output === "email_drafts"} />
        </div>
      )}
      <RunHistory api={api} automationId={item.id} refreshKey={item.lastRun?.receiptId ?? ""} />
    </li>
  );
}
