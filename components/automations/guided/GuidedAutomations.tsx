"use client";

/**
 * components/automations/guided/GuidedAutomations.tsx - the guided half of the Automations page:
 * the "New automation" wizard on top, "Your automations" under it.
 *
 * It reads the workspace facts and the saved list once when it opens (through the injected `GuidedApi`;
 * the page's is the browser client in lib/automations/guided/api-types.ts) and keeps the two in step: a
 * save, turn on or pause the wizard reports replaces that row in the list at once, and a finished test
 * reads the list again so the last run is current. Editing a saved automation re-opens the wizard on
 * Review with its values; "Build another" and "Stop editing" start it empty.
 *
 * `api` is optional because a Server Component cannot hand a function to a Client Component: the page
 * leaves it out and this component uses the browser client. Only the tests pass one.
 *
 * `children` are the automations made before this builder (the page passes its scheduled-jobs list). They
 * are listed inside "Your automations", under the builder's own rows, never folded away: CC, 2026-10-16,
 * "my automations aren't being displayed - the ones I previously built aren't showing up".
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { guidedApi, type GuidedApi, type GuidedAutomationView, type GuidedContextView } from "@/lib/automations/guided/api-types";
import { loadContext, loadList } from "@/lib/automations/guided/flow";
import { editSession, upsertItem, type LoadState } from "@/lib/automations/guided/view";
import { GuidedBuilder, type BuilderInitial } from "./GuidedBuilder";
import { GuidedAutomationsList, type RowInitial } from "./GuidedAutomationsList";
import { Notice, RepairAnchor, TAP } from "./ui";

export type GuidedAutomationsProps = {
  api?: GuidedApi;
  /** The clock for "next run in 3 hours". Left out, the browser's clock is read after the page loads. */
  nowMs?: number;
  /** Tests only: what the page has already loaded. Effects do not run in a static render, so any state can be drawn. */
  initialContext?: LoadState<GuidedContextView>;
  initialList?: LoadState<GuidedAutomationView[]>;
  initialBuilder?: BuilderInitial;
  initialRows?: Readonly<Record<string, RowInitial>>;
  /** The automations made another way, listed under "Your automations" after the builder's own rows. */
  children?: ReactNode;
};

type Session = { key: number; edit: GuidedAutomationView | null };

export function GuidedAutomations({ api = guidedApi, nowMs, initialContext, initialList, initialBuilder, initialRows, children }: GuidedAutomationsProps) {
  const [context, setContext] = useState<LoadState<GuidedContextView>>(initialContext ?? { kind: "loading" });
  const [list, setList] = useState<LoadState<GuidedAutomationView[]>>(initialList ?? { kind: "loading" });
  const [session, setSession] = useState<Session>({ key: 0, edit: null });
  const [rechecking, setRechecking] = useState(false);
  const [recheckNote, setRecheckNote] = useState<string | null>(null);
  const [clock, setClock] = useState<number | null>(nowMs ?? null);
  const builderTop = useRef<HTMLDivElement>(null);

  const loadWorkspace = useCallback(async () => {
    setContext({ kind: "loading" });
    setContext(await loadContext(api));
  }, [api]);

  /** A quiet reload keeps what is on screen if the read fails; a loud one shows the loading state first. */
  const loadItems = useCallback(
    async (quiet: boolean) => {
      if (!quiet) setList({ kind: "loading" });
      const next = await loadList(api);
      setList((prev) => (quiet && next.kind === "error" && prev.kind === "ready" ? prev : next));
    },
    [api],
  );

  useEffect(() => {
    void loadWorkspace();
    void loadItems(false);
  }, [loadWorkspace, loadItems]);

  useEffect(() => {
    if (nowMs === undefined) setClock(Date.now());
  }, [nowMs]);

  useEffect(() => {
    if (session.edit) builderTop.current?.scrollIntoView({ block: "start" });
  }, [session]);

  async function recheck() {
    setRechecking(true);
    setRecheckNote(null);
    const next = await loadContext(api);
    setRechecking(false);
    if (next.kind === "ready") setContext(next);
    else setRecheckNote(next.kind === "error" ? next.message : null);
  }

  const onItem = (item: GuidedAutomationView) => {
    // Merge into the list as it is NOW: two rows finishing close together each see the other's change.
    setList((prev) => (prev.kind === "ready" ? { kind: "ready", data: upsertItem(prev.data, item) } : prev));
    if (list.kind !== "ready") void loadItems(false);
  };

  const reset = () => setSession((s) => ({ key: s.key + 1, edit: null }));

  return (
    <div className="space-y-8">
      <div ref={builderTop} className="scroll-mt-4 space-y-3">
        {context.kind === "loading" && (
          <p role="status" className="rounded-xl border border-hairline bg-bg-panel p-5 text-sm text-fg-muted">
            Loading the builder...
          </p>
        )}
        {context.kind === "error" && (
          <div className="space-y-3 rounded-xl border border-hairline bg-bg-panel p-5">
            <h2 className="text-base font-semibold text-fg">New automation</h2>
            <p className="text-sm font-medium text-fg">The builder could not be opened.</p>
            <Notice tone="error">{context.message}</Notice>
            {context.repair && <RepairAnchor link={context.repair} />}
            <button type="button" className={`btn-secondary ${TAP}`} onClick={() => void loadWorkspace()}>
              Try again
            </button>
          </div>
        )}
        {context.kind === "ready" && (
          <>
            {recheckNote && <Notice tone="warn">{recheckNote}</Notice>}
            <GuidedBuilder
              key={session.key}
              api={api}
              context={context.data}
              onRecheck={() => void recheck()}
              rechecking={rechecking}
              onItem={onItem}
              onTested={() => void loadItems(true)}
              onReset={reset}
              editing={session.edit !== null}
              nowMs={nowMs}
              initial={session.edit ? editSession(session.edit, context.data) : session.key === 0 ? initialBuilder : undefined}
              focusOnMount={session.key > 0}
            />
          </>
        )}
      </div>

      <GuidedAutomationsList
        state={list}
        api={api}
        nowMs={clock}
        onEdit={(item) => setSession((s) => ({ key: s.key + 1, edit: item }))}
        onItem={onItem}
        onRemoved={(id) => setList((prev) => (prev.kind === "ready" ? { kind: "ready", data: prev.data.filter((x) => x.id !== id) } : prev))}
        onTested={() => void loadItems(true)}
        onRetry={() => void loadItems(false)}
        initialRows={initialRows}
        others={children}
      />
    </div>
  );
}
