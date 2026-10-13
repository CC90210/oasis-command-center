"use client";
/**
 * The skill sheet (JARVIS plan 3): a native modal dialog. Under 1024px it is a bottom sheet you
 * can drag down to close; from 1024px it is a right-hand side panel. Esc, the close button and a
 * backdrop click close it, and focus returns to whatever opened it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { groupsOf, labelNames, type Action, type Library } from "@/lib/skills/view";
import { Btn, focusRing, RankTag, Squares } from "./ui";

export function SkillSheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const start = useRef<number | null>(null);
  const [dy, setDy] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement as HTMLElement | null;
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const closed = () => {
      setDy(0);
      onClose();
      opener.current?.focus();
    };
    d.addEventListener("close", closed);
    return () => d.removeEventListener("close", closed);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="skill-sheet-title"
      onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}
      className="m-0 h-full max-h-none w-full max-w-none bg-transparent p-0 backdrop:bg-black/60"
    >
      <div
        className="fixed inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl border border-hairline bg-bg-raised text-fg shadow-elev motion-safe:transition-transform motion-safe:duration-150 lg:inset-y-0 lg:left-auto lg:right-0 lg:max-h-none lg:w-[440px] lg:rounded-none lg:rounded-l-2xl"
        style={dy ? { transform: `translateY(${dy}px)` } : undefined}
      >
        <div
          className="flex cursor-grab justify-center pb-1 pt-2 lg:hidden"
          style={{ touchAction: "none" }}
          aria-hidden="true"
          onPointerDown={(e) => { start.current = e.clientY; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={(e) => { if (start.current !== null) setDy(Math.max(0, e.clientY - start.current)); }}
          onPointerUp={() => { const far = dy > 120; start.current = null; if (far) ref.current?.close(); else setDy(0); }}
        >
          <span className="h-1.5 w-10 rounded-full bg-fg-faint" />
        </div>
        <div className="flex items-start justify-between gap-3 px-5 pt-3">
          <h3 id="skill-sheet-title" className="break-all font-mono text-base text-fg">{title}</h3>
          <button type="button" aria-label="Close" onClick={() => ref.current?.close()}
            className={`-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-bg-hover hover:text-fg ${focusRing}`}>
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="px-5 pb-6 pt-2">{children}</div>
      </div>
    </dialog>
  );
}

const Label = ({ children }: { children: ReactNode }) => (
  <p className="mb-2 text-xs font-medium text-fg-dim">{children}</p>
);

export function SkillSheetBody({ lib, name, onAction }: { lib: Library; name: string; onAction: (a: Action) => void }) {
  const skill = lib.skills.find((s) => s.name === name);
  const groups = groupsOf(lib, name);
  const names = labelNames(lib);
  const addable = lib.labels.filter((l) => !groups.some((g) => g.id === l.id));
  const [addTo, setAddTo] = useState(addable[0]?.id ?? "");

  if (!skill) return <p className="text-sm text-fg-muted">This skill is no longer on this computer. The next check-in removes it from its labels.</p>;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2 text-[11px] text-fg-muted">
          <span className="rounded-md border border-hairline px-1.5 py-0.5">{skill.kind === "installed" ? "Installed" : "Library"}</span>
          {skill.quarantined && <span className="rounded-md border border-status-hot/40 px-1.5 py-0.5 text-status-hot">Quarantined: never routed</span>}
        </div>
        <p className="text-sm leading-relaxed text-fg-muted">{skill.description}</p>
      </div>

      <section>
        <Label>Test prompts</Label>
        <Squares tests={skill.tests} />
      </section>

      <section>
        <Label>What it can do for a prompt</Label>
        {skill.capabilities.length ? (
          <ul className="space-y-1.5 text-sm text-fg">
            {skill.capabilities.map((c) => <li key={c} className="flex gap-2"><span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-fg-dim" />{c}</li>)}
          </ul>
        ) : <p className="text-sm text-fg-dim">No card written for this skill yet.</p>}
      </section>

      {skill.example_prompts.length > 0 && (
        <section>
          <Label>Prompts it helps with</Label>
          <ul className="space-y-3">
            {skill.example_prompts.map((e) => (
              <li key={e.prompt} className="rounded-lg border border-hairline bg-bg-panel p-3">
                <p className="text-sm text-fg">&ldquo;{e.prompt}&rdquo;</p>
                <p className="mt-1 text-xs text-fg-muted">Adds: {e.adds}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <Label>In these groups</Label>
        {groups.length === 0 ? <p className="text-sm text-fg-dim">Not in any group yet, so routing never offers it.</p> : (
          <ul className="divide-y divide-hairline rounded-lg border border-hairline">
            {groups.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 text-sm text-fg">{g.name}</span>
                <RankTag rank={g.rank} />
                <Btn variant="ghost" className="px-3 text-xs"
                  aria-label={`Make ${name} ${g.rank === "use-first" ? "also helps" : "use first"} in ${g.name}`}
                  onClick={() => onAction({ kind: g.rank === "use-first" ? "also-helps" : "use-first", skill: name, label: g.id })}>
                  {g.rank === "use-first" ? "Make also helps" : "Make use first"}
                </Btn>
                <Btn variant="ghost" className="px-3 text-xs" aria-label={`Take ${name} out of ${g.name}`}
                  onClick={() => onAction({ kind: "remove", skill: name, label: g.id })}>
                  Remove
                </Btn>
              </li>
            ))}
          </ul>
        )}
      </section>

      {addable.length > 0 && !skill.quarantined && (
        <section className="space-y-2">
          <label htmlFor="skill-add-to" className="block text-xs font-medium text-fg-dim">Add to a group</label>
          <div className="flex gap-2">
            <select id="skill-add-to" value={addTo} onChange={(e) => setAddTo(e.target.value)}
              className={`min-h-11 min-w-0 flex-1 rounded-lg border border-hairline bg-bg-deep px-3 text-sm text-fg ${focusRing}`}>
              {addable.map((l) => <option key={l.id} value={l.id}>{l.level === "sub" ? `  ${names.get(l.id)} (${names.get(l.parent ?? "") ?? ""})` : names.get(l.id)}</option>)}
            </select>
            <Btn onClick={() => addTo && onAction({ kind: "also-helps", skill: name, label: addTo })}>Add</Btn>
          </div>
          <p className="text-xs text-fg-dim">Every change goes live after tonight&apos;s check, and only if no prompt routes worse.</p>
        </section>
      )}
    </div>
  );
}
