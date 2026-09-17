"use client";

/**
 * The practice call.
 *
 * WHAT IT DOES NOT DO:
 *   - It does not score the call. The debrief is an opinion from a model and
 *     is labelled as one. Nothing here writes to a rep's training record, and
 *     that is deliberate: a manager reading "failed three practice calls" would
 *     be reading a number nobody can defend.
 *   - It does not let a rep choose the owner's personality beyond picking a
 *     scenario. The persona lives on the server.
 *
 * A 202 means the model is still working, and it is handled explicitly rather
 * than through `res.ok`, which counts 202 as success and would render a
 * pending reply as an empty owner turn.
 */

import { useCallback, useRef, useState } from "react";

import { Card } from "@/components/Card";
import type { RoleplayScenario } from "@/lib/training/roleplay/scenarios";

const BTN = "rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-40";
const GHOST =
  "rounded-md border border-bg-border px-3 py-1.5 text-sm font-medium text-fg-muted transition hover:border-accent/50 hover:text-fg disabled:opacity-40";

type Turn = { role: "rep" | "owner"; text: string };
type Debrief = { verdict: string; didWell: string[]; missed: string[]; nextTime: string };

export function RoleplayCall({ scenario }: { scenario: RoleplayScenario }) {
  const [transcript, setTranscript] = useState<Turn[]>([]);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<Debrief | null>(null);
  const [violations, setViolations] = useState<string[]>([]);
  /**
   * The transcript whose owner turn did not arrive.
   *
   * The inference seam queues and polls, and reports "still thinking" when it
   * runs past its window. The queued job is keyed on the EXACT prompt, so the
   * only way to collect it is to resend the identical transcript. Without this
   * the rep's next line made a different transcript, a different key, and the
   * finished reply was orphaned: on a slow model the call simply broke with no
   * way forward.
   */
  const [retryable, setRetryable] = useState<Turn[] | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  /**
   * One request, with the reason it failed when it did.
   *
   * The reason matters: "still thinking" means a queued job exists and the
   * identical transcript will collect it, while every other failure means
   * nothing is coming. An earlier version returned null for both and locked the
   * input on either, which turned an ordinary error into a call the rep could
   * not continue OR abandon. That was worse than the bug it was fixing.
   */
  const call = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch("/api/training/roleplay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        reply?: string;
        ended?: boolean;
        debrief?: Debrief;
        error?: string;
        message?: string;
        violations?: string[];
      };
      // 202 is "still working", and fetch counts it as ok. Checking the payload
      // as well is what stops a pending reply rendering as an empty turn.
      if (!res.ok || payload.error) {
        setNotice(payload.message || "That did not go through.");
        setViolations(Array.isArray(payload.violations) ? payload.violations : []);
        return { ok: false as const, reason: payload.error ?? "failed" };
      }
      setNotice(null);
      setViolations([]);
      return { ok: true as const, payload };
    },
    [],
  );

  const send = useCallback(async () => {
    const said = typed.trim();
    // `retryable` blocks a new line, and that is the whole point of it. Adding
    // a retry button was not enough on its own: a rep who typed again instead
    // of retrying built a different transcript, which replaced the one key that
    // could collect the queued reply, and the stalled turn was orphaned anyway.
    // The pending turn has to resolve before the call can move.
    if (!said || busy || ended || retryable) return;
    const next: Turn[] = [...transcript, { role: "rep", text: said }];
    setTranscript(next);
    setTyped("");
    setBusy(true);
    try {
      const out = await call({ scenarioId: scenario.id, transcript: next });
      if (out.ok && out.payload.reply) {
        setTranscript((t) => [...t, { role: "owner", text: out.payload.reply as string }]);
        setRetryable(null);
        if (out.payload.ended) setEnded(true);
      } else if (!out.ok && out.reason === "owner_thinking") {
        // ONLY a queued reply locks the call. The rep's line stays on screen,
        // because they did say it, and collecting the answer needs this exact
        // transcript. Every other failure leaves the call usable: nothing is
        // coming, so there is nothing to protect.
        setRetryable(next);
      }
    } finally {
      setBusy(false);
      requestAnimationFrame(() => bottom.current?.scrollIntoView({ behavior: "smooth" }));
    }
  }, [typed, busy, ended, retryable, transcript, call, scenario.id]);

  const retry = useCallback(async () => {
    if (!retryable || busy) return;
    setBusy(true);
    try {
      const out = await call({ scenarioId: scenario.id, transcript: retryable });
      if (out.ok && out.payload.reply) {
        setTranscript((t) => [...t, { role: "owner", text: out.payload.reply as string }]);
        setRetryable(null);
        if (out.payload.ended) setEnded(true);
      } else if (!out.ok && out.reason !== "owner_thinking") {
        // It is not coming. Release the call so the rep can carry on or start
        // again, rather than leaving them stuck on a retry that never resolves.
        setRetryable(null);
      }
    } finally {
      setBusy(false);
    }
  }, [retryable, busy, call, scenario.id]);

  const getReview = useCallback(async () => {
    setBusy(true);
    try {
      const out = await call({ scenarioId: scenario.id, transcript, kind: "debrief" });
      if (out.ok && out.payload.debrief) {
        setReview(out.payload.debrief);
        // Asking for the review ENDS the call. Leaving it open left the box
        // live while a now-stale review sat underneath it, and the button to
        // regenerate had disappeared, so a rep could keep talking to a review
        // that no longer described the conversation.
        setEnded(true);
        setRetryable(null);
      }
    } finally {
      setBusy(false);
    }
  }, [call, scenario.id, transcript]);

  const restart = useCallback(() => {
    setTranscript([]);
    setTyped("");
    setEnded(false);
    setReview(null);
    setNotice(null);
    setViolations([]);
    setRetryable(null);
  }, []);

  return (
    <div className="space-y-4">
      <Card title={scenario.business} subtitle={scenario.trade}>
        <p className="text-[11px] font-medium uppercase tracking-wider text-accent">What you can see before you ring</p>
        <ul className="mt-1.5 space-y-1">
          {scenario.visible.map((v) => (
            <li key={v} className="flex gap-2 text-sm leading-relaxed text-fg-muted">
              <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-fg-dim" />
              <span>{v}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-fg-dim">
          This business is invented. Nothing you type here touches a real lead.
        </p>
      </Card>

      <div className="space-y-3">
        {transcript.length === 0 && (
          <p className="text-sm text-fg-muted">They have picked up. Say your opening line.</p>
        )}
        {transcript.map((t, i) => (
          <div
            key={i}
            className={
              t.role === "rep"
                ? "ml-auto max-w-[85%] rounded-lg rounded-br-sm bg-accent/10 px-3.5 py-2.5"
                : "mr-auto max-w-[85%] rounded-lg rounded-bl-sm border border-bg-border bg-bg-raised px-3.5 py-2.5"
            }
          >
            <p className="text-[10px] font-medium uppercase tracking-wider text-fg-dim">
              {t.role === "rep" ? "You" : scenario.business}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-fg">{t.text}</p>
          </div>
        ))}
        {busy && <p className="text-xs text-fg-dim">...</p>}
        <div ref={bottom} />
      </div>

      {notice && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-fg">
          {notice}
          {violations.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {violations.map((v) => (
                <li key={v} className="text-xs text-fg-muted">
                  {v}
                </li>
              ))}
            </ul>
          )}
          {retryable && (
            <button type="button" className={`${GHOST} mt-2`} disabled={busy} onClick={retry}>
              Try that again
            </button>
          )}
        </div>
      )}

      {ended && !review && (
        <p className="text-sm font-medium text-fg">That call is over.</p>
      )}

      {!ended && (
        <div>
          <textarea
            id="rep-line"
            className="min-h-20 w-full rounded-md border border-bg-border bg-bg-raised px-3 py-2 text-sm leading-relaxed text-fg placeholder:text-fg-dim focus:border-accent/60 focus:outline-none"
            placeholder="What you say next. Out loud first, then type it."
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={busy || Boolean(retryable)}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BTN}
              disabled={busy || Boolean(retryable) || typed.trim().length === 0}
              onClick={send}
            >
              {busy ? "..." : "Say it"}
            </button>
            <span className="text-xs text-fg-dim">
              {retryable
                ? "They have not answered yet. Try that again before you say anything else."
                : "Cmd or Ctrl and Enter"}
            </span>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {transcript.some((t) => t.role === "rep") && !review && (
          // Disabled while a turn is pending. Reviewing would build a debrief
          // from a transcript ending on an unanswered line, clear the retry,
          // and orphan the queued reply, which is the same bypass by a
          // different button.
          <button
            type="button"
            className={GHOST}
            disabled={busy || Boolean(retryable)}
            onClick={getReview}
          >
            {ended ? "How did that go?" : "End the call and review it"}
          </button>
        )}
        {transcript.length > 0 && (
          <button type="button" className={GHOST} disabled={busy} onClick={restart}>
            Start over
          </button>
        )}
      </div>

      {review && (
        <Card title="How that went">
          <p className="text-sm font-semibold leading-relaxed text-fg">{review.verdict}</p>

          {review.didWell.length > 0 && (
            <div className="mt-4">
              <p className="text-[11px] font-medium uppercase tracking-wider text-accent">What worked</p>
              <ul className="mt-1.5 space-y-1">
                {review.didWell.map((s) => (
                  <li key={s} className="text-sm leading-relaxed text-fg-muted">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {review.missed.length > 0 && (
            <div className="mt-4">
              <p className="text-[11px] font-medium uppercase tracking-wider text-accent">What you missed</p>
              <ul className="mt-1.5 space-y-1">
                {review.missed.map((s) => (
                  <li key={s} className="text-sm leading-relaxed text-fg-muted">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 border-l-2 border-accent/30 pl-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-accent">Next time</p>
            <p className="mt-1 text-sm leading-relaxed text-fg">{review.nextTime}</p>
          </div>

          <p className="mt-4 text-[11px] leading-relaxed text-fg-dim">
            This is one opinion from a machine that was not on the call. It is not a score, nothing is recorded
            against you, and no manager sees it. If it says something that does not match what you know about
            selling, trust yourself and say so.
          </p>
        </Card>
      )}
    </div>
  );
}
