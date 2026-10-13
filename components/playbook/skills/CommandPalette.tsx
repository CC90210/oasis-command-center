"use client";
/** Ctrl K / Cmd K search over skills and kinds of work (JARVIS plan 3). Native modal dialog, combobox pattern. */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Search } from "lucide-react";
import { search, tiles, type Hit, type Library } from "@/lib/skills/view";

export function PaletteResults({ hits, active, onPick, onHover }: { hits: Hit[]; active: number; onPick: (h: Hit) => void; onHover: (i: number) => void }) {
  if (!hits.length) return <p id="skills-palette-list" className="px-4 py-6 text-sm text-fg-muted">No skill or kind of work matches.</p>;
  return (
    <ul id="skills-palette-list" role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto p-1">
      {hits.map((h, i) => {
        const detail = h.kind === "skill" ? h.detail : `Kind of work · ${h.detail}`;
        return (
          <li key={h.kind === "skill" ? `s-${h.name}` : `g-${h.id}`} id={`skills-hit-${i}`} role="option" aria-selected={i === active} tabIndex={-1}
            onMouseMove={() => onHover(i)} onClick={() => onPick(h)}
            className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg px-3 text-sm ${i === active ? "bg-active text-fg" : "text-fg-muted"}`}>
            <span className="min-w-0 flex-1">
              <span className={`block truncate ${h.kind === "skill" ? "font-mono" : "font-medium"}`} title={h.name}>{h.name}</span>
            </span>
            <span className="shrink-0 truncate text-xs text-fg-dim" title={detail}>{detail}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function CommandPalette({ open, lib, onClose, onPick }: { open: boolean; lib: Library; onClose: () => void; onPick: (h: Hit) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const tileList = useMemo(() => tiles(lib), [lib]);
  const hits = useMemo(() => search(lib, tileList, q), [lib, tileList, q]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement as HTMLElement | null;
      setQ(""); setActive(0); d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const closed = () => { onClose(); opener.current?.focus(); };
    d.addEventListener("close", closed);
    return () => d.removeEventListener("close", closed);
  }, [onClose]);

  const pick = (h: Hit) => { ref.current?.close(); onPick(h); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, Math.max(hits.length - 1, 0))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && hits[active]) { e.preventDefault(); pick(hits[active]); }
  };

  return (
    <dialog ref={ref} aria-label="Search skills and kinds of work" onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}
      className="mx-auto mt-[12vh] w-[min(560px,calc(100vw-32px))] rounded-xl border border-hairline bg-bg-elev p-0 text-fg shadow-elev backdrop:bg-black/60">
      <div className="flex items-center gap-2 border-b border-hairline px-3 focus-within:border-accent/60">
        <Search className="h-4 w-4 shrink-0 text-fg-dim" aria-hidden="true" />
        <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={onKey}
          role="combobox" aria-expanded="true" aria-controls="skills-palette-list" aria-autocomplete="list"
          aria-activedescendant={hits[active] ? `skills-hit-${active}` : undefined} aria-label="Search skills and kinds of work"
          placeholder="Search skills and kinds of work" className="min-h-11 w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-dim" />
      </div>
      <PaletteResults hits={hits} active={active} onPick={pick} onHover={setActive} />
    </dialog>
  );
}
