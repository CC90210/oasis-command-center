"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarPlus,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  GripHorizontal,
  LockKeyhole,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  DAYS,
  MINUTES_PER_DAY,
  clampBlock,
  createPlaceholderSchedule,
  createScheduleBlock,
  ensureSundayWorkday,
  formatTime,
  isEditableBlock,
  isScheduleDocument,
  overlapsProtectedTime,
  type ScheduleBlock,
  type ScheduleCategory,
  type ScheduleDay,
  type ScheduleDocument,
} from "@/lib/schedule/model";

const LEGACY_STORAGE_KEY = "oasis.schedule.v1";
const STORAGE_KEY_PREFIX = "oasis.schedule.week.v1";
const START_HOUR = 6;
const END_HOUR = 24;
const HOUR_HEIGHT = 68;
const SNAP_MINUTES = 15;
const DAY_COLUMN_OFFSET = 72;

type Gesture = {
  id: string;
  mode: "move" | "resize";
  originX: number;
  originY: number;
  start: number;
  end: number;
  day: ScheduleDay;
};
type EditorState = { mode: "create" | "edit"; block: ScheduleBlock };

const categories: { value: ScheduleCategory; label: string }[] = [
  { value: "work", label: "Work" },
  { value: "morning", label: "Morning" },
  { value: "personal", label: "Personal" },
];

function colorFor(block: ScheduleBlock) {
  if (block.system === "shabbat")
    return "border-amber-300/45 bg-gradient-to-br from-amber-400/20 to-orange-500/10 text-amber-50";
  if (block.parentId) return "border-cyan-300/35 bg-cyan-400/15 text-cyan-50";
  if (block.category === "work")
    return "border-blue-400/35 bg-blue-500/15 text-blue-50";
  if (block.category === "morning")
    return "border-violet-300/30 bg-violet-400/15 text-violet-50";
  return "border-emerald-300/30 bg-emerald-400/15 text-emerald-50";
}

function toTimeValue(minutes: number) {
  if (minutes === MINUTES_PER_DAY) return "00:00";
  const safe = Math.max(0, Math.min(MINUTES_PER_DAY - 1, minutes));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function fromTimeValue(value: string) {
  if (!/^\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return Math.max(0, Math.min(MINUTES_PER_DAY, hours * 60 + minutes));
}

function scheduleStorageKey(weekStartsOn: string) {
  return `${STORAGE_KEY_PREFIX}:${weekStartsOn}`;
}

function shiftIsoDate(iso: string, days: number) {
  const date = new Date(`${iso}T12:00:00`);
  date.setDate(date.getDate() + days);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function ScheduleClient() {
  const [schedule, setSchedule] = useState<ScheduleDocument>(() =>
    createPlaceholderSchedule(),
  );
  const [hydrated, setHydrated] = useState(false);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [notice, setNotice] = useState("Placeholder week ready");
  const gridRef = useRef<HTMLDivElement>(null);
  const movedRef = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const initialWeekRef = useRef(schedule.weekStartsOn);
  const isEditorOpen = editor !== null;

  useEffect(() => {
    try {
      const raw =
        window.localStorage.getItem(scheduleStorageKey(initialWeekRef.current)) ||
        window.localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isScheduleDocument(parsed)) setSchedule(ensureSundayWorkday(parsed));
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
      window.localStorage.setItem(
        scheduleStorageKey(schedule.weekStartsOn),
        JSON.stringify({ ...schedule, updatedAt: new Date().toISOString() }),
      );
      setNotice("Saved privately on this device");
    } catch {
      setNotice("Private storage unavailable · changes last for this session");
    }
  }, [schedule, hydrated]);

  useEffect(() => {
    if (!isEditorOpen) return;
    const frame = requestAnimationFrame(() => titleRef.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEditor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
    };
  }, [isEditorOpen]);

  useEffect(() => {
    if (!gesture) return;
    const onMove = (event: PointerEvent) => {
      const deltaMinutes =
        Math.round(
          (((event.clientY - gesture.originY) / HOUR_HEIGHT) * 60) /
            SNAP_MINUTES,
        ) * SNAP_MINUTES;
      const bounds = gridRef.current?.getBoundingClientRect();
      const columnWidth = bounds
        ? (bounds.width - DAY_COLUMN_OFFSET) / DAYS.length
        : 150;
      const deltaDays =
        gesture.mode === "move"
          ? Math.round((event.clientX - gesture.originX) / columnWidth)
          : 0;
      movedRef.current ||=
        Math.abs(event.clientY - gesture.originY) > 4 ||
        Math.abs(event.clientX - gesture.originX) > 4;
      setSchedule((current) => ({
        ...current,
        blocks: current.blocks.map((block) => {
          if (block.id !== gesture.id || !isEditableBlock(block)) return block;
          let candidate: ScheduleBlock;
          if (gesture.mode === "resize")
            candidate = clampBlock({
              ...block,
              endMinute: gesture.end + deltaMinutes,
            });
          else {
            const duration = gesture.end - gesture.start;
            const startMinute = Math.max(
              0,
              Math.min(
                MINUTES_PER_DAY - duration,
                gesture.start + deltaMinutes,
              ),
            );
            const dayIndex = Math.max(
              0,
              Math.min(DAYS.length - 1, DAYS.indexOf(gesture.day) + deltaDays),
            );
            candidate = {
              ...block,
              day: DAYS[dayIndex],
              startMinute,
              endMinute: startMinute + duration,
            };
          }
          if (overlapsProtectedTime(candidate, current.blocks)) {
            setNotice("Shabbat is protected · choose another time");
            return block;
          }
          return candidate;
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

  const visibleBlocks = useMemo(
    () => schedule.blocks.filter((block) => block.endMinute > START_HOUR * 60),
    [schedule.blocks],
  );
  const openCreate = (day: ScheduleDay = "Monday", startMinute = 9 * 60) => {
    const protectedBlock = schedule.blocks.find(
      (block) =>
        block.system === "shabbat" &&
        block.day === day &&
        startMinute >= block.startMinute &&
        startMinute < block.endMinute,
    );
    if (protectedBlock) {
      setNotice("Shabbat is protected · choose another time");
      return;
    }
    const nextProtectedStart = schedule.blocks
      .filter(
        (block) =>
          block.system === "shabbat" &&
          block.day === day &&
          block.startMinute > startMinute,
      )
      .reduce(
        (nearest, block) => Math.min(nearest, block.startMinute),
        MINUTES_PER_DAY,
      );
    const endMinute = Math.min(
      startMinute + 60,
      nextProtectedStart,
      MINUTES_PER_DAY,
    );
    const draft = createScheduleBlock({
      title: "",
      day,
      startMinute,
      endMinute,
      category: "personal",
    });
    setEditor({ mode: "create", block: draft });
  };
  const saveEditor = () => {
    if (!editor) return;
    const block = clampBlock({
      ...editor.block,
      title: editor.block.title.trim() || "Untitled event",
      description: editor.block.description?.trim() || undefined,
    });
    if (overlapsProtectedTime(block, schedule.blocks)) {
      setNotice("This event overlaps protected Shabbat time");
      return;
    }
    setSchedule((current) => ({
      ...current,
      blocks:
        editor.mode === "create"
          ? [...current.blocks, block]
          : current.blocks.map((item) => (item.id === block.id ? block : item)),
    }));
    setNotice(editor.mode === "create" ? "Event created" : "Event updated");
    setEditor(null);
  };
  const deleteEvent = () => {
    if (!editor || !isEditableBlock(editor.block)) return;
    setSchedule((current) => ({
      ...current,
      blocks: current.blocks.filter(
        (item) =>
          item.id !== editor.block.id && item.parentId !== editor.block.id,
      ),
    }));
    setNotice("Event deleted");
    setEditor(null);
  };
  const duplicateEvent = () => {
    if (!editor) return;
    const duplicate = createScheduleBlock({
      ...editor.block,
      title: `${editor.block.title} copy`,
      startMinute: Math.min(
        editor.block.startMinute + 60,
        MINUTES_PER_DAY - (editor.block.endMinute - editor.block.startMinute),
      ),
      endMinute: Math.min(editor.block.endMinute + 60, MINUTES_PER_DAY),
    });
    if (overlapsProtectedTime(duplicate, schedule.blocks)) {
      setNotice("The copy would overlap protected Shabbat time");
      return;
    }
    setSchedule((current) => ({
      ...current,
      blocks: [...current.blocks, duplicate],
    }));
    setNotice("Event duplicated");
    setEditor(null);
  };
  const navigateWeek = (days: number) => {
    const weekStartsOn = shiftIsoDate(schedule.weekStartsOn, days);
    try {
      const raw = window.localStorage.getItem(scheduleStorageKey(weekStartsOn));
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isScheduleDocument(parsed)) {
          setSchedule(ensureSundayWorkday(parsed));
          setNotice("Week loaded");
          return;
        }
      }
    } catch { /* A fresh in-memory week is still usable. */ }
    setSchedule(createPlaceholderSchedule(new Date(`${weekStartsOn}T12:00:00`)));
    setNotice("Fresh week ready");
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
            <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
              Schedule
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
              Click open space to create. Click an event to edit. Drag to move
              across days, or pull the lower grip to resize.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openCreate()}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-3.5 text-xs font-semibold text-white hover:bg-blue-500"
            >
              <CalendarPlus className="h-4 w-4" /> New event
            </button>
            <button
              type="button"
              onClick={() => navigateWeek(-7)}
              className="inline-flex h-9 items-center rounded-lg border border-white/10 bg-white/[0.04] px-3 text-slate-300 hover:bg-white/[0.08]"
              aria-label="Previous week"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 text-xs font-medium text-slate-200">
              <CalendarRange className="h-4 w-4 text-blue-300" /> Week of{" "}
              {schedule.weekStartsOn}
            </div>
            <button
              type="button"
              onClick={() => navigateWeek(7)}
              className="inline-flex h-9 items-center rounded-lg border border-white/10 bg-white/[0.04] px-3 text-slate-300 hover:bg-white/[0.08]"
              aria-label="Next week"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                setSchedule(
                  createPlaceholderSchedule(
                    new Date(`${schedule.weekStartsOn}T12:00:00`),
                  ),
                );
                setNotice("Placeholder week restored");
              }}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-xs text-slate-300 hover:bg-white/[0.08]"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset
            </button>
          </div>
        </div>
        <div
          aria-live="polite"
          className="relative mt-5 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4 text-[11px] text-slate-500"
        >
          <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-emerald-300">
            Click · create/edit
          </span>
          <span>→</span>
          <span className="rounded-full bg-blue-400/10 px-2.5 py-1 text-blue-300">
            Drag · move/resize
          </span>
          <span>→</span>
          <span className="rounded-full bg-violet-400/10 px-2.5 py-1 text-violet-300">
            Autosave · this device
          </span>
          <span className="ml-auto">
            {notice} · {schedule.timezone}
          </span>
        </div>
      </header>

      <section
        className="overflow-hidden rounded-2xl border border-white/10 bg-[#070a11]/95 shadow-2xl shadow-black/20"
        aria-label="Weekly calendar"
      >
        <div className="overflow-x-auto">
          <div className="min-w-[1120px]">
            <div className="grid grid-cols-[72px_repeat(7,minmax(140px,1fr))] border-b border-white/10 bg-white/[0.025]">
              <div className="border-r border-white/[0.07] p-3 text-[10px] font-semibold uppercase tracking-widest text-slate-600">
                Time
              </div>
              {DAYS.map((day) => (
                <div
                  key={day}
                  className="border-r border-white/[0.07] px-3 py-3 last:border-r-0"
                >
                  <div className="text-xs font-semibold text-slate-200">
                    {day}
                  </div>
                  <div className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-600">
                    Click to add
                  </div>
                </div>
              ))}
            </div>
            <div
              ref={gridRef}
              className="relative grid grid-cols-[72px_repeat(7,minmax(140px,1fr))]"
              style={{ height: (END_HOUR - START_HOUR) * HOUR_HEIGHT }}
            >
              <div className="relative border-r border-white/[0.07]">
                {Array.from({ length: END_HOUR - START_HOUR }, (_, index) => (
                  <div
                    key={index}
                    className="absolute right-3 text-[10px] tabular-nums text-slate-600"
                    style={{ top: index * HOUR_HEIGHT - 6 }}
                  >
                    {formatTime((START_HOUR + index) * 60)}
                  </div>
                ))}
              </div>
              {DAYS.map((day) => (
                <div
                  key={day}
                  role="gridcell"
                  tabIndex={0}
                  aria-label={`${day}, click or press Enter to add an event`}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openCreate(day);
                    }
                  }}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const minute = Math.max(
                      START_HOUR * 60,
                      Math.min(
                        (END_HOUR - 1) * 60,
                        START_HOUR * 60 +
                          Math.round(
                            (((event.clientY - rect.top) / HOUR_HEIGHT) * 60) /
                              SNAP_MINUTES,
                          ) *
                            SNAP_MINUTES,
                      ),
                    );
                    openCreate(day, minute);
                  }}
                  className="relative border-r border-white/[0.07] last:border-r-0 outline-none focus-visible:bg-blue-500/[0.04]"
                  style={{
                    backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR_HEIGHT - 1}px, rgba(255,255,255,.055) ${HOUR_HEIGHT - 1}px, rgba(255,255,255,.055) ${HOUR_HEIGHT}px)`,
                  }}
                >
                  {visibleBlocks
                    .filter(
                      (block) =>
                        block.day === day &&
                        !(
                          !block.parentId &&
                          schedule.blocks.some(
                            (child) => child.parentId === block.id,
                          )
                        ),
                    )
                    .map((block) => {
                      const top = Math.max(
                        0,
                        ((block.startMinute - START_HOUR * 60) / 60) *
                          HOUR_HEIGHT,
                      );
                      const height = Math.max(
                        22,
                        ((Math.min(block.endMinute, END_HOUR * 60) -
                          Math.max(block.startMinute, START_HOUR * 60)) /
                          60) *
                          HOUR_HEIGHT,
                      );
                      return (
                        <article
                          key={block.id}
                          role="button"
                          tabIndex={0}
                          aria-label={`${block.title}, ${formatTime(block.startMinute)} to ${formatTime(block.endMinute)}${block.locked ? ", locked" : ", press Enter to edit"}`}
                          onKeyDown={(event) => {
                            if (
                              (event.key === "Enter" || event.key === " ") &&
                              isEditableBlock(block)
                            ) {
                              event.preventDefault();
                              event.stopPropagation();
                              setEditor({ mode: "edit", block });
                            }
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (movedRef.current) {
                              movedRef.current = false;
                              return;
                            }
                            if (isEditableBlock(block))
                              setEditor({ mode: "edit", block });
                          }}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            if (!isEditableBlock(block)) return;
                            movedRef.current = false;
                            event.currentTarget.setPointerCapture(
                              event.pointerId,
                            );
                            setGesture({
                              id: block.id,
                              mode: "move",
                              originX: event.clientX,
                              originY: event.clientY,
                              start: block.startMinute,
                              end: block.endMinute,
                              day: block.day,
                            });
                          }}
                          className={`absolute left-1.5 right-1.5 z-10 select-none overflow-hidden rounded-lg border px-2 py-1.5 text-left shadow-lg backdrop-blur-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-300 ${colorFor(block)} ${isEditableBlock(block) ? "cursor-grab active:cursor-grabbing" : "cursor-not-allowed"}`}
                          style={{ top, height }}
                        >
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[11px] font-semibold leading-4">
                              {block.title}
                            </span>
                            {block.locked && (
                              <LockKeyhole className="ml-auto h-3 w-3 shrink-0 text-amber-300" />
                            )}
                          </div>
                          {height > 35 && (
                            <div className="mt-0.5 text-[9px] tabular-nums opacity-60">
                              {formatTime(block.startMinute)} –{" "}
                              {formatTime(block.endMinute)}
                            </div>
                          )}
                          {isEditableBlock(block) && (
                            <button
                              type="button"
                              aria-label={`Resize ${block.title}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              movedRef.current = false;
                            }}
                              onPointerDown={(event) => {
                                event.stopPropagation();
                                movedRef.current = true;
                                setGesture({
                                  id: block.id,
                                  mode: "resize",
                                  originX: event.clientX,
                                  originY: event.clientY,
                                  start: block.startMinute,
                                  end: block.endMinute,
                                  day: block.day,
                                });
                              }}
                              className="absolute inset-x-0 bottom-0 flex h-3 cursor-ns-resize items-end justify-center opacity-30 hover:opacity-100"
                            >
                              <GripHorizontal className="h-3 w-3" />
                            </button>
                          )}
                        </article>
                      );
                    })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
      <p className="px-1 text-xs leading-5 text-slate-500">
        <LockKeyhole className="mr-1.5 inline h-3.5 w-3.5 text-amber-300" />
        Shabbat is immutable. Events cannot be created, moved, or resized into
        the protected Friday-evening through Saturday-evening window.
      </p>

      {editor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEditor(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="event-editor-title"
            className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0c111b] p-5 shadow-2xl sm:p-6"
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-blue-300">
                  {editor.mode === "create" ? "New event" : "Edit event"}
                </p>
                <h2
                  id="event-editor-title"
                  className="mt-1 text-xl font-semibold text-white"
                >
                  Event details
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setEditor(null)}
                aria-label="Close event editor"
                className="rounded-lg p-2 text-slate-500 hover:bg-white/[0.06] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-5 space-y-4">
              <label>
                <span className="label">Event name</span>
                <input
                  ref={titleRef}
                  className="input"
                  value={editor.block.title}
                  placeholder="Add a title"
                  onChange={(event) =>
                    setEditor(
                      (state) =>
                        state && {
                          ...state,
                          block: { ...state.block, title: event.target.value },
                        },
                    )
                  }
                />
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label>
                  <span className="label">Day</span>
                  <select
                    className="select"
                    value={editor.block.day}
                    onChange={(event) =>
                      setEditor(
                        (state) =>
                          state && {
                            ...state,
                            block: {
                              ...state.block,
                              day: event.target.value as ScheduleDay,
                            },
                          },
                      )
                    }
                  >
                    {DAYS.map((day) => (
                      <option key={day}>{day}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="label">Calendar</span>
                  <select
                    className="select"
                    value={editor.block.category}
                    onChange={(event) =>
                      setEditor(
                        (state) =>
                          state && {
                            ...state,
                            block: {
                              ...state.block,
                              category: event.target.value as ScheduleCategory,
                            },
                          },
                      )
                    }
                  >
                    {categories.map((category) => (
                      <option key={category.value} value={category.value}>
                        {category.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label>
                  <span className="label">Starts</span>
                  <div className="relative">
                    <Clock3 className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-500" />
                    <input
                      type="time"
                      step={900}
                      className="input pl-9"
                      value={toTimeValue(editor.block.startMinute)}
                      onChange={(event) => {
                        const startMinute = fromTimeValue(event.target.value);
                        if (startMinute === null) return;
                        setEditor(
                          (state) =>
                            state && {
                              ...state,
                              block: { ...state.block, startMinute },
                            },
                        );
                      }}
                    />
                  </div>
                </label>
                <label>
                  <span className="label">Ends</span>
                  <input
                    type="time"
                    step={900}
                    className="input"
                    value={toTimeValue(editor.block.endMinute)}
                    onChange={(event) => {
                      const endMinute = fromTimeValue(event.target.value);
                      if (endMinute === null) return;
                      const normalizedEnd =
                        endMinute === 0 ? MINUTES_PER_DAY : endMinute;
                      setEditor(
                        (state) =>
                          state && {
                            ...state,
                            block: {
                              ...state.block,
                              endMinute: normalizedEnd,
                            },
                          },
                      );
                    }}
                  />
                </label>
              </div>
              <label>
                <span className="label">Notes</span>
                <textarea
                  className="textarea"
                  rows={3}
                  value={editor.block.description || ""}
                  placeholder="Optional context, location, or intention"
                  onChange={(event) =>
                    setEditor(
                      (state) =>
                        state && {
                          ...state,
                          block: {
                            ...state.block,
                            description: event.target.value,
                          },
                        },
                    )
                  }
                />
              </label>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-white/[0.07] pt-4">
              {editor.mode === "edit" && (
                <>
                  <button
                    type="button"
                    onClick={deleteEvent}
                    className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-medium text-red-300 hover:bg-red-400/10"
                  >
                    <Trash2 className="h-4 w-4" /> Delete
                  </button>
                  <button
                    type="button"
                    onClick={duplicateEvent}
                    className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-medium text-slate-300 hover:bg-white/[0.06]"
                  >
                    <Copy className="h-4 w-4" /> Duplicate
                  </button>
                </>
              )}
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditor(null)}
                  className="h-9 rounded-lg border border-white/10 px-3 text-xs font-medium text-slate-300 hover:bg-white/[0.06]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEditor}
                  className="h-9 rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white hover:bg-blue-500"
                >
                  {editor.mode === "create" ? "Create event" : "Save changes"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
