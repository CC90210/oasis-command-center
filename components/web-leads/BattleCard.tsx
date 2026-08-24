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
 * cannot scroll a narrow column looking for the thing they were about to say,
 * and every `<details>` on that column is a click they will not make while a
 * stranger is waiting. So: full width, everything open, nothing behind a
 * disclosure.
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
 *    banning the colour classes outright in this file.
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
import { ArrowLeft, ExternalLink, Phone } from "lucide-react";
import type { AuditResult, CheckResult, DimensionProfile } from "@/lib/web-leads/audit";
import type { CompetitorContext } from "@/lib/web-leads/competitors";
import type { WebLead } from "@/lib/web-leads/data";
import { preferredSiteUrl } from "@/lib/web-leads/url-safety";
import { remedyFor } from "@/lib/web-leads/remedies";
import { selectAngle, recoverablePoints } from "@/lib/web-leads/angles";
import { evidenceFrom } from "@/lib/web-leads/evidence";
import { CallOutcomeLog } from "./CallOutcomeLog";
import { ObjectionPanel } from "./ObjectionPanel";

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
  dimensions, leader, leaderName, drawn, reduced,
}: {
  dimensions: DimensionProfile[];
  leader: { key: string; leader: number }[] | null;
  leaderName: string | null;
  drawn: boolean;
  reduced: boolean;
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
      {/* Spokes */}
      {dimensions.map((d, i) => {
        const p = radarPoint(i, n, 100);
        return <line key={d.key} x1={RADAR.cx} y1={RADAR.cy} x2={p.x} y2={p.y} stroke="currentColor" strokeOpacity={0.16} strokeWidth={1} />;
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
        {theirs.map((p, i) => (
          <circle key={dimensions[i].key} cx={p.x} cy={p.y} r={2.6} className="fill-fg" fillOpacity={0.9} />
        ))}
      </g>

      {/* Axis labels, using the model's own rep-facing names. */}
      {dimensions.map((d, i) => {
        const p = radarPoint(i, n, 100);
        const dx = p.x - RADAR.cx;
        const lx = RADAR.cx + (dx / RADAR.r) * RADAR.labelR;
        const ly = RADAR.cy + ((p.y - RADAR.cy) / RADAR.r) * RADAR.labelR;
        const anchor = Math.abs(dx) < 12 ? "middle" : dx > 0 ? "start" : "end";
        const lines = wrapLabel(d.label);
        return (
          <text
            key={d.key}
            x={lx}
            y={ly - (lines.length - 1) * 5}
            textAnchor={anchor}
            className="fill-fg-muted text-[10px]"
            style={{ fontSize: 10 }}
          >
            {lines.map((line, li) => (
              <tspan key={line} x={lx} dy={li === 0 ? 0 : 11}>{line}</tspan>
            ))}
          </text>
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

function NotScored({ audit, lead }: { audit: AuditResult; lead: WebLead }) {
  const sentence =
    audit.state === "no_website"
      ? "No website found yet, needs checking"
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
        chart. Everything the directory recorded is below, and it has not been verified by anyone.
      </p>
      {/* VERBATIM — the directory's own hedged wording, never shortened. */}
      <p className="mt-4 text-sm italic text-fg-dim">{lead.websiteCondition}</p>
      <p className="mt-1 text-sm italic text-fg-dim">{lead.auditFindings}</p>
    </Panel>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// The card
// ───────────────────────────────────────────────────────────────────────────

export function BattleCard({ leadId }: { leadId: string }) {
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
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <BackLink />
        <p className="mt-6 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">{error}</p>
      </div>
    );
  }

  if (state.status === "loading") return <CardSkeleton />;

  const { lead, audit, competitors, signals } = state.payload;

  return (
    <div className="min-h-screen bg-bg">
      <Hero lead={lead} audit={audit} competitors={competitors} drawn={drawn} reduced={reduced} />
      <div className="mx-auto max-w-6xl space-y-5 px-4 pb-16 lg:px-8">
        {audit.state !== "scored" ? (
          <NotScored audit={audit} lead={lead} />
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
              a second one above it. */}
          <CallOutcomeLog leadId={leadId} />
        </Panel>
      </div>
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

function CardSkeleton() {
  return (
    <div className="min-h-screen bg-bg">
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
  lead, audit, competitors, drawn, reduced,
}: {
  lead: WebLead;
  audit: AuditResult;
  competitors: CompetitorContext | null;
  drawn: boolean;
  reduced: boolean;
}) {
  const websiteHref = preferredSiteUrl(lead.websiteUrl);
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
      <div className="relative mx-auto max-w-6xl px-4 py-7 lg:px-8 lg:py-9">
        <BackLink />
        <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-3xl font-bold leading-tight tracking-tight text-fg lg:text-4xl">{lead.name}</h1>
            <p className="mt-2 text-sm text-fg-muted">
              {[lead.industry, [lead.city, lead.province].filter(Boolean).join(", ")].filter(Boolean).join(" · ") ||
                "No location on file"}
            </p>
            <div className="mt-5 flex flex-wrap gap-2.5">
              {lead.phone ? (
                <a
                  href={`tel:${lead.phone}`}
                  className="inline-flex items-center gap-2.5 rounded-lg bg-gradient-to-br from-accent to-accent-muted px-5 py-3 text-base font-bold tabular-nums text-white shadow-[0_0_0_1px_rgba(59,130,246,0.18),0_10px_28px_-10px_rgba(59,130,246,0.5)] transition-[filter,transform] hover:brightness-110 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 motion-reduce:transition-none"
                >
                  <Phone className="h-4 w-4" />{lead.phone}
                </a>
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
                  className="inline-flex items-center gap-2 rounded-lg border border-bg-border bg-bg-panel px-4 py-3 text-sm font-semibold text-fg transition-[color,border-color,transform] hover:border-accent/40 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 motion-reduce:transition-none"
                >
                  <ExternalLink className="h-4 w-4" />Open their site
                </a>
              )}
            </div>
          </div>

          <div className="shrink-0 lg:text-right">
            {audit.state === "scored" ? (
              <>
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-fg-muted">Website score</p>
                <p className="mt-1 text-7xl font-bold leading-none tracking-tight tabular-nums text-fg drop-shadow-[0_0_22px_rgba(59,130,246,0.26)]">
                  {audit.composite}
                </p>
                <p className="mt-2 text-xs text-fg-dim">Measured {formatDate(audit.measuredAt)}</p>
              </>
            ) : (
              <p className="max-w-xs text-base font-semibold leading-snug text-fg-muted">
                {audit.state === "no_website"
                  ? "No website found yet, needs checking"
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

  return (
    <>
      {/* ── §4, depth one: THE ONE LINE ─────────────────────────────────── */}
      {headline && (
        <Panel>
          <SectionTitle>The one thing to lead with</SectionTitle>
          {/* Stated as its CONSEQUENCE, not its cause. remedies.ts's `costs`
              line is hand-written to be read aloud; the check's own label
              ("Tappable phone number") is a defect name and nobody sells one. */}
          <p className="mt-3 max-w-4xl text-xl font-semibold leading-snug text-fg lg:text-2xl">
            {remedyFor(headline.code)?.costs || headline.label}
          </p>
          <p className="mt-2 text-xs text-fg-dim">
            Biggest single gap on the site, out of {failed.length} failed {failed.length === 1 ? "check" : "checks"}.
          </p>
        </Panel>
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
        <Panel>
          <SectionTitle>How to open</SectionTitle>
          <p className="mt-1 text-xs text-fg-dim">
            Chosen because {angle.label.toLowerCase()} is losing them more of the score than anything else. Say your
            own name and company first, then these three in order.
          </p>

          <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
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
        </Panel>
      )}

      {/* ── The objections that arrive whatever the site looks like ──────── */}
      <ObjectionPanel />

      {/* ── §3.2 radar + §3.3 points on the table ───────────────────────── */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel>
          <SectionTitle>What kind of bad is it</SectionTitle>
          <div className="mt-3 flex justify-center">
            <Radar
              dimensions={audit.dimensions}
              leader={competitors?.headToHead?.dimensions.map((d) => ({ key: d.key, leader: d.leader })) || null}
              leaderName={competitors?.headToHead?.competitor.name || null}
              drawn={drawn}
              reduced={reduced}
            />
          </div>
          <div className="mt-4 space-y-2.5 border-t border-bg-border pt-4">
            {audit.dimensions.map((d) => (
              <div key={d.key}>
                <div className="flex items-center justify-between text-xs text-fg-muted">
                  <span>{d.label}</span>
                  <span className="tabular-nums text-fg-dim">{d.score}</span>
                </div>
                <div className="mt-1"><Meter value={d.score} drawn={drawn} reduced={reduced} /></div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <SectionTitle>What is worth fixing first</SectionTitle>
          <p className="mt-1 text-xs text-fg-dim">
            Points back on the total score if that area were brought to full marks. This is the build, in order.
          </p>
          <ul className="mt-4 space-y-3.5">
            {worstFirst.map((d) => {
              const points = recoverablePoints(d);
              return (
                <li key={d.key}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-fg">{d.label}</span>
                    <span className="shrink-0 tabular-nums text-fg-muted">+{points.toFixed(1)}</span>
                  </div>
                  <div className="mt-1.5">
                    <Meter value={(points / maxRecoverable) * 100} drawn={drawn} reduced={reduced} />
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-4 border-t border-bg-border pt-3 text-xs text-fg-dim">
            {audit.dimensions.length} areas, {audit.dimensions.reduce((n, d) => n + d.checks.length, 0)} individual
            checks. Everything failing is listed below with what each one costs them.
          </p>
        </Panel>
      </div>

      {/* ── The competitors ─────────────────────────────────────────────── */}
      <Competitors competitors={competitors} audit={audit} lead={lead} drawn={drawn} reduced={reduced} />

      {/* ── §4, depth two: THE CASE, BY DIMENSION ───────────────────────── */}
      <Panel>
        <SectionTitle>Everything wrong with this site</SectionTitle>
        <p className="mt-1 text-xs text-fg-dim">
          Grouped by what it affects, worst first. Three separate things wrong with how a site earns trust is an
          argument; nineteen bullet points is noise.
        </p>
        <div className="mt-5 space-y-6">
          {worstFirst.map((d) => {
            const misses = d.checks.filter((c) => !c.has);
            return (
              <div key={d.key} className="border-t border-bg-border pt-4 first:border-t-0 first:pt-0">
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
      </Panel>

      {/* ── §4, depth three: THE EVIDENCE ───────────────────────────────── */}
      <Panel>
        <SectionTitle>What we actually measured</SectionTitle>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-fg-dim">
          The raw crawl, for when a prospect says they redid the site last year. Every line is something the crawler
          saw on {formatDate(audit.measuredAt)}; anything it did not record is not listed rather than shown as a zero.
        </p>
        {evidence.length === 0 ? (
          <p className="mt-4 text-sm text-fg-muted">
            No raw measurements were stored alongside this score, so there is nothing to quote here.
          </p>
        ) : (
          <div className="mt-5 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
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
        <p className="mt-5 border-t border-bg-border pt-3 text-xs italic text-fg-dim">
          Directory status, unverified: {lead.websiteCondition}
        </p>
      </Panel>
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
      <Panel>
        <SectionTitle>Who they are up against</SectionTitle>
        <p className="mt-3 text-sm text-fg-muted">
          We have not measured enough other businesses to compare this one against yet.
        </p>
      </Panel>
    );
  }

  const { slice, top, headToHead } = competitors;

  return (
    <Panel>
      <SectionTitle>Who they are up against</SectionTitle>
      <p className="mt-1 text-xs text-fg-dim">
        The best-scoring {slice.label} we have measured, on the same{" "}
        {audit.dimensions.reduce((n, d) => n + d.checks.length, 0)} checks. Real businesses, open any of them while you
        are on the call.
      </p>

      <ul className="mt-4 grid gap-3 md:grid-cols-3">
        {top.map((c, i) => {
          const href = preferredSiteUrl(c.websiteUrl);
          return (
            <li
              key={`${c.name}-${i}`}
              className="rounded-lg border border-bg-border bg-bg-raised/60 p-4"
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
    </Panel>
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
