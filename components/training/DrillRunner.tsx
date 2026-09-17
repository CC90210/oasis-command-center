"use client";

/**
 * The drill loop for one section.
 *
 * WHAT IT DOES NOT DO:
 *   - It does not grade anything a machine cannot grade. Every question here
 *     has one right answer out of four; there is no free text and therefore no
 *     pretended judgement. The objection trainer is where a rep writes their
 *     own words, and it is explicit there that nothing scores quality.
 *   - It does not block. A failed progress write is shown and the drill
 *     continues. Losing a tally is a nuisance; stopping a rep mid-practice
 *     because a counter did not save is worse than the counter.
 *
 * Colour marks right and wrong, which the battle card bans for LEADS and which
 * is correct here: a quiz answer being right is a fact about the answer, not a
 * verdict on a business.
 *
 * 🚨 THE FEEDBACK IS NOT DECORATION. Multiple choice WITHOUT per-option feedback
 * installs the distractors as false knowledge rather than correcting them: this
 * is the negative suggestion effect (Roediger & Marsh 2005), and it gets worse
 * the more options there are. Feedback is what reverses it (Butler & Roediger
 * 2008). So when a rep picks a wrong answer they are told why THAT one is
 * wrong, not only what the right one was. Removing that panel to tidy the
 * layout would make this screen worse than not drilling at all.
 *
 * KEYBOARD FIRST. 1/2/3 answers, Enter advances. It is the fastest way through
 * a drill and it is also WCAG 2.1.1, which is not optional.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { Card } from "@/components/Card";
import { buildTrainingSession, type TrainingDrill } from "@/lib/training/session";
import type { SectionSlug } from "@/lib/training/types";

const BTN = "rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white transition hover:opacity-90";
const GHOST =
  "rounded-md border border-bg-border px-3 py-1.5 text-sm font-medium text-fg-muted transition hover:border-accent/50 hover:text-fg";
const OPTION =
  "w-full rounded-md border px-3.5 py-3 text-left text-sm leading-relaxed transition disabled:cursor-default";

export function DrillRunner({
  sectionSlug,
  sectionTitle,
}: {
  sectionSlug: SectionSlug;
  sectionTitle: string;
}) {
  const [seed, setSeed] = useState(1);
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [score, setScore] = useState({ right: 0, wrong: 0 });
  const [saveError, setSaveError] = useState<string | null>(null);

  const session = useMemo(() => buildTrainingSession(sectionSlug, seed), [sectionSlug, seed]);
  const drill: TrainingDrill | undefined = session[index];

  const post = useCallback(async (body: Record<string, unknown>) => {
    try {
      const res = await fetch("/api/training/progress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      // A 2xx with an error payload is still a failure. 202 is not used here,
      // but checking the payload as well as res.ok is the habit that stops a
      // queued or refused write being rendered as a success.
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || payload.error) {
        setSaveError("Your progress did not save. Keep going, the drill still works.");
      }
    } catch {
      setSaveError("Your progress did not save. Keep going, the drill still works.");
    }
  }, []);

  const answer = useCallback(
    (optionId: string, correct: boolean) => {
      if (picked !== null || !drill) return;
      setPicked(optionId);
      setScore((s) => ({ right: s.right + (correct ? 1 : 0), wrong: s.wrong + (correct ? 0 : 1) }));
      // The server decides whether this was right. Sending a `correct` flag
      // would let a modified client award itself a perfect record, and a
      // manager reads these numbers.
      void post({ itemId: drill.itemId, sectionSlug: drill.section, chosenOptionId: optionId });
    },
    [picked, drill, post],
  );

  const next = useCallback(() => {
    if (!drill) return;
    const last = index + 1 >= session.length;
    if (last) {
      void post({
        kind: "completion",
        sectionSlug,
        rightCount: score.right,
        wrongCount: score.wrong,
      });
    }
    setPicked(null);
    setIndex((i) => i + 1);
  }, [drill, index, session.length, post, sectionSlug, score]);

  const again = useCallback(() => {
    setSeed((s) => s + 1);
    setIndex(0);
    setPicked(null);
    setScore({ right: 0, wrong: 0 });
  }, []);

  /** The option the rep actually chose, which is what the feedback is about. */
  const chosen = drill?.options.find((o) => o.id === picked) ?? null;

  /**
   * 1/2/3 to answer, Enter to move on.
   *
   * WCAG 2.1.1 requires every action be reachable from the keyboard, and the
   * buttons already satisfy that through tab order. This is the speed path on
   * top of it: a rep running a unit daily should not have to move a mouse.
   *
   * Digits are IGNORED once an answer is in, so a fast second keypress cannot
   * overwrite the choice, and Enter does nothing before one is made, so it
   * cannot skip a question unanswered.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!drill) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === "Enter" && picked !== null) {
        e.preventDefault();
        next();
        return;
      }
      if (picked !== null) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > drill.options.length) return;
      e.preventDefault();
      const option = drill.options[n - 1];
      answer(option.id, option.correct);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drill, picked, next, answer]);

  if (session.length === 0) {
    return (
      <Card title="Nothing to drill yet">
        <p className="text-sm text-fg-muted">
          This section is reading only for now. Work through it and move on.
        </p>
      </Card>
    );
  }

  if (!drill) {
    const total = score.right + score.wrong;
    return (
      <Card title="Done">
        <p className="font-mono text-3xl text-accent">
          {score.right}/{total}
        </p>
        <p className="mt-2 text-sm text-fg-muted">
          {score.wrong === 0
            ? "All of them. Go again in a day or two, not now: spacing is what makes it stick."
            : "Read back the ones you missed, then run it again. The explanation under each answer is the part that transfers."}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={BTN} onClick={again}>
            Go again, reshuffled
          </button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="whitespace-nowrap text-xs text-fg-muted">
          {index + 1} of {session.length}
        </span>
        <span className="h-1 flex-1 overflow-hidden rounded-full bg-bg-border">
          <span
            className="block h-full bg-accent transition-all"
            style={{ width: `${(index / session.length) * 100}%` }}
          />
        </span>
        <span className="whitespace-nowrap text-xs text-fg-dim">
          {score.right} right, {score.wrong} wrong
        </span>
      </div>

      {saveError && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-fg">{saveError}</p>
      )}

      <Card title={sectionTitle}>
        <p className="text-base font-semibold leading-snug text-fg">{drill.stem}</p>

        <ul className="mt-4 space-y-2">
          {drill.options.map((o, i) => {
            const show = picked !== null;
            const tone = !show
              ? "border-bg-border bg-bg-raised text-fg hover:border-accent/50"
              : o.correct
                ? "border-emerald-500/60 bg-emerald-500/5 text-fg"
                : o.id === picked
                  ? "border-rose-500/60 bg-rose-500/5 text-fg"
                  : "border-bg-border bg-bg-raised text-fg opacity-60";
            return (
              <li key={o.id}>
                <button
                  type="button"
                  disabled={show}
                  className={`${OPTION} ${tone}`}
                  onClick={() => answer(o.id, o.correct)}
                >
                  {/* The number is the keyboard shortcut, shown so it can be
                      discovered rather than documented somewhere nobody reads.
                      aria-hidden because a screen reader user reaches these by
                      tab order, where a spoken "1" before every option is
                      noise rather than help. */}
                  <span
                    aria-hidden="true"
                    className="mr-2 inline-block min-w-[1.25rem] rounded border border-bg-border px-1 text-center font-mono text-xs text-fg-dim"
                  >
                    {i + 1}
                  </span>
                  {o.text}
                  {show && o.correct && (
                    <span className="ml-2 text-xs font-semibold text-emerald-500">correct</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        {picked !== null && (
          <div className="mt-4 space-y-3 border-t border-bg-border pt-3">
            {/* The chosen wrong answer, explained. This block is the reason the
                drill teaches instead of merely testing, so it comes FIRST:
                a rep who got it wrong reads one thing, and it should be the
                thing about the mistake they just made. */}
            {chosen && !chosen.correct && chosen.whyWrong && (
              <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-3 py-2.5">
                <p className="text-[11px] font-medium uppercase tracking-wider text-rose-400">
                  Why that one is wrong
                </p>
                <p className="mt-1 text-sm leading-relaxed text-fg">{chosen.whyWrong}</p>
                {chosen.realError && (
                  <p className="mt-2 text-xs leading-relaxed text-fg-dim">
                    The mistake: {chosen.realError}
                  </p>
                )}
              </div>
            )}

            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-accent">
                {chosen && !chosen.correct ? "The right answer" : "Why"}
              </p>
              {chosen && !chosen.correct && (
                <p className="mt-1 text-sm font-medium leading-relaxed text-fg">{drill.answer}</p>
              )}
              <p className="mt-1 text-sm leading-relaxed text-fg-muted">{drill.whyRight}</p>
            </div>

            {/* Where it came from, and how much weight it carries. A rep who
                wants depth should know which document to open, and an item
                whose source is "ours" is Oasis policy rather than a finding
                from a book, which is a difference worth seeing. */}
            <p className="text-xs text-fg-dim">
              {drill.source}
              {drill.provenance === "directional" && " · treat the direction, not the figure"}
              {drill.provenance === "ours" && " · Oasis policy, not from a book"}
            </p>

            <button type="button" className={BTN} onClick={next}>
              {index + 1 === session.length ? "Finish" : "Next"}
            </button>
          </div>
        )}
      </Card>

      <button type="button" className={GHOST} onClick={again}>
        Restart this drill
      </button>
    </div>
  );
}
