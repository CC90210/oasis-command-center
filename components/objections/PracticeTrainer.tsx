"use client";

/**
 * The drill loop.
 *
 * WHAT IT DOES NOT DO, stated rather than implied:
 *   - It does not score whether an answer is any GOOD. The mechanical rules,
 *     a price, a dash, an empty box, are checked and stated as facts. Whether
 *     a sentence would land on a real call needs a human ear, and a pretend
 *     score would be worse than none: a rep told they scored nine out of ten
 *     on a line that would die in the field has been taught the wrong lesson
 *     with confidence. The self-check asks instead of marking.
 *   - It does not report anywhere. Progress is in this browser only. Nobody
 *     is watching, which is the point: a rep practises badly in private or
 *     not at all, and a trainer that reported would just become a metric.
 *
 * Colour IS used for right and wrong here. The battle card bans colour keyed
 * to a judgement because judging a LEAD by hue puts a rep in a frame before
 * they have spoken to anyone. A quiz answer being right or wrong is a fact
 * about the answer, not a verdict on a business, and hiding it would make the
 * drill harder to read for no gain.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { Card, EmptyState } from "@/components/Card";
import {
  DRILL_KINDS,
  DRILL_TEACHES,
  DRILL_TITLE,
  SELF_CHECKS,
  buildSession,
  checkSpokenAnswer,
  type DrillKind,
  type PracticeObjection,
} from "@/lib/web-leads/objections/practice";

const BTN =
  "rounded-md border border-bg-border px-3 py-1.5 text-sm font-medium text-fg-muted transition hover:border-accent/50 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";
const BTN_ON = "rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90";
const OPTION =
  "w-full rounded-md border border-bg-border bg-bg-raised px-3.5 py-3 text-left text-sm leading-relaxed text-fg transition hover:border-accent/50 disabled:cursor-default";
const LABEL = "text-[11px] font-medium uppercase tracking-wider text-accent";

const PROGRESS_KEY = "objection-practice-v1";

type Progress = Record<string, { right: number; wrong: number }>;

function loadProgress(): Progress {
  try {
    return (JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}") as Progress) || {};
  } catch {
    return {};
  }
}

function saveProgress(p: Progress) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {
    /* a private window or blocked storage must not break the drill */
  }
}

export function PracticeTrainer({
  pool,
  readError,
}: {
  pool: PracticeObjection[];
  readError: string | null;
}) {
  const [kinds, setKinds] = useState<DrillKind[]>(["meaning", "prevent", "move", "your_words"]);
  const [seed, setSeed] = useState(1);
  const [started, setStarted] = useState(false);
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [selfChecked, setSelfChecked] = useState<string[]>([]);
  const [score, setScore] = useState({ right: 0, wrong: 0 });
  const [progress, setProgress] = useState<Progress>({});

  useEffect(() => {
    setProgress(loadProgress());
  }, []);

  const session = useMemo(
    () => (pool.length > 0 && kinds.length > 0 ? buildSession(pool, kinds, seed) : []),
    [pool, kinds, seed],
  );
  const drill = session[index];
  const spoken = useMemo(() => (drill?.kind === "your_words" ? checkSpokenAnswer(typed) : null), [drill, typed]);

  const record = useCallback((slug: string, right: boolean) => {
    setProgress((prev) => {
      const row = prev[slug] ?? { right: 0, wrong: 0 };
      const nextRow = right ? { ...row, right: row.right + 1 } : { ...row, wrong: row.wrong + 1 };
      const next = { ...prev, [slug]: nextRow };
      saveProgress(next);
      return next;
    });
  }, []);

  const answer = useCallback(
    (optionId: string, correct: boolean) => {
      if (picked !== null || !drill) return;
      setPicked(optionId);
      setRevealed(true);
      setScore((s) => ({ right: s.right + (correct ? 1 : 0), wrong: s.wrong + (correct ? 0 : 1) }));
      record(drill.slug, correct);
    },
    [picked, drill, record],
  );

  const next = useCallback(() => {
    setPicked(null);
    setTyped("");
    setRevealed(false);
    setSelfChecked([]);
    setIndex((i) => i + 1);
  }, []);

  const restart = useCallback(() => {
    setSeed((s) => s + 1);
    setIndex(0);
    setPicked(null);
    setTyped("");
    setRevealed(false);
    setSelfChecked([]);
    setScore({ right: 0, wrong: 0 });
    setStarted(true);
  }, []);

  if (readError) {
    return (
      <Card title="The objections could not be loaded">
        <p className="text-sm text-fg-muted">
          This is empty because the read failed, not because there is nothing to practise. Reload, and if it keeps
          failing say so rather than assuming the library is empty.
        </p>
      </Card>
    );
  }

  if (pool.length === 0) {
    return (
      <EmptyState message="No objection has an approved answer yet, so there is nothing to drill. Approve some under Objections first." />
    );
  }

  // ---- the setup screen ----
  if (!started) {
    const weakest = Object.entries(progress)
      .filter(([, v]) => v.wrong > 0)
      .sort((a, b) => b[1].wrong - a[1].wrong)
      .slice(0, 3);

    return (
      <div className="space-y-4">
        <Card
          title="What do you want to drill?"
          subtitle="Every objection comes up once per type you pick. The whole set, not a sample, because the ones you avoid are the ones you need."
        >
          <div className="space-y-2">
            {DRILL_KINDS.map((k) => (
              <label key={k} className="flex cursor-pointer items-start gap-3 rounded-md border border-bg-border p-3">
                <input
                  type="checkbox"
                  id={`kind-${k}`}
                  className="mt-1 h-4 w-4 accent-accent"
                  checked={kinds.includes(k)}
                  onChange={(e) =>
                    setKinds((prev) => (e.target.checked ? [...prev, k] : prev.filter((x) => x !== k)))
                  }
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-fg">{DRILL_TITLE[k]}</span>
                  <span className="block text-xs leading-relaxed text-fg-muted">{DRILL_TEACHES[k]}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" className={BTN_ON} disabled={kinds.length === 0} onClick={() => setStarted(true)}>
              Start {pool.length * kinds.length} questions
            </button>
            <span className="text-xs text-fg-dim">Nobody sees your answers. This stays in your browser.</span>
          </div>
        </Card>

        {weakest.length > 0 && (
          <Card title="Worth a look" subtitle="The ones you have got wrong most often on this machine.">
            <ul className="space-y-1">
              {weakest.map(([slug, v]) => (
                <li key={slug} className="flex items-center justify-between text-sm">
                  <span className="font-mono text-xs text-fg-muted">{slug}</span>
                  <span className="text-xs text-fg-dim">
                    {v.right} right, {v.wrong} wrong
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    );
  }

  // ---- the end screen ----
  if (!drill) {
    const total = score.right + score.wrong;
    return (
      <Card title="Done">
        <p className="text-sm text-fg">
          {total === 0
            ? "Nothing scored that round."
            : `${score.right} of ${total} on the ones with a right answer.`}
        </p>
        <p className="mt-2 text-sm text-fg-muted">
          The typed rounds are not scored, and that is deliberate. Whether a sentence would land needs an ear, not a
          checker. Read yours back out loud before you decide it was good.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={BTN_ON} onClick={restart}>
            Go again, reshuffled
          </button>
          <button type="button" className={BTN} onClick={() => setStarted(false)}>
            Change what I drill
          </button>
        </div>
      </Card>
    );
  }

  // ---- a question ----
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium text-fg-muted">
          {index + 1} of {session.length}
        </span>
        <span className="h-1 flex-1 overflow-hidden rounded-full bg-bg-border">
          <span
            className="block h-full bg-accent transition-all"
            style={{ width: `${(index / session.length) * 100}%` }}
          />
        </span>
        <span className="text-xs text-fg-dim">
          {score.right} right, {score.wrong} wrong
        </span>
      </div>

      <Card title={DRILL_TITLE[drill.kind]}>
        <p className="text-[11px] uppercase tracking-wider text-fg-dim">They say</p>
        <p className="mt-1 text-lg font-semibold leading-snug text-fg">&ldquo;{drill.says}&rdquo;</p>

        {drill.options && (
          <ul className="mt-4 space-y-2">
            {drill.options.map((o) => {
              const isPicked = picked === o.id;
              const show = picked !== null;
              const tone = !show
                ? "border-bg-border"
                : o.correct
                  ? "border-emerald-500/60 bg-emerald-500/5"
                  : isPicked
                    ? "border-rose-500/60 bg-rose-500/5"
                    : "border-bg-border opacity-60";
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    disabled={show}
                    className={`${OPTION} ${tone}`}
                    onClick={() => answer(o.id, o.correct)}
                  >
                    {o.text}
                    {show && o.correct && <span className="ml-2 text-xs font-semibold text-emerald-500">correct</span>}
                    {show && isPicked && !o.correct && (
                      <span className="ml-2 text-xs font-semibold text-rose-500">not this one</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {drill.kind === "your_words" && (
          <div className="mt-4">
            <label htmlFor="your-answer" className={LABEL}>
              Say it out loud first, then type what you said
            </label>
            <textarea
              id="your-answer"
              className="mt-1.5 min-h-28 w-full rounded-md border border-bg-border bg-bg-raised px-3 py-2 text-sm leading-relaxed text-fg placeholder:text-fg-dim focus:border-accent/60 focus:outline-none"
              placeholder="In your own words, the way you would actually say it."
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={revealed}
            />

            {spoken && spoken.blocking.length > 0 && (
              <ul className="mt-2 space-y-1">
                {spoken.blocking.map((b) => (
                  <li key={b} className="text-xs text-rose-500">
                    {b}
                  </li>
                ))}
              </ul>
            )}
            {spoken && spoken.notes.length > 0 && (
              <ul className="mt-2 space-y-1">
                {spoken.notes.map((n) => (
                  <li key={n} className="text-xs text-fg-muted">
                    {n}
                  </li>
                ))}
              </ul>
            )}

            {!revealed && (
              <button
                type="button"
                className={`${BTN_ON} mt-3`}
                disabled={typed.trim().length === 0 || (spoken?.blocking.length ?? 0) > 0}
                onClick={() => setRevealed(true)}
              >
                Show me how it has been done
              </button>
            )}

            {revealed && (
              <div className="mt-4 border-t border-bg-border pt-3">
                <p className={LABEL}>Now mark your own, honestly</p>
                <ul className="mt-2 space-y-1.5">
                  {SELF_CHECKS.map((c) => (
                    <li key={c.id} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        id={`self-${c.id}`}
                        className="mt-0.5 h-3.5 w-3.5 accent-accent"
                        checked={selfChecked.includes(c.id)}
                        onChange={(e) =>
                          setSelfChecked((prev) =>
                            e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id),
                          )
                        }
                      />
                      <label htmlFor={`self-${c.id}`} className="cursor-pointer text-xs leading-relaxed text-fg-muted">
                        {c.ask}
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] leading-relaxed text-fg-dim">
                  Nothing marks these but you. A checker cannot hear whether a sentence would land, and a score that
                  pretended to would teach you the wrong thing with confidence.
                </p>
              </div>
            )}
          </div>
        )}

        {revealed && (
          <div className="mt-4 space-y-3 border-t border-bg-border pt-3">
            {drill.reveal.map((r) => (
              <div key={r.label}>
                <p className={LABEL}>{r.label}</p>
                <p className="mt-1 text-sm leading-relaxed text-fg-muted">{r.text}</p>
              </div>
            ))}
            <button type="button" className={BTN_ON} onClick={next}>
              {index + 1 === session.length ? "Finish" : "Next"}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
