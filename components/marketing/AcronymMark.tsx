"use client";

import { useEffect, useRef, useState } from "react";

/**
 * O·A·S·I·S — the name, spelling itself out.
 *
 * Operational Agentic Systems Increasing Scalability. The acronym is the
 * company's actual thesis and it was nowhere on the site; the hero eyebrow
 * said "Operational agentic systems" as a throwaway label without ever
 * connecting it to the five letters above it.
 *
 * Each letter carries the REST of its own word — "O" + "perational" — so
 * opening one completes a real word rather than swapping in a caption. Open
 * all five and the row reads as the full sentence.
 *
 * BEHAVIOUR
 * - No JavaScript: every word is already expanded. The DOM contains the
 *   complete phrase, so it is readable and indexable with nothing running.
 * - With JavaScript: collapses to "O A S I S" on mount, then unfolds letter
 *   by letter when scrolled into view — the name assembling itself. After
 *   that, clicking or focusing a letter isolates it.
 * - Reduced motion: skips the sequence entirely and stays fully expanded,
 *   which is the same thing a no-JS visitor gets.
 *
 * The expansion animates `grid-template-columns` from 0fr to 1fr rather
 * than width, so it interpolates smoothly without measuring anything and
 * without a JS-driven layout loop.
 */

const LETTERS = [
  { head: "O", tail: "perational" },
  { head: "A", tail: "gentic" },
  { head: "S", tail: "ystems" },
  { head: "I", tail: "ncreasing" },
  { head: "S", tail: "calability" },
] as const;

/** Gap between each letter unfolding, in ms. */
const STAGGER = 260;

export function AcronymMark() {
  // Starts fully open so server HTML, no-JS, and the first client render
  // all agree. The collapse happens on mount, which is also the moment we
  // know JavaScript can undo it.
  const [open, setOpen] = useState<boolean[]>(() => LETTERS.map(() => true));
  const [interactive, setInteractive] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const played = useRef(false);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      typeof IntersectionObserver === "undefined"
    ) {
      setInteractive(true);
      return;
    }

    // Collapse, then unfold when it comes into view.
    setOpen(LETTERS.map(() => false));
    setInteractive(true);

    const el = ref.current;
    if (!el) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting || played.current) continue;
          played.current = true;
          io.disconnect();
          LETTERS.forEach((_, i) => {
            timers.push(
              setTimeout(() => {
                setOpen((prev) => {
                  const next = [...prev];
                  next[i] = true;
                  return next;
                });
              }, 220 + i * STAGGER),
            );
          });
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);

    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
    };
  }, []);

  /** Click isolates a letter; clicking the open one re-opens everything. */
  const toggle = (i: number) => {
    setOpen((prev) => {
      const isolated = prev[i] && prev.filter(Boolean).length === 1;
      return LETTERS.map((_, j) => (isolated ? true : j === i));
    });
  };

  return (
    <div
      ref={ref}
      className="m-acr"
      role="group"
      aria-label="OASIS — Operational Agentic Systems Increasing Scalability"
    >
      {LETTERS.map((l, i) => (
        <button
          key={i}
          type="button"
          data-open={open[i] ? "true" : "false"}
          onClick={() => toggle(i)}
          onMouseEnter={() => interactive && toggle(i)}
          // The full word is the accessible name, so a screen reader hears
          // "Operational" rather than "O, perational".
          aria-label={l.head + l.tail}
          className="m-acr-item"
        >
          <span className="m-acr-head">{l.head}</span>
          <span className="m-acr-word">
            <span>{l.tail}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
