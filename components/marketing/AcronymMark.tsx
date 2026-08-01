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
  const ref = useRef<HTMLDivElement>(null);
  const played = useRef(false);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    // Collapse INSTANTLY, then unfold.
    //
    // The mark renders server-side fully open, so it is readable with no
    // JavaScript. Collapsing it on mount used to animate over 0.55s (the
    // same `grid-template-columns` transition the unfold uses), and because
    // this sits in the hero the IntersectionObserver fired on first paint —
    // so the first letter began reopening 220ms into a 550ms close, while
    // Reveal was still fading the whole block in. Three gestures at once:
    // the word expanded, contracted and re-expanded as the page appeared.
    //
    // `m-acr-instant` kills the transition for exactly one frame so the
    // collapse is a state change rather than an animation, and the unfold
    // is then the single deliberate movement the visitor sees.
    const node = ref.current;
    node?.classList.add("m-acr-instant");
    setOpen(LETTERS.map(() => false));
    const unlock = requestAnimationFrame(() => {
      requestAnimationFrame(() => node?.classList.remove("m-acr-instant"));
    });

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
              // Starts AFTER Reveal's 0.7s fade rather than against it, so
              // the block arrives first and then the word opens. Two
              // sequenced gestures read as intent; two overlapping ones
              // read as a glitch.
              }, 620 + i * STAGGER),
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
      cancelAnimationFrame(unlock);
    };
  }, []);

  /**
   * Click isolates a letter; clicking the isolated one restores the full
   * phrase, so there is always a way back to reading the whole thing.
   *
   * CLICK ONLY — NOT HOVER. Isolating a word changes the width of every
   * letter in the row, so a hover handler feeds back on itself: point at
   * "I", the row re-flows, a different letter slides under the cursor,
   * that fires its own hover, and the row re-flows again. Measured:
   * hovering the 4th letter reliably ended up opening the 5th. Keyboard
   * users get the same behaviour for free, because Enter and Space fire
   * click on a button.
   */
  const toggle = (i: number) => {
    setOpen((prev) => {
      const alreadyAlone = prev[i] && prev.filter(Boolean).length === 1;
      return LETTERS.map((_, j) => (alreadyAlone ? true : j === i));
    });
  };

  const allOpen = open.every(Boolean);

  return (
    <div ref={ref}>
      <div
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

      {/*
        Discoverability. With every word expanded by default there was
        nothing telling a visitor the letters were interactive, and once
        they had clicked one there was no visible route back to the whole
        phrase — the way out was "click the same letter again", which is
        not something anyone guesses.

        So: a permanent one-line hint that becomes the way back the moment
        it is needed. Hidden from assistive tech when it is only a hint,
        because a screen-reader user already has each word as a full label.
      */}
      <p className="mt-3 h-5 font-data text-[11px] tracking-[0.14em] text-fg-dim">
        {allOpen ? (
          <span aria-hidden="true">Click a letter to take it apart</span>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(LETTERS.map(() => true))}
            className="text-signal underline decoration-dotted underline-offset-4 transition-colors hover:text-fg"
          >
            Show the whole name
          </button>
        )}
      </p>
    </div>
  );
}
