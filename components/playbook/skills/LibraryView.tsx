"use client";
/** Library: every kind of work as a tile, then its sub-label chips and skills (two taps to any skill). */
import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { activeChip, members, scoreText, sortTiles, testLine, tiles as buildTiles, type Library } from "@/lib/skills/view";
import { focusRing, KindIcon, Meter, RankTag } from "./ui";

function Chip({ pressed, onClick, label, n }: { pressed: boolean; onClick: () => void; label: string; n: number }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-3 text-xs transition-colors duration-150 ${pressed ? "border-accent/40 bg-accent-soft text-fg" : "border-hairline text-fg-muted hover:text-fg"} ${focusRing}`}
    >
      {label}
      <span className="tabular-nums text-fg-dim">{n}</span>
    </button>
  );
}

export function LibraryView({ lib, group, onGroup, onOpenSkill }: {
  lib: Library; group: string | null; onGroup: (id: string | null) => void; onOpenSkill: (name: string) => void;
}) {
  const all = useMemo(() => buildTiles(lib), [lib]);
  const [sort, setSort] = useState<"biggest" | "weakest">("biggest");
  const [chip, setChip] = useState<string | null>(null);
  const reduce = useReducedMotion();
  const current = all.find((t) => t.id === group) ?? null;

  if (current) {
    const active = activeChip(current, chip);
    const list = members(lib, current.id, active);
    return (
      <section aria-labelledby="skills-group-title" className="space-y-4">
        <button type="button" onClick={() => { setChip(null); onGroup(null); }} className={`inline-flex min-h-11 items-center gap-1.5 text-sm text-fg-muted hover:text-fg ${focusRing}`}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          All kinds of work
        </button>
        <div>
          <h3 id="skills-group-title" className="flex items-center gap-2 text-lg font-semibold text-fg"><KindIcon id={current.id} />{current.title}</h3>
          <p className="mt-1 text-sm text-fg-muted">{current.long}</p>
          <p className="mt-1 text-xs tabular-nums text-fg-dim">
            {current.skills} skills · {current.score ? `${scoreText(current.score)} test prompts routed right` : "Not tested yet"}
          </p>
        </div>
        {current.subs.length > 0 && (
          <div role="group" aria-label="Filter by sub-label" className="flex flex-wrap gap-2">
            <Chip pressed={active === null} onClick={() => setChip(null)} label="All" n={current.skills} />
            {current.subs.map((s) => <Chip key={s.id} pressed={active === s.id} onClick={() => setChip(s.id)} label={s.name} n={s.skills} />)}
          </div>
        )}
        {list.length === 0 ? (
          <p className="rounded-xl border border-hairline bg-bg-panel px-4 py-6 text-sm text-fg-muted">No skill on this computer carries this label yet.</p>
        ) : (
          <ul className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-bg-panel">
            {list.map((m) => {
              const t = testLine(m.skill.tests);
              return (
                <li key={m.skill.name}>
                  <button type="button" onClick={() => onOpenSkill(m.skill.name)} className={`flex w-full min-h-11 items-center gap-3 px-4 py-3 text-left hover:bg-bg-hover ${focusRing}`}>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-mono text-sm text-fg" title={m.skill.name}>{m.skill.name}</span>
                        <RankTag rank={m.rank} />
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-fg-muted" title={m.skill.description}>{m.skill.description}</span>
                    </span>
                    <span className={`shrink-0 text-right text-xs tabular-nums ${t.tested ? "text-fg-muted" : "text-status-warm"}`}>
                      {t.tested ? scoreText(m.skill.tests) : "Not tested"}
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-fg-dim" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    );
  }

  const ordered = sortTiles(all, sort);
  return (
    <section aria-labelledby="skills-kinds-title" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="skills-kinds-title" className="text-sm font-semibold text-fg">Kinds of work</h3>
        <div role="group" aria-label="Sort kinds of work" className="flex gap-1 rounded-lg border border-hairline bg-bg-deep p-1">
          {(["biggest", "weakest"] as const).map((s) => (
            <button key={s} type="button" aria-pressed={sort === s} onClick={() => setSort(s)}
              className={`min-h-11 rounded-md px-3 text-xs font-medium ${sort === s ? "bg-bg-elev text-fg" : "text-fg-muted hover:text-fg"} ${focusRing}`}>
              {s === "biggest" ? "Biggest" : "Weakest"}
            </button>
          ))}
        </div>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ordered.map((t) => (
          <motion.li key={t.id} layout={!reduce} transition={{ duration: 0.18, ease: "easeOut" }}>
            <button type="button" onClick={() => onGroup(t.id)}
              className={`flex h-full w-full min-h-11 flex-col gap-3 rounded-xl border border-hairline bg-bg-panel p-4 text-left transition-colors duration-150 hover:border-bg-border-strong hover:bg-bg-raised ${focusRing}`}>
              <span className="flex items-center gap-2 text-fg"><KindIcon id={t.id} /><span className="text-sm font-semibold">{t.title}</span></span>
              <span className="flex items-baseline justify-between gap-2 text-xs">
                <span className="tabular-nums text-fg-muted">{t.skills} skills</span>
                <span className={`tabular-nums ${t.score ? "text-fg" : "text-fg-dim"}`}>{t.score ? `${scoreText(t.score)} routed right` : "Not tested yet"}</span>
              </span>
              <Meter score={t.score} />
            </button>
          </motion.li>
        ))}
      </ul>
    </section>
  );
}
