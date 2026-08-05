"use client";

import { useEffect, useRef, useState } from "react";
import { FLEET } from "@/lib/marketing/fleet";

/**
 * The fleet roster — the page's signature element.
 *
 * A crew manifest, not a card grid: seven hairline rows, each with a status
 * light, a callsign, a seat, and a readout. Selecting a row swaps the detail
 * pane beside it.
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT DO
 *
 * 1. It does not expand rows in place. An accordion driven by an element
 *    this tall changes the height of the document while the reader is
 *    scrolling through it, which moves the thing they were about to click.
 *    A separate pane means selecting an agent changes nothing about the
 *    page's geometry.
 *
 * 2. It does not change selection on scroll. Scroll drives the ENTRANCE —
 *    rows stagger in and the live status lights start pulsing, so the
 *    roster visibly boots as you reach it. Selection stays under the
 *    reader's control, because content that only appears if you scroll at
 *    the right speed is content some people will never see.
 *
 * 3. It does not invent ARIA. Tab roles are attached only after mount,
 *    once JavaScript has proven it is running. Without JS the same markup
 *    is a list of headings with every detail already visible (see
 *    marketing.css) — so the roles never describe an interaction that is
 *    not actually available.
 */

const ROW_STAGGER_MS = 70;

export function FleetRoster() {
  const [selected, setSelected] = useState(0);
  const [booted, setBooted] = useState(false);
  const [mounted, setMounted] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Gate ARIA + single-panel behaviour on JS actually having run. First
  // client render matches the server (mounted=false), so this does not
  // trip a hydration mismatch.
  useEffect(() => setMounted(true), []);

  // Entrance. One observer, disconnected on first fire.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    if (
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setBooted(true);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setBooted(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -20% 0px", threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Roving tabindex. Arrow keys move selection and focus together, which is
  // what makes a vertical tablist usable without a mouse.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const last = FLEET.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = selected === last ? 0 : selected + 1;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = selected === 0 ? last : selected - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next === null) return;
    e.preventDefault();
    setSelected(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-12">
      <div
        ref={listRef}
        role={mounted ? "tablist" : undefined}
        aria-orientation={mounted ? "vertical" : undefined}
        aria-label={mounted ? "OASIS agent fleet" : undefined}
        onKeyDown={mounted ? onKeyDown : undefined}
        className="border-t border-ops-line"
      >
        <div className="flex items-center justify-between border-b border-ops-line px-1 py-2">
          <span className="font-data text-[10px] uppercase tracking-[0.24em] text-fg-dim">
            Callsign
          </span>
          <span className="font-data text-[10px] uppercase tracking-[0.24em] text-fg-dim">
            Status
          </span>
        </div>

        {FLEET.map((m, i) => {
          const active = mounted && selected === i;
          return (
            <button
              key={m.callsign}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role={mounted ? "tab" : undefined}
              id={`fleet-tab-${m.callsign.toLowerCase()}`}
              aria-selected={mounted ? active : undefined}
              aria-controls={mounted ? "fleet-panel" : undefined}
              tabIndex={mounted && !active ? -1 : 0}
              onClick={() => setSelected(i)}
              style={{ "--reveal-delay": `${i * ROW_STAGGER_MS}ms` } as React.CSSProperties}
              className={`m-reveal ${booted ? "is-in" : ""} group flex w-full items-center gap-4 border-b border-ops-line px-1 py-4 text-left transition-colors ${
                active ? "bg-signal-wash" : "hover:bg-ops-raised/60"
              }`}
            >
              <span
                className="m-dot shrink-0"
                data-state={m.state === "live" ? "live" : "scoped"}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={`block font-display text-base font-bold tracking-[0.08em] transition-colors sm:text-lg ${
                    active ? "text-signal" : "text-fg group-hover:text-fg"
                  }`}
                >
                  {m.callsign}
                </span>
                <span className="mt-0.5 block truncate text-[13px] text-fg-muted">
                  {m.seat}
                </span>
              </span>
              <span className="shrink-0 font-data text-[10px] uppercase tracking-[0.16em] text-fg-dim">
                {m.readout}
              </span>
            </button>
          );
        })}
      </div>

      <div
        id="fleet-panel"
        role={mounted ? "tabpanel" : undefined}
        aria-labelledby={
          mounted ? `fleet-tab-${FLEET[selected].callsign.toLowerCase()}` : undefined
        }
        tabIndex={mounted ? 0 : undefined}
        className="m-roster-pane lg:sticky lg:top-24 lg:self-start"
      >
        {FLEET.map((m, i) => (
          <article
            key={m.callsign}
            className="m-panel border border-ops-line bg-ops-panel p-6 sm:p-8 [&:not(:first-child)]:mt-4 lg:[&:not(:first-child)]:mt-4"
            data-active={mounted ? String(selected === i) : "true"}
          >
            {/* The seat sits under the callsign on narrow screens. Inline,
                it wraps mid-phrase and orphans the last word. */}
            <h3 className="font-display text-xl font-bold tracking-tight text-fg sm:text-2xl">
              {m.callsign}
              <span className="mt-1.5 block font-data text-[11px] font-normal uppercase tracking-[0.16em] text-fg-dim sm:ml-3 sm:mt-0 sm:inline">
                {m.seat}
              </span>
            </h3>

            <p className="mt-4 text-[15px] leading-relaxed text-fg-muted">
              {m.summary}
            </p>

            <ul className="mt-6 space-y-2.5">
              {m.duties.map((d) => (
                <li key={d} className="flex gap-3 text-sm leading-relaxed text-fg-muted">
                  <span
                    aria-hidden="true"
                    className="mt-[0.55rem] h-px w-3 shrink-0 bg-signal-dim"
                  />
                  <span>{d}</span>
                </li>
              ))}
            </ul>

            <p className="mt-6 border-t border-ops-line pt-4 text-sm leading-relaxed text-fg-dim">
              <span className="font-data text-[10px] uppercase tracking-[0.24em] text-signal-dim">
                Produces
              </span>
              <br />
              {m.artifact}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
