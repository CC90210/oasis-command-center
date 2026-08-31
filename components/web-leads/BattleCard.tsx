"use client";

/**
 * BattleCard — the whole case against one prospect's website, on one screen,
 * for a rep who is already on the phone.
 *
 * ═══ WHY A PAGE AND NOT A DRAWER ════════════════════════════════════════════
 *
 * WebLeadDetail is a 28rem drawer over the leads table, and that is the right
 * shape for triage: glance, decide, close. It is the wrong shape for a call.
 * Adon: *"I want this page to be something that they can literally look at
 * while they're on the phone with the client, based off of our entire analysis
 * of their website and their current online footprint."* A rep mid-sentence
 * cannot scroll a narrow column looking for the thing they were about to say.
 * So: full width, with the call-critical blocks open in front of them.
 *
 * ═══ PROGRESSIVE DISCLOSURE (Adon, 2026-08-31) ══════════════════════════════
 *
 * The card originally rendered everything open, on the theory that any click
 * is a click a rep will not make while a stranger is waiting. Adon reviewed it
 * in use and reversed that: "it's just so much information that's in front of
 * your face." The resolution keeps both truths (see BattleSection.tsx):
 *
 *   - Every section is collapsible, and the ones a rep reads WHILE dialing
 *     default OPEN: the lead line, the opening script, the two graphs, the
 *     named competitors, the call log. Nothing mid-call costs a click.
 *   - The reference sections default CLOSED behind a one-line teaser naming
 *     what is inside: the directory facts, the brush-offs, the full fault
 *     list, the raw crawl. tests/web-leads-battlecard.test.ts pins the map so
 *     a later edit cannot silently collapse the opening script.
 *   - State persists per rep in localStorage; "Expand all" restores the
 *     original everything-open page in one click.
 *   - The two graphs gained SELECTION instead of more panels: tapping a radar
 *     axis or a fix-first row opens the detail for that one dimension in
 *     place, which is what lets the full fault list live behind a disclosure
 *     without hiding anything a rep needs mid-sentence.
 *
 * ═══ THE COMPETITOR SECTION IS THE POINT ════════════════════════════════════
 *
 * Every number this feature produced until now was absolute, and an absolute
 * number is unsellable -- a prospect has no idea whether 34 is normal for a
 * hair salon. We own the only honest comparison available: 23,195 Canadian
 * sites scored by the same model on the same 49 checks. Every business in the
 * same industry and city is a competitor and is already measured, by name, with
 * a URL the prospect can open while the rep is still talking. See
 * lib/web-leads/competitors.ts.
 *
 * ═══ THE RULES THIS FILE DOES NOT GET TO BREAK ══════════════════════════════
 *
 * 1. NO COLOUR IS KEYED TO A SCORE. Not on a bar, not on a radar, not on a
 *    percentile marker, not on a head-to-head arrow. Every fill in here is one
 *    neutral colour whether the score is 4 or 94. A red 22 renders a judgement
 *    the measurement does not support, and a rep who sees red says something
 *    they cannot back up. tests/web-leads-guards.test.ts enforces this by
 *    banning the colour classes outright in this file. The accent that appears
 *    on a SELECTED dimension is keyed to the selection -- it follows the rep's
 *    tap, renders identically for a 4 and a 94, and says "you are looking at
 *    this one", never "this one is bad".
 *
 * 2. THE THREE NON-SCORED STATES RENDER AS SENTENCES. Never a zero, never a
 *    blank, and above all never an empty chart -- a radar with all seven axes
 *    at the origin for a site our crawler was blocked from is a fabricated
 *    accusation with a nice gradient on it.
 *
 * 3. EVERY WORD IS HAND-WRITTEN. remedies.ts, angles.ts and evidence.ts are
 *    fixed tables rendered verbatim. Nothing on this page is generated per
 *    lead, because a model writing sales copy will eventually assert a
 *    measurement we never took and a rep will say it aloud to a stranger.
 *
 * 4. `prefers-reduced-motion` DISABLES ALL OF IT. Charts animate once on mount
 *    and never again; under reduced motion they simply appear. A rep on a call
 *    does not need things moving.
 *
 * ═══ WHY THE CHARTS ARE HAND-ROLLED SVG ═════════════════════════════════════
 *
 * recharts is in package.json, and it is deliberately not used here. Three
 * reasons: it ships its own colour defaults into a surface whose central rule
 * is that no colour may be keyed to a score, it renders a client-side
 * responsive container that reflows after paint (a chart that resizes under a
 * rep mid-sentence), and none of these four charts is complex enough to earn
 * ~90KB of it. A radar is seven points on a circle.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, ExternalLink, Phone } from "lucide-react";
import type { AuditResult, CheckResult, DimensionProfile } from "@/lib/web-leads/audit";
import type { CompetitorContext } from "@/lib/web-leads/competitors";
import type { WebLead } from "@/lib/web-leads/data";
import { preferredSiteUrl } from "@/lib/web-leads/url-safety";
import { remedyFor } from "@/lib/web-leads/remedies";
import { selectAngle, recoverablePoints, IF_THE_ANSWER_IS_CLEAN } from "@/lib/web-leads/angles";
import { evidenceFrom } from "@/lib/web-leads/evidence";
import { BusinessFacts, fullAddress } from "./BusinessFacts";
import { CallOutcomeLog } from "./CallOutcomeLog";
import { ObjectionPanel } from "./ObjectionPanel";
import { BattleSection, BattleSections, SectionToolbar, useBattleSections } from "./BattleSection";

type Payload = {
  lead: WebLead;
  audit: AuditResult;
  competitors: CompetitorContext | null;
  signals: Record<string, unknown> | null;
};

type Fetched =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; payload: Payload };

/**
 * True when the operating system asks for reduced motion.
 *
 * Read through an effect rather than at render so the server and the first
 * client paint agree -- reading matchMedia during render is a hydration
 * mismatch. It starts `false` and corrects on mount, which means at worst one
 * frame of intent before everything stops; starting `true` instead would cost
 * every other user their mount animation on the first frame.
 */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * Flips true one frame after mount, so every chart can transition from its
 * empty state to its real one exactly once.
 *
 * ONCE is the whole point: a chart that redraws every time a rep scrolls or a
 * sibling re-renders is a distraction during a call, not a feature. `drawn`
 * never goes back to false, so re-renders keep the final geometry.
 */
function useDrawOnce(reduced: boolean): boolean {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (reduced) { setDrawn(true); return; }
    const raf = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(raf);
  }, [reduced]);
  return drawn;
}

/**
 * Counts the hero score up from zero, once, on mount. Pure theatre, so it obeys
 * rule 4 twice over: reduced motion renders the final number immediately, and
 * the animation never replays. The real value is mirrored in an sr-only span at
 * the call site so assistive tech never hears an intermediate frame.
 */
function useCountUp(target: number, reduced: boolean): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (reduced) { setValue(target); return; }
    let raf = 0;
    const started = performance.now();
    const duration = 700;
    const tick = (now: number) => {
      const p = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(eased * target));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, reduced]);
  return value;
}

const fmt = (n: number) => n.toLocaleString("en-US");

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// ───────────────────────────────────────────────────────────────────────────
// Small shared pieces
// ───────────────────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[10px] font-bold uppercase tracking-[0.16em] text-fg-muted">{children}</h2>;
}

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-bg-border bg-bg-panel p-5 lg:p-6 ${className}`}>
      {children}
    </section>
  );
}

/** "Costs them:" / "We'd fix it:" — the two lines a rep reads aloud, from the
 *  hand-written table in remedies.ts. Renders nothing when a code has no entry
 *  rather than an empty bullet or the word "undefined". */
function RemedyLines({ code }: { code: string }) {
  const remedy = remedyFor(code);
  if (!remedy) return null;
  return (
    <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-fg-dim">
      <p><span className="font-medium text-fg-muted">Costs them:</span> {remedy.costs}</p>
      <p><span className="font-medium text-fg-muted">We&apos;d fix it:</span> {remedy.fix}</p>
    </div>
  );
}

/** One neutral fill, always. See rule 1 in the module header. */
function Meter({ value, drawn, reduced }: { value: number; drawn: boolean; reduced: boolean }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-bg-border" aria-hidden>
      <span
        className="block h-full rounded-full bg-fg-dim"
        style={{
          width: drawn ? `${pct}%` : "0%",
          transition: reduced ? "none" : "width 420ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      />
    </span>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// §3.2 — the seven-dimension radar
// ───────────────────────────────────────────────────────────────────────────

const RADAR = { w: 420, h: 340, cx: 210, cy: 168, r: 108, labelR: 130 };

function radarPoint(index: number, total: number, value: number) {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / total;
  const radius = (Math.min(100, Math.max(0, value)) / 100) * RADAR.r;
  return { x: RADAR.cx + radius * Math.cos(angle), y: RADAR.cy + radius * Math.sin(angle), angle };
}

/** Hand-rolled two-line wrap. The model's dimension names are rep-facing
 *  sentences ("Turning visitors into calls"), and shortening them here would
 *  invent a second vocabulary for the same seven things. */
function wrapLabel(text: string, max = 16): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line) { line = w; continue; }
    if ((line + " " + w).length <= max) line += " " + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function Radar({
  dimensions, leader, leaderName, drawn, reduced, selected, onSelect,
}: {
  dimensions: DimensionProfile[];
  leader: { key: string; leader: number }[] | null;
  leaderName: string | null;
  drawn: boolean;
  reduced: boolean;
  /** The dimension the rep is inspecting. Selection is the ONLY thing the
   *  accent follows on this chart -- never the score (rule 1). */
  selected?: string | null;
  onSelect?: (key: string) => void;
}) {
  const n = dimensions.length;
  if (n < 3) return null;

  const theirs = dimensions.map((d, i) => radarPoint(i, n, d.score));
  const leaderByKey = new Map((leader || []).map((l) => [l.key, l.leader]));
  const leaderPts = leader ? dimensions.map((d, i) => radarPoint(i, n, leaderByKey.get(d.key) ?? 0)) : null;
  const toPath = (pts: { x: number; y: number }[]) => pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  return (
    <svg
      viewBox={`0 0 ${RADAR.w} ${RADAR.h}`}
      className="h-auto w-full max-w-[420px] text-fg-dim"
      role="img"
      aria-label={`Seven-dimension shape: ${dimensions.map((d) => `${d.label} ${d.score}`).join(", ")}`}
    >
      {/* Rings. Four, unlabelled: this chart answers "what SHAPE of bad is
          this", and gridline numbers invite reading exact values off it, which
          is what the list beside it is for. */}
      {[25, 50, 75, 100].map((ring) => (
        <polygon
          key={ring}
          points={toPath(dimensions.map((_, i) => radarPoint(i, n, ring)))}
          fill="none"
          stroke="currentColor"
          strokeOpacity={ring === 100 ? 0.42 : 0.16}
          strokeWidth={1}
        />
      ))}
      {/* Spokes. The selected axis carries the accent -- keyed to the tap,
          not to the value on it. */}
      {dimensions.map((d, i) => {
        const p = radarPoint(i, n, 100);
        const active = selected === d.key;
        return (
          <line
            key={d.key}
            x1={RADAR.cx} y1={RADAR.cy} x2={p.x} y2={p.y}
            className={active ? "stroke-accent" : undefined}
            stroke="currentColor"
            strokeOpacity={active ? 0.55 : 0.16}
            strokeWidth={active ? 1.5 : 1}
          />
        );
      })}

      {/* Draws once on mount, from the centre outward. transformOrigin is given
          in user units because SVG has no percentage transform box here. */}
      <g
        style={{
          transformOrigin: `${RADAR.cx}px ${RADAR.cy}px`,
          transform: drawn ? "scale(1)" : "scale(0)",
          transition: reduced ? "none" : "transform 480ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        {/* The best local competitor, dashed. Distinguished by STROKE STYLE,
            never by hue -- the whole point of the overlay is the gap between
            the two outlines, and a colour on either one would say which is
            good. */}
        {leaderPts && (
          <polygon
            points={toPath(leaderPts)}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.75}
            strokeWidth={1.5}
            strokeDasharray="5 4"
          />
        )}
        <polygon
          points={toPath(theirs)}
          className="fill-fg-muted stroke-fg"
          fillOpacity={0.14}
          strokeOpacity={0.85}
          strokeWidth={2}
        />
        {theirs.map((p, i) => {
          const active = selected === dimensions[i].key;
          return (
            <circle
              key={dimensions[i].key}
              cx={p.x} cy={p.y}
              r={active ? 4 : 2.6}
              className={active ? "fill-accent" : "fill-fg"}
              fillOpacity={0.9}
            />
          );
        })}
      </g>

      {/* Axis labels, using the model's own rep-facing names. */}
      {dimensions.map((d, i) => {
        const p = radarPoint(i, n, 100);
        const dx = p.x - RADAR.cx;
        const lx = RADAR.cx + (dx / RADAR.r) * RADAR.labelR;
        const ly = RADAR.cy + ((p.y - RADAR.cy) / RADAR.r) * RADAR.labelR;
        const anchor = Math.abs(dx) < 12 ? "middle" : dx > 0 ? "start" : "end";
        const lines = wrapLabel(d.label);
        const active = selected === d.key;
        return (
          <text
            key={d.key}
            x={lx}
            y={ly - (lines.length - 1) * 5}
            textAnchor={anchor}
            className={active ? "fill-fg" : "fill-fg-muted"}
            style={{ fontSize: 10, fontWeight: active ? 700 : 400 }}
          >
            {lines.map((line, li) => (
              <tspan key={line} x={lx} dy={li === 0 ? 0 : 11}>{line}</tspan>
            ))}
          </text>
        );
      })}

      {/* Invisible hit targets, one per axis, covering the vertex and the
          label. aria-hidden on purpose: the dimension list next to this chart
          is the accessible, keyboard-reachable way to make the same selection,
          and it is ALWAYS rendered (the radar itself is display:none below
          `sm`). These exist so a mouse or a thumb can use the chart itself. */}
      {onSelect &&
        dimensions.map((d, i) => {
          const tip = radarPoint(i, n, 100);
          const lx = RADAR.cx + ((tip.x - RADAR.cx) / RADAR.r) * RADAR.labelR;
          const ly = RADAR.cy + ((tip.y - RADAR.cy) / RADAR.r) * RADAR.labelR;
          return (
            <g key={d.key} aria-hidden className="cursor-pointer">
              <circle cx={tip.x} cy={tip.y} r={20} fill="transparent" onClick={() => onSelect(d.key)} onMouseEnter={() => onSelect(d.key)} />
              <circle cx={lx} cy={ly} r={18} fill="transparent" onClick={() => onSelect(d.key)} onMouseEnter={() => onSelect(d.key)} />
            </g>
          );
        })}
      {leaderName && (
        <text x={RADAR.cx} y={RADAR.h - 6} textAnchor="middle" className="fill-fg-dim" style={{ fontSize: 10 }}>
          Dashed outline: {leaderName}
        </text>
      )}
    </svg>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// §3.1 — the percentile strip
// ───────────────────────────────────────────────────────────────────────────

const STRIP = { w: 400, h: 96, top: 10, plot: 62, left: 2, right: 2 };

function DistributionStrip({
  buckets, leadBucket, leadScore, drawn, reduced,
}: {
  buckets: number[];
  leadBucket: number;
  leadScore: number;
  drawn: boolean;
  reduced: boolean;
}) {
  const max = Math.max(1, ...buckets);
  const usable = STRIP.w - STRIP.left - STRIP.right;
  const slot = usable / buckets.length;
  const barW = slot - 4;
  const markerX = STRIP.left + leadBucket * slot + slot / 2;

  return (
    <svg
      viewBox={`0 0 ${STRIP.w} ${STRIP.h}`}
      className="h-auto w-full text-fg-dim"
      role="img"
      aria-label={`Score distribution in ten bands; this business falls in the ${leadBucket * 10} to ${leadBucket * 10 + 9} band`}
    >
      {buckets.map((count, i) => {
        const h = (count / max) * STRIP.plot;
        const x = STRIP.left + i * slot + 2;
        return (
          // ONE fill for every bar, including the band this lead falls in. The
          // "you are here" signal is the marker below, not a tinted bar: a bar
          // that changes appearance based on where the score landed is a colour
          // keyed to a score wearing a different hat.
          <rect
            key={i}
            x={x}
            width={barW}
            y={STRIP.top + STRIP.plot - (drawn ? h : 0)}
            height={drawn ? h : 0}
            rx={2}
            className="fill-fg-dim"
            fillOpacity={0.55}
            style={{ transition: reduced ? "none" : `y 420ms ease-out ${i * 22}ms, height 420ms ease-out ${i * 22}ms` }}
          />
        );
      })}
      {/* The marker. A line and a label, no fill change anywhere. */}
      <line
        x1={markerX} x2={markerX}
        y1={STRIP.top - 4} y2={STRIP.top + STRIP.plot + 4}
        stroke="currentColor" strokeOpacity={0.9} strokeWidth={1.5}
      />
      <polygon
        points={`${markerX - 4},${STRIP.top + STRIP.plot + 5} ${markerX + 4},${STRIP.top + STRIP.plot + 5} ${markerX},${STRIP.top + STRIP.plot + 11}`}
        className="fill-fg"
      />
      <text
        x={Math.min(STRIP.w - 30, Math.max(30, markerX))}
        y={STRIP.h - 6}
        textAnchor="middle"
        className="fill-fg"
        style={{ fontSize: 11, fontWeight: 700 }}
      >
        {leadScore}
      </text>
      <text x={STRIP.left} y={STRIP.h - 6} textAnchor="start" className="fill-fg-dim" style={{ fontSize: 9 }}>0</text>
      <text x={STRIP.w - STRIP.right} y={STRIP.h - 6} textAnchor="end" className="fill-fg-dim" style={{ fontSize: 9 }}>100</text>
    </svg>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// The non-scored states — sentences, never charts. See rule 2.
// ───────────────────────────────────────────────────────────────────────────

function NotScored({ audit }: { audit: AuditResult }) {
  const sentence =
    audit.state === "no_website"
      ? "No website found yet, needs checking"
      : // Their domain is for sale. Not a hedge like the others around it: this
        // is a measured fact and the strongest opener on the card.
        audit.state === "parked"
        ? "Their domain has lapsed and is listed for sale, so they have no live site."
        : audit.state === "unreachable"
          ? "We could not check this site."
          : "Not scored yet.";
  return (
    <Panel>
      <SectionTitle>Their website</SectionTitle>
      <p className="mt-3 text-xl font-semibold leading-snug text-fg">{sentence}</p>
      {audit.state === "unreachable" && (
        // The reason is about OUR crawler, not about them, so it stays small
        // and stays hedged. A site we were blocked from may be excellent.
        <p className="mt-2 text-xs text-fg-faint">{audit.reason}</p>
      )}
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-fg-muted">
        There is nothing measured to compare against competitors yet, so this page shows no score, no ranking and no
        chart. Everything the directory recorded is in the business details above, and it has not been verified by
        anyone.
      </p>
      {/* The two verbatim directory strings USED to be repeated here. They now
          render once, at the top of the page, in BusinessFacts -- which every
          state of this card shows, scored or not. Printing the same unverified
          sentence twice on one screen invites a rep to wonder which of the two
          is the current one. */}
    </Panel>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// The card
// ───────────────────────────────────────────────────────────────────────────

/**
 * `embedded` renders the SAME card inside another page, for /pipeline/[id].
 *
 * WHY THE SAME COMPONENT RATHER THAN A PIPELINE-SHAPED COPY (Adon, 2026-08-25):
 * "we have to ensure that the leads tab and the pipeline are completely
 * synonymous... as soon as you claim a lead, you're losing a lot of the
 * information that we have on the leads tab. We need to ensure that this is not
 * done because that's just completely dysfunctional."
 *
 * A second rendering of one business's failings is two things that can disagree
 * mid-call -- the same argument BusinessFacts already settles between the drawer
 * and this card. So the pipeline gets this component, reading the same
 * /api/web-leads/[id]/battlecard payload through the same authorization
 * boundary. There is no pipeline variant of the score, the competitors, the
 * angles or the objections, because there is no second implementation of them.
 *
 * Embedded only changes CHROME, never content: it drops the full-viewport
 * background (it sits inside a page that already has one) and the "Back to
 * leads" link (that page has its own "Back to pipeline", and sending a rep from
 * the pipeline to the leads pool is the wrong door). Collapse state is chrome
 * by the same rule -- both surfaces share the SAME localStorage keys, so the
 * card a rep shaped on the leads tab is the card they get on the pipeline.
 * `canMutate` is orthogonal and stays required -- whether a viewer may WRITE
 * is not a layout question.
 */
export function BattleCard({
  leadId,
  canMutate,
  embedded = false,
}: {
  leadId: string;
  canMutate: boolean;
  embedded?: boolean;
}) {
  const [state, setState] = useState<Fetched>({ status: "loading" });
  const reduced = useReducedMotion();
  const drawn = useDrawOnce(reduced);

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    fetch(`/api/web-leads/${encodeURIComponent(leadId)}/battlecard`)
      .then(async (r) => {
        if (r.status === 404) {
          if (alive) setState({ status: "error", message: "This lead no longer exists." });
          return;
        }
        if (!r.ok) {
          if (alive) setState({ status: "error", message: "Could not load this lead." });
          return;
        }
        const body = await r.json();
        // Re-checked AFTER the body is parsed, not once when the fetch
        // resolves: the same race useAudit.ts documents. A check before
        // `await r.json()` only covers the header round-trip, so a slow body
        // for lead A can land after a fast body for lead B and put one
        // business's failings under another's name.
        if (alive) setState({ status: "ready", payload: body as Payload });
      })
      .catch(() => { if (alive) setState({ status: "error", message: "Could not load this lead." }); });
    return () => { alive = false; };
  }, [leadId]);

  if (state.status === "error") {
    const error = state.message;
    // The banner's className below stays a STATIC string, never a template
    // literal. tests/web-leads-guards.test.ts exempts the repo-wide
    // fetch-failure banner from the no-colour rule by matching a quoted amber
    // class list around a literal error node; interpolating that class list
    // broke the match and flagged this whole file for colour it attaches to no
    // score. Spacing that varies goes on the wrapper instead.
    return (
      <div className={embedded ? "" : "mx-auto max-w-3xl px-6 py-10"}>
        {!embedded && <BackLink />}
        <div className={embedded ? "" : "mt-6"}>
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">{error}</p>
        </div>
      </div>
    );
  }

  if (state.status === "loading") return <CardSkeleton embedded={embedded} />;

  const { lead, audit, competitors, signals } = state.payload;

  return (
    <div className={embedded ? "" : "min-h-screen bg-bg"}>
      <Hero lead={lead} audit={audit} competitors={competitors} drawn={drawn} reduced={reduced} canMutate={canMutate} embedded={embedded} />
      <BattleSections>
        <div className={embedded ? "space-y-5 pt-5" : "mx-auto max-w-6xl space-y-5 px-4 pb-16 lg:px-8"}>
          <SectionToolbar />
          {/* FIRST SECTION ON THE PAGE, ABOVE EVERY CHART. A rep confirms who
              they are calling before they pitch, and the card shipped on
              2026-08-24 without this block at all -- address, postal code,
              directory category and territory appeared nowhere on it. It
              defaults CLOSED (Adon, 2026-08-31): the hero already carries the
              name, the full address and the phone, so this block is the
              long-form reference, one labelled click away. One shared
              component with the drawer (components/web-leads/BusinessFacts.tsx)
              rather than a second copy of the same fields, because two
              renderings of one lead's address are two things that can disagree
              mid-call. */}
          <BattleSection
            id="facts"
            defaultOpen={false}
            title="Who you are calling"
            sub="Everything the directory recorded about this business. None of it has been verified by anyone here."
            teaser="Address, phone, category and territory as the directory recorded them, unverified"
          >
            <BusinessFacts lead={lead} layout="grid" />
          </BattleSection>

          {audit.state !== "scored" ? (
            <NotScored audit={audit} />
          ) : (
            <ScoredBody
              lead={lead}
              audit={audit}
              competitors={competitors}
              signals={signals}
              drawn={drawn}
              reduced={reduced}
            />
          )}
          <Panel>
            {/* Reused wholesale rather than restyled: one component owns the four
                outcomes, and logging an outcome IS the transfer to the pipeline
                (lib/web-leads/outcome.ts) -- there is no separate "move to
                pipeline" button anywhere in this feature. A second copy here
                would be a second place for that rule to drift. It brings its own
                "Log this call" heading, so this panel deliberately does not add
                a second one above it. Deliberately NOT collapsible either: this
                is the card's one write surface, and the transfer to the pipeline
                must never be sitting behind a closed drawer when the call ends. */}
            <CallOutcomeLog leadId={leadId} canMutate={canMutate} />
          </Panel>
        </div>
      </BattleSections>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/web-leads"
      className="inline-flex items-center gap-1.5 rounded text-xs font-semibold text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
    >
      <ArrowLeft className="h-3.5 w-3.5" />Back to leads
    </Link>
  );
}

function CardSkeleton({ embedded = false }: { embedded?: boolean }) {
  return (
    <div className={embedded ? "" : "min-h-screen bg-bg"}>
      <div className="border-b border-bg-border bg-bg-panel/60 px-4 py-8 lg:px-8">
        <div className="mx-auto max-w-6xl space-y-3" aria-busy="true" aria-live="polite">
          <div className="h-3 w-24 rounded bg-bg-elev animate-pulse-slow" />
          <div className="h-8 w-72 rounded bg-bg-elev animate-pulse-slow" />
          <div className="h-3 w-52 rounded bg-bg-elev/60 animate-pulse-slow" />
        </div>
      </div>
      <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 lg:px-8">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-44 rounded-xl border border-bg-border bg-bg-panel animate-pulse-slow"
            style={{ animationDelay: `${i * 80}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The hero: who they are, the number to dial, their site, the score, and the
 * one sentence that makes the score mean something.
 */
function Hero({
  lead, audit, competitors, drawn, reduced, canMutate, embedded = false,
}: {
  lead: WebLead;
  audit: AuditResult;
  competitors: CompetitorContext | null;
  drawn: boolean;
  reduced: boolean;
  canMutate: boolean;
  embedded?: boolean;
}) {
  const websiteHref = preferredSiteUrl(lead.websiteUrl);
  // Hooks before any branch: the count-up runs for every state and simply
  // counts to 0 when there is no score to show.
  const shownScore = useCountUp(audit.state === "scored" ? audit.composite : 0, reduced);
  return (
    <header className="relative overflow-hidden border-b border-bg-border bg-bg-panel/60">
      {/* Ambient depth, keyed off NOTHING -- not the score, not the state. It
          renders identically for a 4 and a 94. Depth without meaning is the
          whole brief (design spec §6). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ background: "radial-gradient(60% 120% at 15% -10%, rgba(59,130,246,0.10), transparent 70%)" }}
      />
      <div className={embedded ? "relative px-4 py-6 lg:px-6" : "relative mx-auto max-w-6xl px-4 py-7 lg:px-8 lg:py-9"}>
        {!embedded && <BackLink />}
        <div className={`${embedded ? "" : "mt-4"} flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between`}>
          <div className="min-w-0">
            <h1 className="text-3xl font-bold leading-tight tracking-tight text-fg lg:text-4xl">{lead.name}</h1>
            {/* The FULL address, street and postal code included -- not just
                the city. A rep confirming a business by name needs the street
                to be sure they have the right branch, and this line is the
                first thing under the name. The complete block (category,
                territory, the unverified directory sentences) is the first
                panel below. */}
            <p className="mt-2 text-sm text-fg-muted">
              {[lead.industry, fullAddress(lead)].filter(Boolean).join(" · ") || "No location on file"}
            </p>
            {/* Full width and 56px tall below `sm`, one line of pills above it.
                A rep reading this page on a phone is usually reading it BECAUSE
                they are about to dial, and `tel:` is the one control on this
                whole surface that does something better on a phone than on a
                desktop. `whitespace-nowrap` on the number for the same reason
                the table has it: a browser will break after a hyphen, and
                `+1-416-` / `259-` / `9326` is not a number a rep can read out. */}
            <div className="mt-5 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
              {lead.phone && canMutate ? (
                <a
                  href={`tel:${lead.phone}`}
                  className="inline-flex min-h-14 w-full items-center justify-center gap-2.5 whitespace-nowrap rounded-lg bg-gradient-to-br from-accent to-accent-muted px-5 text-lg font-bold tabular-nums text-white shadow-[0_0_0_1px_rgba(59,130,246,0.18),0_10px_28px_-10px_rgba(59,130,246,0.5)] transition-[filter,transform] hover:brightness-110 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 motion-reduce:transition-none sm:min-h-0 sm:w-auto sm:py-3 sm:text-base"
                >
                  <Phone className="h-5 w-5 shrink-0" />{lead.phone}
                </a>
              ) : lead.phone ? (
                <p className="rounded-lg border border-bg-border px-5 py-3 text-center text-base tabular-nums text-fg-muted sm:text-left">{lead.phone}</p>
              ) : (
                <p className="rounded-lg border border-bg-border px-5 py-3 text-sm text-fg-dim">No phone number on file</p>
              )}
              {/* preferredSiteUrl adds a scheme to bare domains (217 stored
                  websites have none, and a bare string in an href navigates
                  inside our own dashboard), allowlists http/https (these come
                  from OpenStreetMap, which anyone can edit), and prefers the
                  origin over a stale deep path. Render NOTHING when it returns
                  null -- a missing button is honest, a dead one is not. */}
              {websiteHref && (
                <a
                  href={websiteHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-bg-border bg-bg-panel px-4 text-sm font-semibold text-fg transition-[color,border-color,transform] hover:border-accent/40 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 motion-reduce:transition-none sm:py-3"
                >
                  {/* Same words as the drawer's button and as the operator's
                      own request. Two surfaces that send a rep to the same
                      place should not call it two different things. */}
                  <ExternalLink className="h-4 w-4" />View website
                </a>
              )}
            </div>
          </div>

          <div className="shrink-0 lg:text-right">
            {audit.state === "scored" ? (
              <>
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-fg-muted">Website score</p>
                {/* The animated figure is theatre and is hidden from assistive
                    tech; the sr-only span carries the real number so a screen
                    reader never announces an intermediate frame. */}
                <p className="mt-1 text-7xl font-bold leading-none tracking-tight tabular-nums text-fg drop-shadow-[0_0_22px_rgba(59,130,246,0.26)]">
                  <span aria-hidden>{shownScore}</span>
                  <span className="sr-only">{audit.composite}</span>
                </p>
                <p className="mt-2 text-xs text-fg-dim">Measured {formatDate(audit.measuredAt)}</p>
              </>
            ) : (
              <p className="max-w-xs text-base font-semibold leading-snug text-fg-muted">
                {audit.state === "no_website"
                  ? "No website found yet, needs checking"
                  : audit.state === "parked"
                    ? "Their domain has lapsed and is listed for sale, so they have no live site."
                    : audit.state === "unreachable"
                      ? "We could not check this site."
                      : "Not scored yet."}
              </p>
            )}
          </div>
        </div>

        {audit.state === "scored" && competitors && (
          <PercentileSentence competitors={competitors} score={audit.composite} drawn={drawn} reduced={reduced} />
        )}
      </div>
    </header>
  );
}

/**
 * The strongest honest sentence this system can produce, and the reason the
 * competitor work exists at all.
 *
 * Two things it must never do: quote a percentile without naming the group it
 * is against, and quote one against a group small enough for a prospect to
 * count. lib/web-leads/competitors.ts guarantees the second (MIN_SLICE) and
 * hands back every rejected slice so this can say the first out loud.
 */
function PercentileSentence({
  competitors, score, drawn, reduced,
}: {
  competitors: CompetitorContext;
  score: number;
  drawn: boolean;
  reduced: boolean;
}) {
  const { slice, percentile, national, rejected, distribution } = competitors;
  const pctText = percentile.lowerThanPct === 0 ? "under 1%" : `${percentile.lowerThanPct}%`;
  return (
    <div
      className="mt-7 grid gap-6 border-t border-bg-border pt-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-center"
      style={{
        opacity: drawn ? 1 : 0,
        transform: drawn ? "none" : "translateY(8px)",
        transition: reduced ? "none" : "opacity 380ms ease-out 60ms, transform 380ms ease-out 60ms",
      }}
    >
      <div>
        <p className="text-xl font-semibold leading-snug text-fg lg:text-2xl">
          {percentile.rank === 1
            ? `Nothing we have measured among ${fmt(slice.peerCount)} ${slice.label} scores higher.`
            : `Scores lower than ${pctText} of the ${fmt(slice.peerCount)} ${slice.label} we have measured.`}
        </p>
        <p className="mt-2 text-sm text-fg-muted">
          Rank {fmt(percentile.rank)} of {fmt(percentile.outOf)}. Best in that group scores {slice.best}, the middle of
          it scores {slice.median}, the lowest scores {slice.worst}.
        </p>
        {slice.kind !== "national" && (
          <p className="mt-1 text-sm text-fg-dim">
            Against every one of the {fmt(national.peerCount)} Canadian sites we have measured: lower than{" "}
            {national.lowerThanPct === 0 ? "under 1%" : `${national.lowerThanPct}%`}.
          </p>
        )}
        {/* NEVER a silent fallback. If the local slice was too thin to be
            honest, the wider one that replaced it is named here. */}
        {rejected.length > 0 && (
          <p className="mt-2 text-xs leading-relaxed text-fg-faint">
            Only {fmt(rejected[0].peerCount)} {rejected[0].label} have been scored, too few to compare against, so this
            is measured against {slice.label} instead.
          </p>
        )}
      </div>
      <div className="w-full">
        <DistributionStrip
          buckets={distribution.buckets}
          leadBucket={distribution.leadBucket}
          leadScore={score}
          drawn={drawn}
          reduced={reduced}
        />
        {/* No count in this caption on purpose: the histogram counts the lead
            itself as one of the measured sites, so any number here would be
            peerCount + 1 and would sit one off the sentence beside it. Two
            numbers that describe the same group and disagree by one is the kind
            of thing a prospect notices and a rep cannot explain. */}
        <p className="mt-1 text-center text-[10px] text-fg-faint">
          Score bands across the {slice.label} we have measured
        </p>
      </div>
    </div>
  );
}

function ScoredBody({
  lead, audit, competitors, signals, drawn, reduced,
}: {
  lead: WebLead;
  audit: Extract<AuditResult, { state: "scored" }>;
  competitors: CompetitorContext | null;
  signals: Record<string, unknown> | null;
  drawn: boolean;
  reduced: boolean;
}) {
  const worstFirst = useMemo(
    () => [...audit.dimensions].sort((a, b) => recoverablePoints(b) - recoverablePoints(a)),
    [audit.dimensions],
  );
  const failed = useMemo(
    () => audit.dimensions.flatMap((d) => d.checks.filter((c) => !c.has)).sort((a, b) => b.points - a.points),
    [audit.dimensions],
  );
  const headline = failed[0] || null;
  const angle = useMemo(() => selectAngle(audit.dimensions), [audit.dimensions]);
  const evidence = useMemo(() => evidenceFrom(signals), [signals]);
  const maxRecoverable = Math.max(1, ...worstFirst.map(recoverablePoints));
  const totalChecks = audit.dimensions.reduce((n, d) => n + d.checks.length, 0);
  const failingAreas = worstFirst.filter((d) => d.checks.some((c) => !c.has)).length;

  return (
    <>
      {/* ── §4, depth one: THE ONE LINE ─────────────────────────────────── */}
      {headline && (
        <BattleSection id="lead-with" defaultOpen={true} title="The one thing to lead with">
          {/* Stated as its CONSEQUENCE, not its cause. remedies.ts's `costs`
              line is hand-written to be read aloud; the check's own label
              ("Tappable phone number") is a defect name and nobody sells one. */}
          <p className="max-w-4xl text-xl font-semibold leading-snug text-fg lg:text-2xl">
            {remedyFor(headline.code)?.costs || headline.label}
          </p>
          <p className="mt-2 text-xs text-fg-dim">
            Biggest single gap on the site, out of {failed.length} failed {failed.length === 1 ? "check" : "checks"}.
          </p>
        </BattleSection>
      )}

      {/* ── §5, THE ANGLE ───────────────────────────────────────────────────
          Rendered in the order the three beats are actually spoken, because a
          rep mid-call reads down the page and says what is in front of them.
          Beat one is stated (Gong's 300M-call data: name the reason outright).
          Beat two is asked and then followed by silence (Sandler: the prospect
          cannot argue with a gap he found himself). Beat three is the teach,
          and it only earns its place AFTER an answer -- delivering it early is
          precisely what manufactures the objection to it. The rationale and
          sources are in lib/web-leads/angles.ts. */}
      {angle && (
        <BattleSection
          id="opening"
          defaultOpen={true}
          title="How to open"
          sub={
            <>
              Chosen because {angle.label.toLowerCase()} is losing them more of the score than anything else. Say your
              own name and company first, then these three in order.
            </>
          }
        >
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
            1. Say this
          </p>
          <p className="mt-1.5 max-w-4xl text-lg font-semibold leading-relaxed text-fg">
            &ldquo;{angle.angle.opener}&rdquo;
          </p>

          <p className="mt-5 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
            2. Then ask this, and stop talking
          </p>
          <p className="mt-1.5 max-w-4xl text-lg font-semibold leading-relaxed text-fg">
            &ldquo;{angle.angle.diagnostic}&rdquo;
          </p>
          {/* Rendered with the question, never below the fold of it. A rep who
              reads straight down this card after a clean answer describes a
              problem the prospect has just demonstrated they do not have, which
              is a false claim on a live call. A dimension is several checks and
              this is one of them. (Codex review, 2026-08-24.) */}
          <p className="mt-2 max-w-4xl text-xs leading-relaxed text-fg-muted">{IF_THE_ANSWER_IS_CLEAN}</p>

          <div className="mt-6 grid gap-5 border-t border-bg-border pt-5 md:grid-cols-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
                3. Once they answer, this is why it costs them
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-fg-dim">{angle.angle.cost}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
                If they say &ldquo;{angle.angle.objection.says}&rdquo;
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-fg-dim">{angle.angle.objection.response}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">What we&apos;d build</p>
              <p className="mt-1.5 text-sm leading-relaxed text-fg-dim">{angle.angle.build}</p>
            </div>
          </div>

          {/* Held in reserve, and labelled as such. This is the ONLY copy on
              the card carrying a research figure, and it is not part of the
              pitch: it is what a rep reaches for when the prospect disputes the
              general claim. The source line is rendered beside it on purpose,
              so a rep who is challenged twice can name where it came from
              instead of guessing. */}
          {angle.angle.proof && (
            <div className="mt-5 rounded-lg border border-bg-border bg-bg-raised/60 p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
                Only if they push back on that
              </p>
              <p className="mt-1.5 max-w-4xl text-sm leading-relaxed text-fg-dim">{angle.angle.proof.stat}</p>
              <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">Source: {angle.angle.proof.source}</p>
            </div>
          )}
        </BattleSection>
      )}

      {/* ── The objections that arrive whatever the site looks like ────────
          Closed by default (Adon, 2026-08-31): the eight cards are identical
          on every lead, so a rep who has read them once carries them, and the
          teaser names the panic button for the rep who has not. `bare` hands
          the panel's own shell to BattleSection so the section header is the
          disclosure control -- the copy inside is byte-identical. */}
      <BattleSection
        id="brushoffs"
        defaultOpen={false}
        title="The brush-offs, and what to do with them"
        teaser="The eight standing brush-offs, what each one usually means, and the counter for it"
      >
        <ObjectionPanel bare />
      </BattleSection>

      {/* ── §3.2 the shape + §3.3 points on the table ────────────────────── */}
      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <BattleSection
          id="shape"
          defaultOpen={true}
          title="What kind of bad is it"
          sub="The shape of the problem across seven areas. Tap one, on the chart or in the list, to see what is failing inside it."
        >
          <DimensionShape
            dimensions={audit.dimensions}
            worstFirst={worstFirst}
            competitors={competitors}
            drawn={drawn}
            reduced={reduced}
          />
        </BattleSection>

        <BattleSection
          id="fixes"
          defaultOpen={true}
          title="What is worth fixing first"
          sub="Points back on the total score if that area were brought to full marks. This is the build, in order. Tap a row for the checks behind it."
        >
          <FixFirst
            worstFirst={worstFirst}
            maxRecoverable={maxRecoverable}
            totalAreas={audit.dimensions.length}
            totalChecks={totalChecks}
            drawn={drawn}
            reduced={reduced}
          />
        </BattleSection>
      </div>

      {/* ── The competitors ─────────────────────────────────────────────── */}
      <BattleSection
        id="competitors"
        defaultOpen={true}
        title="Who they are up against"
        sub={
          competitors ? (
            <>
              The best-scoring {competitors.slice.label} we have measured, on the same {totalChecks} checks. Real
              businesses, open any of them while you are on the call.
            </>
          ) : undefined
        }
      >
        <Competitors competitors={competitors} audit={audit} lead={lead} drawn={drawn} reduced={reduced} />
      </BattleSection>

      {/* ── §4, depth two: THE CASE, BY DIMENSION ───────────────────────── */}
      <BattleSection
        id="faults"
        defaultOpen={false}
        title="Everything wrong with this site"
        sub="Grouped by what it affects, worst first. Three separate things wrong with how a site earns trust is an argument; nineteen bullet points is noise."
        teaser={`${failed.length} ${failed.length === 1 ? "check" : "checks"} failing across ${failingAreas} ${failingAreas === 1 ? "area" : "areas"}, worst first, with what each one costs them`}
      >
        <div className="space-y-6">
          {worstFirst.map((d) => {
            const misses = d.checks.filter((c) => !c.has);
            return (
              <div key={d.key} id={`battle-dim-${d.key}`} className="scroll-mt-24 border-t border-bg-border pt-4 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-base font-semibold text-fg">{d.label}</h3>
                  <p className="text-xs text-fg-muted">
                    Scores <span className="tabular-nums text-fg">{d.score}</span> ·{" "}
                    {misses.length === 0
                      ? "nothing failing here"
                      : `${misses.length} of ${d.checks.length} ${misses.length === 1 ? "check" : "checks"} failing`}
                  </p>
                </div>
                {misses.length === 0 ? (
                  <p className="mt-2 text-sm text-fg-dim">Everything we check in this area passed.</p>
                ) : (
                  <ul className="mt-3 grid gap-2.5 md:grid-cols-2">
                    {misses
                      .slice()
                      .sort((a, b) => b.points - a.points)
                      .map((check: CheckResult) => (
                        <li key={check.code} className="rounded-lg border border-bg-border bg-bg-raised/60 p-3.5">
                          <p className="text-sm font-semibold text-fg">{check.label}</p>
                          <RemedyLines code={check.code} />
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </BattleSection>

      {/* ── §4, depth three: THE EVIDENCE ───────────────────────────────── */}
      <BattleSection
        id="evidence"
        defaultOpen={false}
        title="What we actually measured"
        sub={
          <>
            The raw crawl, for when a prospect says they redid the site last year. Every line is something the crawler
            saw on {formatDate(audit.measuredAt)}; anything it did not record is not listed rather than shown as a
            zero.
          </>
        }
        teaser={`The raw crawl from ${formatDate(audit.measuredAt)}, line by line`}
      >
        {evidence.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No raw measurements were stored alongside this score, so there is nothing to quote here.
          </p>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {evidence.map((group) => (
              <div key={group.title}>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">{group.title}</p>
                <dl className="mt-2 divide-y divide-bg-border/60">
                  {group.rows.map((row) => (
                    <div key={row.label} className="flex items-baseline justify-between gap-3 py-1.5">
                      <dt className="text-xs text-fg-dim">{row.label}</dt>
                      <dd className="shrink-0 text-xs font-medium tabular-nums text-fg-muted">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        )}
        {/* The unverified directory status used to be repeated here too. It
            renders once now, in the BusinessFacts block at the top of the
            page, labelled for what it is. */}
      </BattleSection>
    </>
  );
}

/**
 * The radar and the dimension list, sharing one selection, with the detail for
 * the selected dimension rendered beneath them.
 *
 * The selection model is why the full fault list can default closed: a rep who
 * taps "Looking credible" sees, in place, what is failing there, what the
 * biggest gap costs, and how it sits against the best local competitor --
 * without scrolling away from the chart they were narrating. The accessible
 * path is the list (real buttons, aria-pressed); the radar's hit areas are a
 * pointer convenience over the same state, which matters because the radar
 * itself is display:none below `sm`.
 *
 * Defaults to the WORST dimension rather than to nothing: the empty state of a
 * detail panel is a question ("tap something?"), and the worst area is the one
 * the rep was going to tap anyway -- it is the same ordering logic the angle
 * selection already uses.
 */
function DimensionShape({
  dimensions, worstFirst, competitors, drawn, reduced,
}: {
  dimensions: DimensionProfile[];
  worstFirst: DimensionProfile[];
  competitors: CompetitorContext | null;
  drawn: boolean;
  reduced: boolean;
}) {
  const bus = useBattleSections();
  const [selected, setSelected] = useState<string | null>(null);
  const sel = selected ?? worstFirst[0]?.key ?? null;
  const dim = dimensions.find((d) => d.key === sel) || null;
  const headToHead = competitors?.headToHead || null;
  const leaderFor = dim ? headToHead?.dimensions.find((l) => l.key === dim.key) || null : null;
  const misses = dim ? dim.checks.filter((c) => !c.has).sort((a, b) => b.points - a.points) : [];

  function jumpToFaults() {
    if (!bus || !dim) return;
    bus.openOne("faults");
    const anchor = `battle-dim-${dim.key}`;
    // The section's content mounts on open, so the anchor does not exist until
    // the next paint. One short timeout, then scroll; instant under reduced
    // motion, because a page that lurches is motion too.
    window.setTimeout(() => {
      document.getElementById(anchor)?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    }, 90);
  }

  return (
    <>
      {/* THE RADAR IS HIDDEN BELOW `sm`, AND NOTHING REPLACES IT, because
          nothing has to. A seven-axis radar with wrapped labels is drawn
          in a 420x340 viewBox; scaled into 326px of card it is a shape a
          rep cannot read a single value off, and a chart that cannot be
          read is worse than no chart -- it looks like information.
          The seven dimension buttons below already carry every number the
          radar encodes, labelled, in one column, and they were always
          there. So the phone gets the buttons and the desktop gets both.
          (The radar's own `aria-label` names all seven scores, so a screen
          reader was never getting the picture either way.) */}
      <div className="hidden justify-center sm:flex">
        <Radar
          dimensions={dimensions}
          leader={headToHead?.dimensions.map((d) => ({ key: d.key, leader: d.leader })) || null}
          leaderName={headToHead?.competitor.name || null}
          drawn={drawn}
          reduced={reduced}
          selected={sel}
          onSelect={setSelected}
        />
      </div>
      <div className="mt-4 space-y-1 sm:border-t sm:border-bg-border sm:pt-4">
        {dimensions.map((d) => {
          const active = d.key === sel;
          return (
            <button
              key={d.key}
              type="button"
              onClick={() => setSelected(d.key)}
              aria-pressed={active}
              className={`block w-full rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none ${active ? "bg-bg-raised/70" : "hover:bg-bg-raised/40"}`}
            >
              <span className="flex items-center justify-between gap-3 text-xs">
                <span className={active ? "font-semibold text-fg" : "text-fg-muted"}>{d.label}</span>
                <span className={`tabular-nums ${active ? "text-fg" : "text-fg-dim"}`}>{d.score}</span>
              </span>
              <span className="mt-1 block"><Meter value={d.score} drawn={drawn} reduced={reduced} /></span>
            </button>
          );
        })}
      </div>

      {dim && (
        <div className="mt-4 rounded-lg border border-bg-border bg-bg-raised/60 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-semibold text-fg">{dim.label}</p>
            <p className="text-xs text-fg-muted">
              Scores <span className="tabular-nums text-fg">{dim.score}</span> ·{" "}
              {misses.length === 0
                ? "nothing failing here"
                : `${misses.length} of ${dim.checks.length} ${misses.length === 1 ? "check" : "checks"} failing`}
            </p>
          </div>
          {misses.length === 0 ? (
            <p className="mt-2 text-sm text-fg-dim">Everything we check in this area passed.</p>
          ) : (
            <div className="mt-2.5">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">Biggest gap in this area</p>
              <p className="mt-1 text-sm font-semibold text-fg">{misses[0].label}</p>
              <RemedyLines code={misses[0].code} />
            </div>
          )}
          {leaderFor && headToHead && (
            <div className="mt-3 border-t border-bg-border pt-3">
              <p className="text-xs tabular-nums text-fg-dim">
                <span className="font-semibold text-fg">{leaderFor.theirs}</span> vs {headToHead.competitor.name} at{" "}
                {leaderFor.leader}
                {/* A signed number, not a colour and not an arrow. The sign is
                    a fact about two measurements; a red arrow is a verdict. */}
                <span className="ml-2 text-fg-muted">({leaderFor.diff > 0 ? "+" : ""}{leaderFor.diff})</span>
              </p>
              <div className="mt-1.5"><TwoUpTrack theirs={leaderFor.theirs} leader={leaderFor.leader} drawn={drawn} reduced={reduced} /></div>
            </div>
          )}
          {misses.length > 0 && bus && (
            <button
              type="button"
              onClick={jumpToFaults}
              className="mt-3 inline-flex items-center gap-1 rounded text-[11px] font-semibold text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none"
            >
              See {misses.length === 1 ? "the failing check" : `all ${misses.length} failing checks`} in this area
              <ChevronDown aria-hidden className="h-3 w-3 -rotate-90" />
            </button>
          )}
        </div>
      )}
    </>
  );
}

/**
 * The ranked fix list, with the checks behind each rank one tap away.
 *
 * Each row expands IN PLACE to the failing checks it is made of, so "worth
 * +9.8" is never an unexplained number: the rep taps it and reads exactly
 * which checks make up the claim, in the remedy language the rest of the card
 * speaks. No per-check number is printed here on purpose -- a check's raw
 * points and a dimension's weighted recoverable points are different scales,
 * and two numbers on one row that do not sum invite the prospect's next
 * question to be about our arithmetic instead of their website.
 */
function FixFirst({
  worstFirst, maxRecoverable, totalAreas, totalChecks, drawn, reduced,
}: {
  worstFirst: DimensionProfile[];
  maxRecoverable: number;
  totalAreas: number;
  totalChecks: number;
  drawn: boolean;
  reduced: boolean;
}) {
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(new Set());

  function toggle(key: string) {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <>
      <ul className="space-y-1.5">
        {worstFirst.map((d) => {
          const points = recoverablePoints(d);
          const misses = d.checks.filter((c) => !c.has).sort((a, b) => b.points - a.points);
          const expandable = misses.length > 0;
          const openRow = openKeys.has(d.key);
          const row = (
            <>
              <span className="flex items-baseline justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-1.5">
                  {expandable && (
                    <ChevronDown
                      aria-hidden
                      className={`h-3.5 w-3.5 shrink-0 text-fg-dim transition-transform motion-reduce:transition-none ${openRow ? "" : "-rotate-90"}`}
                    />
                  )}
                  <span className="truncate text-fg">{d.label}</span>
                  {expandable && (
                    <span className="shrink-0 text-[10px] text-fg-faint">
                      {misses.length} {misses.length === 1 ? "check" : "checks"}
                    </span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums text-fg-muted">+{points.toFixed(1)}</span>
              </span>
              <span className="mt-1.5 block">
                <Meter value={(points / maxRecoverable) * 100} drawn={drawn} reduced={reduced} />
              </span>
            </>
          );
          return (
            <li key={d.key}>
              {expandable ? (
                <button
                  type="button"
                  onClick={() => toggle(d.key)}
                  aria-expanded={openRow}
                  className="block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-bg-raised/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none"
                >
                  {row}
                </button>
              ) : (
                // A full-marks area has nothing to expand and says so instead
                // of rendering a control that does nothing.
                <div className="px-2 py-1.5">{row}</div>
              )}
              {expandable && openRow && (
                <ul className="mb-1.5 ml-2 mt-1 space-y-2.5 rounded-lg border border-bg-border bg-bg-raised/60 p-3">
                  {misses.map((check) => (
                    <li key={check.code}>
                      <p className="text-sm font-semibold text-fg">{check.label}</p>
                      <RemedyLines code={check.code} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-4 border-t border-bg-border pt-3 text-xs text-fg-dim">
        {totalAreas} areas, {totalChecks} individual checks. Everything failing is listed below with what each one
        costs them.
      </p>
    </>
  );
}

/**
 * Head to head against real, named, locally-measured competitors.
 *
 * This is the section the operator asked for and the reason the rest of it is
 * worth reading: "produce competitors that do use AI, that do have an online
 * footprint, and then compare that to what they currently have." We do not have
 * to guess who those are. They are in the corpus, in the same industry and the
 * same city, already scored on the same 49 checks.
 *
 * Renders CONTENT ONLY: the section shell, the heading and the explanatory
 * line live in the BattleSection that wraps it in ScoredBody, so the heading
 * doubles as the disclosure control like every other section on the card.
 */
function Competitors({
  competitors, audit, lead, drawn, reduced,
}: {
  competitors: CompetitorContext | null;
  audit: Extract<AuditResult, { state: "scored" }>;
  lead: WebLead;
  drawn: boolean;
  reduced: boolean;
}) {
  if (!competitors) {
    return (
      <p className="text-sm text-fg-muted">
        We have not measured enough other businesses to compare this one against yet.
      </p>
    );
  }

  const { slice, top, headToHead } = competitors;

  return (
    <>
      <ul className="grid gap-3 md:grid-cols-3">
        {top.map((c, i) => {
          const href = preferredSiteUrl(c.websiteUrl);
          return (
            <li
              key={`${c.name}-${i}`}
              className="rounded-lg border border-bg-border bg-bg-raised/60 p-4 hover:border-accent/30"
              style={{
                opacity: drawn ? 1 : 0,
                transform: drawn ? "none" : "translateY(6px)",
                transition: reduced ? "none" : `opacity 320ms ease-out ${i * 60}ms, transform 320ms ease-out ${i * 60}ms`,
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-fg">{c.name}</p>
                  <p className="mt-0.5 truncate text-xs text-fg-dim">
                    {[c.city, c.province].filter(Boolean).join(", ") || "Location not recorded"}
                  </p>
                </div>
                <span className="shrink-0 text-2xl font-bold leading-none tabular-nums text-fg">{c.score}</span>
              </div>
              {href && (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-bg-border px-2.5 py-1.5 text-[11px] font-semibold text-fg-muted transition-[color,border-color,transform] hover:border-accent/40 hover:text-fg active:translate-y-px focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none"
                >
                  <ExternalLink className="h-3 w-3" />Open their site
                </a>
              )}
            </li>
          );
        })}
      </ul>

      {headToHead && (
        <div className="mt-6 border-t border-bg-border pt-5">
          <p className="text-sm font-semibold text-fg">
            {lead.name} against {headToHead.competitor.name}, area by area
          </p>
          {/* "The best-scoring" is only said when it IS the best-scoring.
              buildHeadToHead falls through to the next candidate when the top
              one has no readable profile, and calling that one the best is a
              false claim about a named business made on a live call -- in
              exactly the case the fallback exists to handle. (Codex review,
              2026-08-24.) */}
          <p className="mt-1 text-xs text-fg-dim">
            {headToHead.rankInSlice === 1
              ? `The best-scoring of the ${fmt(slice.peerCount)} ${slice.label} we have measured, last checked ${formatDate(headToHead.measuredAt)}.`
              : `Among the top-scoring ${slice.label} we have measured, last checked ${formatDate(headToHead.measuredAt)}. We do not hold an area-by-area breakdown for the highest-scoring one, so this is the closest that we do.`}{" "}
            It scores {headToHead.composite} where this one scores {audit.composite}.
          </p>
          <ul className="mt-4 space-y-3">
            {headToHead.dimensions.map((d) => (
              <li key={d.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5">
                <span className="text-xs text-fg-muted">{d.label}</span>
                <span className="text-xs tabular-nums text-fg-dim">
                  <span className="font-semibold text-fg">{d.theirs}</span> vs {d.leader}
                  {/* A signed number, not a colour and not an arrow. The sign is
                      a fact about two measurements; a red arrow is a verdict. */}
                  <span className="ml-2 text-fg-muted">({d.diff > 0 ? "+" : ""}{d.diff})</span>
                </span>
                <div className="col-span-2">
                  <TwoUpTrack theirs={d.theirs} leader={d.leader} drawn={drawn} reduced={reduced} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * One 0-100 track carrying both scores: a filled bar for this lead and a tick
 * for the competitor.
 *
 * Deliberately not two stacked bars. Two bars invite a rep to read the LENGTHS
 * against each other, which is a comparison of two absolute scores; one track
 * with a tick puts the eye on the distance between them, which is the thing
 * being sold. Both marks are the same neutral colour.
 */
function TwoUpTrack({ theirs, leader, drawn, reduced }: { theirs: number; leader: number; drawn: boolean; reduced: boolean }) {
  const t = Math.min(100, Math.max(0, theirs));
  const l = Math.min(100, Math.max(0, leader));
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-bg-border" aria-hidden>
      <div
        className="absolute inset-y-0 left-0 rounded-full bg-fg-dim"
        style={{ width: drawn ? `${t}%` : "0%", transition: reduced ? "none" : "width 420ms cubic-bezier(0.22, 1, 0.36, 1)" }}
      />
      <div
        className="absolute inset-y-0 w-0.5 bg-fg"
        style={{ left: `calc(${l}% - 1px)`, opacity: drawn ? 1 : 0, transition: reduced ? "none" : "opacity 420ms ease-out 120ms" }}
      />
    </div>
  );
}

export default BattleCard;
