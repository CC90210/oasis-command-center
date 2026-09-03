"use client";

/**
 * PresenceBlock — the "Beyond the website" section's content: the online-
 * presence evaluation (phase 2 of scoring-v2; Adon: "we're an automation
 * company that could really enhance your overall online presence").
 *
 * RENDERS AT THE CONTAINER LEVEL of the battle card, not inside ScoredBody:
 * a lead with no website / an unreachable site / a hidden score is exactly
 * the lead whose presence IS the pitch, and ScoredBody never renders for
 * those states.
 *
 * THE HONESTY STATES, in order:
 *   - none            "Not measured yet" + the card has already asked the
 *                     worker for one (auto-enqueue in BattleCard); nothing
 *                     is invented in the meantime.
 *   - measured        pillars with real check rows and measured sentences
 *                     (presence-evidence.ts); an UNMEASURED pillar inside a
 *                     measured blob renders one honest sentence, never
 *                     thirteen failed rows.
 *   - stale           measured, but old: rendered with its date and a note
 *                     that a refresh has been requested.
 *
 * COLOUR RULES UNCHANGED: pillar hues are IDENTITY (battle-hud PILLAR_HUES,
 * distinct from every website dimension hue); no colour is keyed to a
 * score; this file sits in the verdict-colour ban list like every other
 * surface in the feature.
 */

import { useMemo } from "react";
import type { OnlinePresence, PresencePillar } from "@/lib/web-leads/presence";
import { presenceLine } from "@/lib/web-leads/presence-evidence";
import { pillarHueFor } from "./battle-hud";

function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "an unknown date";
  return new Date(t).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function PillarGroup({ pillar, blob }: { pillar: PresencePillar; blob: NonNullable<Extract<OnlinePresence, { state: "measured" }>>["blob"] }) {
  const hue = pillarHueFor(pillar.key);
  return (
    <div className="rounded-lg border border-bg-border bg-bg-raised/50 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-fg [font-family:var(--battle-display)]">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: hue.to, boxShadow: `0 0 6px ${hue.to}` }} />
          {pillar.label}
        </p>
        {pillar.score === null ? (
          <p className="text-xs text-fg-muted">Not measured yet</p>
        ) : (
          <p className="text-xs text-fg-muted">
            Scores <span className="tabular-nums text-fg [font-family:var(--battle-data)]">{pillar.score}</span>
          </p>
        )}
      </div>
      {pillar.score === null ? (
        // One honest sentence for the whole pillar, never a column of
        // fabricated failures. Which sentence depends on WHY it is
        // unmeasured, and today there is exactly one deliberate case.
        <p className="mt-2 text-xs leading-relaxed text-fg-dim">
          {pillar.key === "social"
            ? "The links themselves are on file, but checking them respectfully needs a method the platforms allow; until then this is not scored."
            : "This part has not been measured for this business yet."}
        </p>
      ) : (
        <ul className="mt-2.5 space-y-2">
          {pillar.checks.map((c) => {
            const line = presenceLine(c.code, blob);
            return (
              <li key={c.code} className="text-xs leading-relaxed">
                <span className="flex items-start gap-1.5">
                  {/* Pass/fail as SHAPE (filled dot vs ring), never colour --
                      the same greyscale-survivable coding OpeningHours uses. */}
                  <span
                    aria-hidden
                    className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${c.has ? "bg-fg-muted" : "border border-fg-dim/60"}`}
                  />
                  <span className="min-w-0">
                    <span className={c.has ? "font-medium text-fg-muted" : "font-medium text-fg"}>{c.label}</span>
                    {line && <span className="block text-fg-dim">{line}</span>}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** What the CARD knows about its own request for a measurement. The empty
 *  state may only claim what this says — a card that reports "requested"
 *  when the POST was refused is the dishonesty this feature exists to
 *  remove. (Codex review, 2026-09-03.) */
export type PresenceAsk = "idle" | "asking" | "queued" | "failed";

export function PresenceBlock({
  presence,
  ask = "idle",
}: {
  presence: OnlinePresence | null | undefined;
  ask?: PresenceAsk;
}) {
  const measured = presence && presence.state === "measured" ? presence : null;
  const pillars = useMemo(() => measured?.blob.pillars ?? [], [measured]);

  if (!measured) {
    return (
      <div>
        <p className="max-w-3xl text-sm leading-relaxed text-fg-dim">
          {ask === "queued" || ask === "asking"
            ? "This business's presence beyond its website has not been measured yet. A lookup has been requested; the numbers will appear here once it completes, usually within a minute."
            : ask === "failed"
              ? "This business's presence beyond its website has not been measured, and the lookup could not be requested just now. Nothing here is missing from their business; it is missing from ours."
              : "This business's presence beyond its website has not been measured yet."}
        </p>
      </div>
    );
  }

  const { blob, stale } = measured;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {blob.composite === null ? (
          <p className="text-sm text-fg-muted">Measured, but not enough was reachable to score.</p>
        ) : (
          <p className="text-sm text-fg-muted">
            Presence score{" "}
            <span className="text-2xl font-bold tabular-nums text-fg [font-family:var(--battle-numeral)]">{blob.composite}</span>
            <span className="ml-1 text-xs text-fg-dim">of 100, separate from the website score</span>
          </p>
        )}
        <p className="text-xs text-fg-dim [font-family:var(--battle-data)]">
          Checked {fmtDate(blob.fetchedAt)}
          {stale && <span className="ml-1 text-fg-muted">(a refresh has been requested)</span>}
        </p>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {pillars.map((p) => (
          <PillarGroup key={p.key} pillar={p} blob={blob} />
        ))}
      </div>
    </div>
  );
}

export default PresenceBlock;
