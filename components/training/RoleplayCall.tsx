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
  const bottom = useRef<HTMLDivElement>(null);

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
        return null;
      }
      setNotice(null);
      setViolations([]);
      return payload;
    },
    [],
  );

  const send = useCallback(async () => {
    const said = typed.trim();
    if (!said || busy || ended) return;
    const next: Turn[] = [...transcript, { role: "rep", text: said }];
    setTranscript(next);
    setTyped("");
    setBusy(true);
    try {
      const out = await call({ scenarioId: scenario.id, transcript: next });
      if (out?.reply) {
        setTranscript((t) => [...t, { role: "owner", text: out.reply as string }]);
        if (out.ended) setEnded(true);
      }
    } finally {
      setBusy(false);
      requestAnimationFrame(() => bottom.current?.scrollIntoView({ behavior: "smooth" }));
    }
  }, [typed, busy, ended, transcript, call, scenario.id]);

  const getReview = useCallback(async () => {
    setBusy(true);
    try {
      const out = await call({ scenarioId: scenario.id, transcript, kind: "debrief" });
      if (out?.debrief) setReview(out.debrief);
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
            disabled={busy}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className={BTN} disabled={busy || typed.trim().length === 0} onClick={send}>
              {busy ? "..." : "Say it"}
            </button>
            <span className="text-xs text-fg-dim">Cmd or Ctrl and Enter</span>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {transcript.some((t) => t.role === "rep") && !review && (
          <button type="button" className={GHOST} disabled={busy} onClick={getReview}>
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
