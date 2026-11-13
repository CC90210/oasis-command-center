"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  Building2,
  Camera,
  Check,
  ChevronRight,
  FileText,
  Flag,
  Gauge,
  Layers,
  Mail,
  MapPin,
  Minus,
  PenLine,
  Store,
  Tag,
  Target,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ScanEvent } from "@/lib/site-scan/events";

/**
 * The agent's work log, line by line, as the scan does it. Lines arrive in bursts (sixteen
 * checks land at once); the workspace paces them (usePacedCount) so the visitor can read them,
 * and catches up quickly when far behind. Nothing here is written by the browser: every line is
 * a stored event from the server.
 */

const ICONS: Record<ScanEvent["kind"], LucideIcon> = {
  note: ChevronRight,
  page: FileText,
  check: Check,
  signal: Tag,
  speed: Gauge,
  score: Target,
  geo: MapPin,
  screenshot: Camera,
  category: Layers,
  competitor: Store,
  prospect: Building2,
  segment: Users,
  dns: Mail,
  email: PenLine,
  done: Flag,
  error: AlertTriangle,
};

function tone(ev: ScanEvent): string {
  if (ev.kind === "error") return "text-status-warm";
  if (ev.kind === "done") return "text-status-engaged";
  if (ev.kind === "check") return ev.data?.status === "yes" ? "text-fg" : ev.data?.status === "no" ? "text-status-warm" : "text-fg-dim";
  if (ev.kind === "note") return "text-fg-muted";
  if (ev.kind === "competitor" || ev.kind === "prospect" || ev.kind === "category" || ev.kind === "score") return "text-fg";
  return "text-fg";
}

function iconTone(ev: ScanEvent): string {
  if (ev.kind === "error" || (ev.kind === "check" && ev.data?.status === "no")) return "text-status-warm";
  if (ev.kind === "done" || (ev.kind === "check" && ev.data?.status === "yes")) return "text-status-engaged";
  if (ev.kind === "note" || ev.kind === "check") return "text-fg-dim";
  return "text-signal";
}

/** A check is a tick only when it passed: a miss is a cross, and "not known from outside" a dash. */
function iconFor(ev: ScanEvent): LucideIcon {
  if (ev.kind !== "check") return ICONS[ev.kind];
  return ev.data?.status === "yes" ? Check : ev.data?.status === "no" ? X : Minus;
}

export function stampOf(ev: ScanEvent, t0: number): string {
  const s = Math.max(0, (new Date(ev.at).getTime() - t0) / 1_000);
  return `+${s.toFixed(1)}s`;
}

/** How many of `total` lines to show: one at a time, faster the further behind. */
export function usePacedCount(total: number, instant: boolean): number {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(instant ? total : 0);
  useEffect(() => {
    if (instant || reduce) {
      setShown(total);
      return;
    }
    if (shown >= total) return;
    const backlog = total - shown;
    const delay = backlog > 24 ? 30 : backlog > 10 ? 90 : 220;
    const t = setTimeout(() => setShown((s) => Math.min(total, s + 1)), delay);
    return () => clearTimeout(t);
  }, [total, shown, instant, reduce]);
  return Math.min(shown, total);
}

export function AgentConsole({ events, live, t0 }: { events: ScanEvent[]; live: boolean; t0: number }) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);
  const reduce = useReducedMotion();

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [events.length, pinned]);

  return (
    <div className="relative flex min-h-0 flex-col border border-ops-edge bg-ops-void/95">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        className="h-[360px] overflow-y-auto px-4 py-3 font-data text-[12.5px] leading-[1.65] sm:h-[440px]"
        role="log"
        aria-live="polite"
        aria-label="What the scanner is doing"
      >
        {events.length === 0 ? <p className="text-fg-dim">Connecting to the scanner...</p> : null}
        <ol>
          {events.map((ev, i) => {
            const Icon = iconFor(ev);
            const last = i === events.length - 1;
            return (
              <motion.li
                key={ev.id}
                initial={reduce ? false : { opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                className="grid grid-cols-[56px_18px_1fr] items-start gap-x-2"
              >
                <span className="pt-px text-[11px] tabular-nums text-fg-dim">{stampOf(ev, t0)}</span>
                <Icon className={`mt-[3px] h-3.5 w-3.5 ${iconTone(ev)}`} aria-hidden="true" />
                <span className={`min-w-0 break-words ${tone(ev)}`}>
                  {ev.source === "runner" && ev.kind !== "note" ? <span className="mr-2 text-[10px] uppercase tracking-[0.18em] text-signal">match</span> : null}
                  {ev.text}
                  {last && live ? <span className="ml-1 inline-block h-3.5 w-[7px] translate-y-[2px] animate-pulse bg-signal" aria-hidden="true" /> : null}
                </span>
              </motion.li>
            );
          })}
        </ol>
      </div>
      {!pinned ? (
        <button
          type="button"
          onClick={() => setPinned(true)}
          className="absolute bottom-3 right-3 border border-ops-edge bg-ops-panel px-3 py-1.5 font-data text-[10px] uppercase tracking-[0.2em] text-fg hover:border-signal"
        >
          Jump to live
        </button>
      ) : null}
    </div>
  );
}
