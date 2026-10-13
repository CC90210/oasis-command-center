"use client";
/**
 * The Skills tab shell (JARVIS plan 3): the computer, its check-in status, Training and Library
 * tabs, the skill sheet, Ctrl K, and one toast line for queued edits (with Undo) and decisions.
 * SkillsTabView takes onRefresh so tests render it without the App Router; SkillsTab wires it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Search, Undo2, X } from "lucide-react";
import {
  changeFor, labelNames, recordsAgeLine, scopeFor, statusLine, toastFor, training,
  type Action, type ChangeRow, type Computer, type Hit, type Library, type Toast,
} from "@/lib/skills/view";
import { api, createPendingQueue } from "./actions";
import { CommandPalette } from "./CommandPalette";
import { LibraryView } from "./LibraryView";
import { SkillSheet, SkillSheetBody } from "./SkillSheet";
import { TrainingView } from "./TrainingView";
import { Btn, focusRing } from "./ui";

export type SkillsTabProps = {
  lib: Library; computer: Computer; computers: Computer[]; changes: ChangeRow[]; nowIso: string; initialView?: "training" | "library";
};

/**
 * Fix round 1 (review item c): a toast with no Undo (a decision, a sent edit, an error) had no
 * way to dismiss it except waiting - it also previously sat under an `aria-live="polite"` ANCESTOR
 * while carrying its OWN `role="status"`/`role="alert"`, two live-region mechanisms announcing the
 * same text. `role="status"` already implies `aria-live="polite"` and `role="alert"` already
 * implies `aria-live="assertive"`, so the toast element itself is the one live region; the
 * positioning wrapper in SkillsTabView carries no `aria-live` of its own any more.
 * Extracted (like CommandPalette's PaletteResults) so it is directly render-testable without
 * needing SkillsTabView's internal toast state, which no prop can seed from outside.
 */
export function ToastBanner({ toast, onUndo, onDismiss }: { toast: Toast; onUndo: () => void; onDismiss: () => void }) {
  if (!toast) return null;
  return (
    <div key={toast.key} role={toast.tone === "error" ? "alert" : "status"}
      className={`pointer-events-auto flex max-w-lg items-center gap-3 rounded-xl border bg-bg-elev px-4 py-2 text-sm shadow-elev ${toast.tone === "error" ? "border-status-hot/40 text-status-hot" : "border-hairline text-fg"}`}>
      <span>{toast.text}</span>
      {toast.undo ? (
        <Btn variant="ghost" className="px-3" onClick={onUndo}><Undo2 className="h-4 w-4" aria-hidden="true" />Undo</Btn>
      ) : (
        <Btn variant="ghost" aria-label="Dismiss" className="px-3" onClick={onDismiss}><X className="h-4 w-4" aria-hidden="true" /></Btn>
      )}
    </div>
  );
}

function MachinePills({ computers, current }: { computers: Computer[]; current: Computer }) {
  if (computers.length <= 1) {
    return (
      <span className="inline-flex min-h-8 items-center gap-2 rounded-full border border-hairline px-3 text-xs text-fg">
        <span className="h-1.5 w-1.5 rounded-full bg-status-engaged" aria-hidden="true" />{current.display_name}
      </span>
    );
  }
  return (
    <nav aria-label="Computers" className="flex flex-wrap gap-1">
      {computers.map((c) => (
        <Link key={c.id} href={`/playbook/skills?computer=${encodeURIComponent(c.id)}`} aria-current={c.id === current.id ? "page" : undefined}
          className={`inline-flex min-h-11 items-center rounded-full border px-3 text-xs ${c.id === current.id ? "border-accent/40 bg-accent-soft text-fg" : "border-hairline text-fg-muted hover:text-fg"} ${focusRing}`}>
          {c.display_name}
        </Link>
      ))}
    </nav>
  );
}

export function SkillsTabView({ lib, computer, computers, changes, nowIso, initialView = "training", onRefresh }: SkillsTabProps & { onRefresh: () => void }) {
  const [view, setView] = useState<"training" | "library">(initialView);
  const [group, setGroup] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;

  const queue = useMemo(() => createPendingQueue({
    send: async (c, keepalive) => { await api.queue(c, keepalive); },
    onState: (s) => { setToast(toastFor(s)); if (s.kind === "sent") refresh.current(); },
  }), []);

  useEffect(() => {
    const leave = () => queue.flush();
    window.addEventListener("pagehide", leave);
    return () => { window.removeEventListener("pagehide", leave); leave(); };
  }, [queue]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const now = new Date(nowIso);
  const status = statusLine(computer.last_checkin_at, now);
  // Task 4/7 ruling: this computer's test records can be older than its latest check-in (a
  // record kept on purpose past the night it last ran). Null whenever there is nothing stale to
  // say, so a same-day record never gains a caveat it does not need.
  const recordsAge = recordsAgeLine(lib.records_at, computer.last_checkin_at);
  const lists = training(changes, computer.id, now);
  const needsYou = lists.held.length + lists.failed.length;
  const names = useMemo(() => labelNames(lib), [lib]);

  const onAction = useCallback((a: Action) => {
    const ch = changeFor(a, names, scopeFor(computer));
    queue.add(ch.description, ch);
  }, [names, computer, queue]);
  // TrainingView and HeldChange call onDone after a decision (Reject / Edit / Accept anyway)
  // lands, or a rebuild request is sent. Refresh here too, not only on a queued edit going live
  // (s.kind === "sent" above) - otherwise a rejected or edited held row stays on screen stale.
  const onDone = useCallback((message: string) => { setToast({ key: `done:${message}`, tone: "ok", text: message, undo: false }); refresh.current(); }, []);
  const closeSheet = useCallback(() => setSheet(null), []);
  const closePalette = useCallback(() => setPalette(false), []);
  const onPick = useCallback((h: Hit) => {
    setView("library");
    if (h.kind === "skill") setSheet(h.name); else setGroup(h.id);
  }, []);
  const onRebuild = async () => {
    setRebuildBusy(true);
    try { await api.rebuild(computer.id); onDone("Asked. Your PC runs the check within 5 minutes."); }
    catch (e) { setToast({ key: `rebuild-error:${Date.now()}`, tone: "error", text: `Could not ask for a check: ${(e as Error).message}. Nothing changed.`, undo: false }); }
    finally { setRebuildBusy(false); }
  };

  const tabs = [{ id: "training" as const, label: "Training", count: needsYou }, { id: "library" as const, label: "Library", count: 0 }];
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = view === "training" ? "library" : "training";
    setView(next);
    document.getElementById(`skills-tab-${next}`)?.focus();
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center gap-3">
        <MachinePills computers={computers} current={computer} />
        <p className={`text-sm tabular-nums ${status.stale ? "text-status-warm" : "text-fg-muted"}`}>{status.text}</p>
        {recordsAge && <p className="text-xs tabular-nums text-fg-dim">{recordsAge}</p>}
        {/* Fix round 1 (review item d, WCAG 2.5.3 Label in Name): the control previously showed
            only an icon and the "Ctrl K" hint, with no visible text matching its accessible name
            ("Search skills and kinds of work") - a speech-input user saying "click Search" had
            nothing visible to match against. "Search" is now visible text, and the accessible
            name still starts with it. */}
        <Btn variant="ghost" className="ml-auto gap-2 px-3" aria-label="Search skills and kinds of work" aria-keyshortcuts="Control+K Meta+K" onClick={() => setPalette(true)}>
          <Search className="h-4 w-4" aria-hidden="true" />
          <span>Search</span>
          <kbd className="rounded border border-hairline px-1.5 font-sans text-[11px] text-fg-dim">Ctrl K</kbd>
        </Btn>
      </header>

      <div role="tablist" aria-label="Skills views" className="flex gap-1 border-b border-hairline">
        {tabs.map((t) => (
          <button key={t.id} id={`skills-tab-${t.id}`} type="button" role="tab" aria-selected={view === t.id} aria-controls="skills-panel"
            tabIndex={view === t.id ? 0 : -1} onKeyDown={onTabKey} onClick={() => setView(t.id)}
            className={`-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm font-medium ${view === t.id ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"} ${focusRing}`}>
            {t.label}
            {t.count > 0 && <span className="rounded-full bg-unread px-1.5 text-[11px] font-semibold tabular-nums text-white">{t.count}</span>}
          </button>
        ))}
      </div>

      <div id="skills-panel" role="tabpanel" aria-labelledby={`skills-tab-${view}`}>
        {view === "training" ? (
          <TrainingView lib={lib} computer={computer} changes={changes} nowIso={nowIso} rebuildBusy={rebuildBusy} onDone={onDone} onRebuild={onRebuild} />
        ) : (
          <LibraryView lib={lib} group={group} onGroup={setGroup} onOpenSkill={setSheet} />
        )}
      </div>

      {/* No aria-live here (fix round 1, item c): ToastBanner's own role carries the ONE live
          region (role="status" implies aria-live="polite"; role="alert" implies "assertive"). */}
      <div className="pointer-events-none fixed inset-x-4 bottom-4 z-40 flex justify-center">
        <ToastBanner toast={toast} onUndo={() => queue.undo()} onDismiss={() => setToast(null)} />
      </div>

      <SkillSheet open={sheet !== null} title={sheet ?? ""} onClose={closeSheet}>
        {/* Task 11 carry-list: keyed by skill name, so opening a different skill in an already-open
            sheet remounts the body's local state (the "Add to a group" select) instead of reusing it. */}
        {sheet && <SkillSheetBody key={sheet} lib={lib} name={sheet} onAction={onAction} />}
      </SkillSheet>
      <CommandPalette open={palette} lib={lib} onClose={closePalette} onPick={onPick} />
    </div>
  );
}

export function SkillsTab(props: SkillsTabProps) {
  const router = useRouter();
  return <SkillsTabView {...props} onRefresh={() => router.refresh()} />;
}
