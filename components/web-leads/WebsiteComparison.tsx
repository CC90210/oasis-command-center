"use client";

/**
 * WebsiteComparison — the website-score half of the lead detail panel, and
 * (2026-08-23 revamp) its HERO: mounted directly under the call/website
 * actions in WebLeadDetail.tsx, ahead of the address/industry metadata, with
 * its own larger type scale, so a rep's eye lands on the score and the gap
 * list first -- exactly what they read mid-call. Fetches
 * GET /api/web-leads/[id]/audit (lib/web-leads/audit.ts) and renders one of
 * its four honest states.
 *
 * THE RULE THAT OUTRANKS THE UI (see audit.ts's header comment): a site we
 * could not reach is NEVER given a score, and the three non-scored states
 * render as SENTENCES, never as numbers, never as an empty space. Nothing
 * has verified these websites except our own crawler -- a site we could not
 * reach may be perfectly good, and if a rep reads a fabricated finding aloud
 * to a stranger on a live call, that is the worst thing this system can do.
 * So, deliberately, nowhere in this file: a badge that shortens a phrase
 * into a verdict, a red/green colour keyed to a score, an icon that reads as
 * a judgement, or a tooltip more confident than the text. The dimension bars
 * below fill with ONE neutral colour regardless of score, on purpose, and
 * the composite number itself is rendered in the page's plain foreground
 * colour (with an ambient glow for hero weight) rather than any hue that
 * could be misread as "this one's good" -- the same glow renders identically
 * whether the score is 4 or 94.
 *
 * Uses the same `alive`-after-body-parse fetch pattern as WebLeadDetail.tsx
 * (and WebLeadsBrowser.tsx before it) so a slow response for lead A can
 * never land after a faster response for lead B and overwrite it.
 */

import { useEffect, useState } from "react";
// Type-only: lib/web-leads/audit.ts imports getServiceSupabase() (next/headers,
// server-only). A value import here would pull that whole module into the
// client bundle and fail the build -- same reasoning WebLeadsBrowser.tsx
// documents for lib/web-leads/data.ts's PAGE_SIZE.
import type { AuditResult, CheckResult, DimensionProfile } from "@/lib/web-leads/audit";
import { remedyFor } from "@/lib/web-leads/remedies";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/** "Costs them:" / "We'd fix it:" -- the two lines a rep reads aloud. Renders
 * nothing (not an empty bullet, not "undefined") when a code has no entry. */
function RemedyLines({ code }: { code: string }) {
  const remedy = remedyFor(code);
  if (!remedy) return null;
  return (
    <div className="mt-1.5 space-y-1 text-xs text-fg-dim">
      <p><span className="font-medium text-fg-muted">Costs them:</span> {remedy.costs}</p>
      <p><span className="font-medium text-fg-muted">We&apos;d fix it:</span> {remedy.fix}</p>
    </div>
  );
}

/** Failed checks across every dimension, largest `points` first, top four.
 * Pulled from `checks` (which carries the label needed to render), not from
 * a dimension's `missing` (codes only). */
function biggestGaps(dimensions: DimensionProfile[]): CheckResult[] {
  return dimensions
    .flatMap((d) => d.checks.filter((c) => !c.has))
    .sort((a, b) => b.points - a.points)
    .slice(0, 4);
}

/** Fixed-colour fill -- see the module header for why this never varies by score. */
function ScoreBar({ score }: { score: number }) {
  const pct = Math.min(100, Math.max(0, score));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-border">
      <div className="h-full rounded-full bg-fg-dim" style={{ width: `${pct}%` }} />
    </div>
  );
}

function HeroSkeleton() {
  return (
    <div className="mt-6 space-y-3 border-t border-bg-border pt-5" aria-busy="true" aria-live="polite">
      <div className="h-3 w-28 rounded bg-bg-deep animate-pulse-slow" />
      <div className="h-12 w-28 rounded bg-bg-deep animate-pulse-slow" />
      <div className="h-3 w-40 rounded bg-bg-deep/70 animate-pulse-slow" />
    </div>
  );
}

export function WebsiteComparison({ leadId }: { leadId: string }) {
  const [audit, setAudit] = useState<AuditResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setAudit(null);
    setError(null);
    // Same invariant as WebLeadDetail.tsx: `alive` is re-checked AFTER the
    // body is parsed, not right after the fetch resolves, so a slow body for
    // an earlier leadId can't win a race against a faster body for a newer one.
    fetch(`/api/web-leads/${encodeURIComponent(leadId)}/audit`)
      .then(async (r) => {
        if (!r.ok) {
          if (alive) setError("Could not load website score.");
          return;
        }
        const body = await r.json();
        if (alive) setAudit(body);
      })
      .catch(() => { if (alive) setError("Could not load website score."); });
    return () => { alive = false; };
  }, [leadId]);

  if (error) {
    return <p className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">{error}</p>;
  }

  if (!audit) {
    return <HeroSkeleton />;
  }

  if (audit.state === "no_website") {
    return (
      <div className="mt-6 border-t border-bg-border pt-5">
        <p className="text-sm text-fg-muted">No website found yet, needs checking</p>
      </div>
    );
  }

  if (audit.state === "not_scored") {
    return (
      <div className="mt-6 border-t border-bg-border pt-5">
        <p className="text-sm text-fg-muted">Not scored yet.</p>
      </div>
    );
  }

  if (audit.state === "unreachable") {
    return (
      <div className="mt-6 border-t border-bg-border pt-5">
        <p className="text-sm text-fg-muted">We could not check this site.</p>
        {/* The reason is for us -- not a claim about them -- so it stays small and muted. */}
        <p className="mt-1 text-xs text-fg-faint">{audit.reason}</p>
      </div>
    );
  }

  // audit.state === "scored"
  const gaps = biggestGaps(audit.dimensions);

  return (
    <div className="mt-6 space-y-6 border-t border-bg-border pt-5">
      {/* Headline -- the hero. */}
      <div>
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">Website score</p>
            <p className="mt-1 text-6xl font-bold leading-none tracking-tight tabular-nums text-fg drop-shadow-[0_0_18px_rgba(59,130,246,0.28)]">
              {audit.composite}
            </p>
          </div>
          {/* Benchmark column only when the payload actually carries one --
              default off (WEBDEV_SHOW_BENCHMARK), usually absent. */}
          {audit.benchmark && (
            <div className="pb-1 text-right">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">Our sites</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-fg-dim">{audit.benchmark.ourComposite}</p>
            </div>
          )}
        </div>
        <p className="mt-2 text-xs text-fg-dim">Measured {formatDate(audit.measuredAt)}</p>
      </div>

      {/* Biggest gaps -- the script a rep reads aloud, most prominent after the score. */}
      {gaps.length > 0 && (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">Biggest gaps</p>
          <ul className="mt-2 space-y-2">
            {gaps.map((check) => (
              <li key={check.code} className="rounded-md border border-bg-border bg-bg-deep/50 p-3">
                <p className="text-sm font-semibold text-fg">{check.label}</p>
                <RemedyLines code={check.code} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Seven dimensions */}
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">Dimensions</p>
        <div className="mt-2 space-y-2.5">
          {audit.dimensions.map((d) => (
            <div key={d.key}>
              <div className="flex items-center justify-between text-xs text-fg-muted">
                <span>{d.label}</span>
                <span className="tabular-nums text-fg-dim">{d.score}</span>
              </div>
              <div className="mt-1"><ScoreBar score={d.score} /></div>
            </div>
          ))}
        </div>
      </div>

      {/* All 49 checks -- collapsed by default. */}
      <details className="rounded-md border border-bg-border">
        <summary className="cursor-pointer select-none rounded-md px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70">
          All checks
        </summary>
        <div className="divide-y divide-bg-border border-t border-bg-border px-3">
          {audit.dimensions.map((d) => (
            <div key={d.key} className="py-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-fg-dim">{d.label}</p>
              <ul className="mt-1.5 space-y-2">
                {d.checks.map((check) => (
                  <li key={check.code} className="text-sm text-fg-muted">
                    <span className="text-fg-dim">{check.has ? "Pass" : "Fail"}</span> - {check.label}
                    {!check.has && <RemedyLines code={check.code} />}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
