"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarRange, ChevronLeft, ChevronRight, GripHorizontal, LockKeyhole, RotateCcw, Sparkles } from "lucide-react";
import {
  DAYS,
  MINUTES_PER_DAY,
  clampBlock,
  createPlaceholderSchedule,
  formatTime,
  isEditableBlock,
  isScheduleDocument,
  type ScheduleBlock,
  type ScheduleDocument,
} from "@/lib/schedule/model";

const STORAGE_KEY = "oasis.schedule.v1";
const START_HOUR = 6;
const END_HOUR = 24;
const HOUR_HEIGHT = 68;
const SNAP_MINUTES = 15;

type Gesture = { id: string; mode: "move" | "resize"; originY: number; start: number; end: number };

function colorFor(block: ScheduleBlock) {
  if (block.system === "shabbat") return "border-amber-300/45 bg-gradient-to-br from-amber-400/20 to-orange-500/10 text-amber-50";
  if (block.parentId) return "border-cyan-300/35 bg-cyan-400/15 text-cyan-50";
  if (block.category === "work") return "border-blue-400/35 bg-blue-500/15 text-blue-50";
  return "border-violet-300/30 bg-violet-400/15 text-violet-50";
}

export function ScheduleClient() {
  const [schedule, setSchedule] = useState<ScheduleDocument>(() => createPlaceholderSchedule());
  const [hydrated, setHydrated] = useState(false);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [notice, setNotice] = useState("Placeholder week ready");
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isScheduleDocument(parsed)) setSchedule(parsed);
      }
    } catch {
      setNotice("Private storage unavailable · changes last for this session");
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...schedule, updatedAt: new Date().toISOString() }));
      setNotice("Saved privately on this device");
    } catch {
      setNotice("Private storage unavailable · changes last for this session");
    }
  }, [schedule, hydrated]);

  useEffect(() => {
    if (!gesture) return;
    const onMove = (event: PointerEvent) => {
      const delta = Math.round(((event.clientY - gesture.originY) / HOUR_HEIGHT) * 60 / SNAP_MINUTES) * SNAP_MINUTES;
      setSchedule((current) => ({
        ...current,
        blocks: current.blocks.map((block) => {
          if (block.id !== gesture.id || !isEditableBlock(block)) return block;
          if (gesture.mode === "resize") return clampBlock({ ...block, endMinute: gesture.end + delta });
          const duration = gesture.end - gesture.start;
          const startMinute = Math.max(0, Math.min(MINUTES_PER_DAY - duration, gesture.start + delta));
          return { ...block, startMinute, endMinute: startMinute + duration };
        }),
      }));
    };
    const onUp = () => setGesture(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [gesture]);

  const visibleBlocks = useMemo(() => schedule.blocks.filter((block) => block.endMinute > START_HOUR * 60), [schedule.blocks]);
  const reset = () => {
    setSchedule(createPlaceholderSchedule());
    setNotice("Placeholder week restored");
  };

  return (
    <div className="min-h-[calc(100vh-7rem)] space-y-5 pb-10">
      <header className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#090d15]/90 px-5 py-5 shadow-2xl shadow-black/20 sm:px-7">
        <div className="pointer-events-none absolute -right-16 -top-20 h-52 w-52 rounded-full bg-blue-500/15 blur-3xl" />
        <div className="relative flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-blue-300">
              <Sparkles className="h-3.5 w-3.5" /> Personal operating rhythm
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Schedule</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">Shape the placeholder blocks directly. Drag a block to move it and pull its lower grip to change its duration.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-xs text-slate-300 hover:bg-white/[0.08]" aria-label="Previous week"><ChevronLeft className="h-4 w-4" /></button>
            <div className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 text-xs font-medium text-slate-200"><CalendarRange className="h-4 w-4 text-blue-300" /> Week of {schedule.weekStartsOn}</div>
            <button type="button" className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-xs text-slate-300 hover:bg-white/[0.08]" aria-label="Next week"><ChevronRight className="h-4 w-4" /></button>
            <button type="button" onClick={reset} className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-xs text-slate-300 hover:bg-white/[0.08]"><RotateCcw className="h-3.5 w-3.5" /> Reset</button>
          </div>
        </div>
        <div className="relative mt-5 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4 text-[11px] text-slate-500">
          <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-emerald-300">Interface edit</span><span>→</span>
          <span className="rounded-full bg-blue-400/10 px-2.5 py-1 text-blue-300">Typed schedule document</span><span>→</span>
          <span className="rounded-full bg-violet-400/10 px-2.5 py-1 text-violet-300">Private device save</span>
          <span className="ml-auto">{notice} · {schedule.timezone}</span>
        </div>
      </header>

      <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#070a11]/95 shadow-2xl shadow-black/20" aria-label="Weekly calendar">
        <div className="overflow-x-auto">
          <div className="min-w-[1120px]">
            <div className="grid grid-cols-[72px_repeat(7,minmax(140px,1fr))] border-b border-white/10 bg-white/[0.025]">
              <div className="border-r border-white/[0.07] p-3 text-[10px] font-semibold uppercase tracking-widest text-slate-600">Time</div>
              {DAYS.map((day) => <div key={day} className="border-r border-white/[0.07] px-3 py-3 last:border-r-0"><div className="text-xs font-semibold text-slate-200">{day}</div><div className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-600">Plan</div></div>)}
            </div>
            <div ref={gridRef} className="relative grid grid-cols-[72px_repeat(7,minmax(140px,1fr))]" style={{ height: (END_HOUR - START_HOUR) * HOUR_HEIGHT }}>
              <div className="relative border-r border-white/[0.07]">
                {Array.from({ length: END_HOUR - START_HOUR }, (_, index) => <div key={index} className="absolute right-3 text-[10px] tabular-nums text-slate-600" style={{ top: index * HOUR_HEIGHT - 6 }}>{formatTime((START_HOUR + index) * 60)}</div>)}
              </div>
              {DAYS.map((day) => (
                <div key={day} className="relative border-r border-white/[0.07] last:border-r-0" style={{ backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR_HEIGHT - 1}px, rgba(255,255,255,.055) ${HOUR_HEIGHT - 1}px, rgba(255,255,255,.055) ${HOUR_HEIGHT}px)` }}>
                  {visibleBlocks.filter((block) => block.day === day && !(!block.parentId && block.category === "work")).map((block) => {
                    const top = Math.max(0, (block.startMinute - START_HOUR * 60) / 60 * HOUR_HEIGHT);
                    const height = Math.max(22, (Math.min(block.endMinute, END_HOUR * 60) - Math.max(block.startMinute, START_HOUR * 60)) / 60 * HOUR_HEIGHT);
                    return <article key={block.id} onPointerDown={(event) => { if (!isEditableBlock(block)) return; event.preventDefault(); setGesture({ id: block.id, mode: "move", originY: event.clientY, start: block.startMinute, end: block.endMinute }); }} className={`absolute left-1.5 right-1.5 z-10 select-none overflow-hidden rounded-lg border px-2 py-1.5 shadow-lg backdrop-blur-sm ${colorFor(block)} ${isEditableBlock(block) ? "cursor-grab active:cursor-grabbing" : "cursor-not-allowed"}`} style={{ top, height }}>
                      <div className="flex items-center gap-1.5"><span className="truncate text-[11px] font-semibold leading-4">{block.title}</span>{block.locked && <LockKeyhole className="ml-auto h-3 w-3 shrink-0 text-amber-300" />}</div>
                      {height > 35 && <div className="mt-0.5 text-[9px] tabular-nums opacity-60">{formatTime(block.startMinute)} – {formatTime(block.endMinute)}</div>}
                      {isEditableBlock(block) && <button type="button" aria-label={`Resize ${block.title}`} onPointerDown={(event) => { event.stopPropagation(); event.preventDefault(); setGesture({ id: block.id, mode: "resize", originY: event.clientY, start: block.startMinute, end: block.endMinute }); }} className="absolute inset-x-0 bottom-0 flex h-3 cursor-ns-resize items-end justify-center opacity-30 hover:opacity-100"><GripHorizontal className="h-3 w-3" /></button>}
                    </article>;
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
      <p className="px-1 text-xs leading-5 text-slate-500"><LockKeyhole className="mr-1.5 inline h-3.5 w-3.5 text-amber-300" />Shabbat is system-owned and immutable. The current scaffold reserves Friday 6 PM through Saturday 7 PM; the weekly local-sundown calculator will replace those boundaries without changing the schedule model.</p>
    </div>
  );
}
