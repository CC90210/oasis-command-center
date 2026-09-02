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
 * ═══ THE FUTURIST CHROME (Adon, 2026-08-31 round 2; 2026-09-01 round 3) ═════
 *
 * Round 2 ("even nicer and 3D, a futuristic look"): glass panels with a lit
 * top edge (BattleSection + Panel share it), blueprint grid + HUD corner
 * brackets on the hero, the score counting up inside a ring that draws once,
 * a perspective-tilted radar, competitor cards that tilt in 3D under the
 * cursor, glow hovers on the controls.
 *
 * Round 3 ("Iron Man" -- the full HUD): the radar became a HOLOGRAM STACK
 * (four SVG layers lifted to different Z depths inside one preserve-3d tilt,
 * so they parallax against each other -- see the Radar docblock), every
 * dimension gained a fixed identity hue worn on its vertex, label, list dot
 * and meter, the benchmark competitor wears GOLD everywhere it appears, the
 * score ring became an arc reactor (gradient stroke, pulsing halo), numerals
 * and headings moved to a display face (Chakra Petch, self-hosted at build --
 * zero runtime requests), and the radar carries one piece of AMBIENT
 * decorative motion, a slowly rotating tick ring.
 *
 * Round 4 (2026-09-01, "take a big leap... I'm saying 3D imaging"): the radar
 * became a REAL WebGL hologram -- see Radar3D.tsx -- with the 2D SVG stack
 * kept intact as the automatic fallback (phones, reduced motion, no WebGL,
 * failed import: the card degrades to round 3, never to blank). A plexus
 * particle canvas breathes behind the hero (the video-background ask, with
 * no video asset), meters became segmented HUD readouts, the distribution
 * strip went neon, and telemetry values moved to JetBrains Mono
 * (--battle-data) beside Space Grotesk display (--battle-display), both from
 * the already-vendored woff2.
 *
 * Round 5 (2026-09-01, "even cooler... really outlining the graph of what
 * type of bad it is"): the display face became Chakra Petch with Orbitron on
 * the hero numeral alone (both vendored, see OFL.md), the WebGL radar gained
 * real bloom, beam sheaths, a radar sweep and PROJECTED LABELS so the chart
 * names its own axes (Radar3D.tsx), every Panel wears the hero's corner
 * marks, and the shape section opens with the DESIGNATION PLATE: the
 * hand-written name for the shape of this lead's problem (lead-profile.ts --
 * "Invisible storefront", "Full rebuild"), chosen by arithmetic over the
 * same scores the radar draws, so a rep says what the graph shows.
 *
 * Round 7 (2026-09-01, "more interactive... truly next generation"): the
 * stage became something a rep OPERATES, not just watches. Grounded in the
 * FUI research (Jayse Hansen's Iron Man HUD rules: amplify the operator,
 * never distract; ground the fantasy in real instrumentation) and the
 * standard three.js interaction vocabulary (damped inertia, eased camera
 * flights). The hologram BOOTS -- assembles itself once on mount; tapping a
 * beam, a label, a list row or a designation-plate chip FLIES the stage to
 * that dimension behind one shared selection owned by ScoredBody; a
 * targeting reticle in the dimension's identity hue assembles at the
 * selected beam's foot; a released drag carries inertia and decays;
 * double-click resets the camera. Hover only brightens -- selection is a
 * deliberate tap, so casual pointer travel never yanks the camera. The
 * sheaths and score surface moved to hand-rolled fresnel shaders
 * (Radar3D.tsx header explains which of them may animate and why).
 *
 * Round 8 (2026-09-01, "maximize it without any expenses... open sourced
 * repos if you need"): everything zero-asset, zero-dependency. SOUND,
 * synthesized from oscillators at play time (battle-sfx.ts -- no audio
 * files exist and none may be added), attached to the operator's own
 * actions only, OFF BY DEFAULT because this card sits next to a live phone
 * call, opt-in per rep via the SFX toggle on the stage. The designation
 * name resolves through a glyph DECODE on mount (a string permutation, not
 * a library; aria-label carries the real name). The targeting reticle
 * gained a lock-on burst. Patterns mined from the open-source FUI space
 * (Arwes's sound-per-interaction grammar) without taking the dependency.
 *
 * Round 9 (2026-09-02, the audit round: "a full audit... the final
 * iteration that will be a 10/10"): physics and wayfinding. No visual
 * state may SNAP -- the stage's selection and hover emphasis blend through
 * frame-rate-normalized damped mixes (Radar3D), meters draw with transform
 * instead of width (compositor, not layout), sections animate open/close
 * PHYSICALLY via grid-rows with closed content inert, every eyebrow label
 * speaks the display face, and the SectionToolbar became the card's
 * COMMAND STRIP: a sticky HUD tab per section, registry-driven, each
 * showing its drawer's state and jumping a rep anywhere in one tap.
 * All pinned by §8j.
 *
 * What keeps the theatre honest: chrome is keyed to NOTHING (a 4 and a 94 get
 * identical treatment -- rule 1 survives the decoration); ambient motion is
 * confined to decorative layers that carry no data (the rotating tick ring,
 * the particle drifts, the idle orbit of the 3D stage -- the pillars and
 * surfaces on that stage encode scores and rotate rigidly with it, never by
 * themselves); pointer-driven motion is the rep's own hand echoed back; and
 * `prefers-reduced-motion` flattens ALL of it -- tilts render flat, fades
 * render settled, the ring, count and rotation render finished and still,
 * and the WebGL scene is simply never mounted (rule 4). The old "CSS 3D,
 * deliberately not three.js" weight rule was overridden by the operator for
 * this one chart; what survives is its cost discipline -- three.js is
 * code-split and loaded only where the scene actually runs (Radar3D.tsx).
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
 * 1. NO COLOUR IS KEYED TO A SCORE. Colour on this card answers exactly two
 *    questions and neither is "how good is it": WHICH area (each dimension
 *    wears one fixed hue from DIM_HUES -- trust is that blue at 4 and at 94)
 *    and WHOSE mark (the prospect is always cyan, the benchmark competitor is
 *    always gold). The palette is deliberately cool-spectrum with no
 *    traffic-light red or green, because a red 22 renders a judgement the
 *    measurement does not support, and a rep who sees red says something they
 *    cannot back up. tests/web-leads-guards.test.ts still bans the verdict
 *    colour classes outright in this file, and selection only BRIGHTENS a
 *    dimension's own hue -- it follows the rep's tap, never the value.
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

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import localFont from "next/font/local";
import { ArrowLeft, ChevronDown, ExternalLink, Phone } from "lucide-react";
import type { AuditResult, CheckResult, DimensionProfile, UrlVerification, RecheckStatus } from "@/lib/web-leads/audit";
import { assessTrust, type TrustAssessment } from "@/lib/web-leads/trust";
import type { CompetitorContext } from "@/lib/web-leads/competitors";
import type { WebLead } from "@/lib/web-leads/data";
import { preferredSiteUrl } from "@/lib/web-leads/url-safety";
import { remedyFor } from "@/lib/web-leads/remedies";
import { selectAngle, recoverablePoints, IF_THE_ANSWER_IS_CLEAN } from "@/lib/web-leads/angles";
import { evidenceFrom } from "@/lib/web-leads/evidence";
import { checkEvidenceFor } from "@/lib/web-leads/check-evidence";
import { BusinessFacts, fullAddress } from "./BusinessFacts";
import { CallOutcomeLog } from "./CallOutcomeLog";
import { ObjectionPanel } from "./ObjectionPanel";
import { BattleSection, BattleSections, SectionToolbar, useBattleSections } from "./BattleSection";
import { hueFor, GOLD, CYAN } from "./battle-hud";
import { Radar3D } from "./Radar3D";
import { sfx } from "./battle-sfx";
import { designateLead } from "@/lib/web-leads/lead-profile";
import { IndustryAutomationGuide } from "@/components/playbook/IndustryAutomationGuide";

/**
 * The display face for the HUD (round 3: "a nicer font"; round 5, Adon: "a
 * nicer, cooler looking font"). Round 4 borrowed the marketing site's Space
 * Grotesk; round 5 gives the card its OWN voice: Chakra Petch, a squared
 * mechanical face drawn for instrument panels -- it reads as HUD chrome in a
 * section title and stays legible in a 10px tracking-wide label. Vendored
 * latin woff2 in app/fonts/ (from @fontsource, see OFL.md), loaded with
 * next/font/local, never next/font/google: tests/font-selfhost.test.ts bans
 * the build-time Google fetch that failed two deploys in August. Scoped to
 * this card through a CSS variable on its root; nothing outside the battle
 * card inherits it.
 */
const displayFont = localFont({
  src: [
    { path: "../../app/fonts/ChakraPetch-500.woff2", weight: "500", style: "normal" },
    { path: "../../app/fonts/ChakraPetch-600.woff2", weight: "600", style: "normal" },
    { path: "../../app/fonts/ChakraPetch-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--battle-display",
});

/**
 * The instrument numeral: Orbitron, for the hero score ONLY. One weight, one
 * place -- the arc reactor gets a dial face and nothing else does, which is
 * what keeps it special. Same vendored-woff2 discipline as the other faces.
 */
const numeralFont = localFont({
  src: [{ path: "../../app/fonts/Orbitron-700.woff2", weight: "700", style: "normal" }],
  variable: "--battle-numeral",
});

/**
 * The telemetry face: JetBrains Mono (also already vendored, also loaded
 * locally) for every measured value -- scores, points, crawl readouts. A
 * monospaced figure reads as an instrument, and two different values can
 * never render at two different widths mid-call.
 */
const dataFont = localFont({
  src: [
    { path: "../../app/fonts/JetBrainsMono-400.woff2", weight: "400", style: "normal" },
    { path: "../../app/fonts/JetBrainsMono-500.woff2", weight: "500", style: "normal" },
  ],
  variable: "--battle-data",
});

// The identity palette (one fixed hue per dimension, cyan = prospect,
// GOLD = benchmark) moved to ./battle-hud.ts so the WebGL radar shares the
// exact same colours -- two charts disagreeing about which blue is "trust"
// is the palette version of two copies of an address. Full rationale and the
// identity-never-verdict rule live in that module's header.

type Payload = {
  lead: WebLead;
  audit: AuditResult;
  competitors: CompetitorContext | null;
  signals: Record<string, unknown> | null;
  urlVerification?: UrlVerification | null;
  recheck?: RecheckStatus | null;
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

/**
 * Resolves `text` through a brief glyph scramble, once, on mount -- the
 * decode-in every FUI plate uses (round 8, zero-asset: it is a string
 * permutation, not an animation library). Reduced motion renders the final
 * text immediately, and the caller carries the real text in an aria-label
 * so assistive tech never hears an intermediate frame.
 */
function useDecode(text: string, reduced: boolean): string {
  const [display, setDisplay] = useState(reduced ? text : "");
  useEffect(() => {
    if (reduced) { setDisplay(text); return; }
    const GLYPHS = "<>/|=+*#%";
    const TOTAL = 22;
    let frame = 0;
    let raf = 0;
    const step = () => {
      frame++;
      const solved = Math.floor((frame / TOTAL) * text.length);
      let out = text.slice(0, solved);
      for (let i = solved; i < text.length; i++) out += text[i] === " " ? " " : GLYPHS[(i * 7 + frame) % GLYPHS.length];
      setDisplay(frame >= TOTAL ? text : out);
      if (frame < TOTAL) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, reduced]);
  return display;
}

const fmt = (n: number) => n.toLocaleString("en-US");

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// ───────────────────────────────────────────────────────────────────────────
// Small shared pieces
// ───────────────────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted [font-family:var(--battle-display)]">
      {/* The HUD tab: a small lit dash before every section name, the same
          accent at every score. Purely typographic chrome. */}
      <span aria-hidden className="h-px w-3 shrink-0 bg-accent/60" />
      {children}
    </h2>
  );
}

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`relative overflow-hidden rounded-xl border border-bg-border bg-bg-panel/75 p-5 shadow-card backdrop-blur-sm lg:p-6 ${className}`}>
      {/* Same lit top edge as BattleSection, so the two shells read as one
          system whether a block collapses or not. Keyed to nothing. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent"
      />
      {/* HUD corner marks, echoing the hero's: every instrument panel on the
          card wears the same frame. Constant chrome, keyed to nothing. */}
      <span aria-hidden className="pointer-events-none absolute right-2 top-2 h-3 w-3 border-r border-t border-accent/25" />
      <span aria-hidden className="pointer-events-none absolute bottom-2 left-2 h-3 w-3 border-b border-l border-accent/25" />
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

/**
 * Checks the model scores but cannot currently MEASURE for prospects. Named
 * here so every surface that renders a check says so in the same words
 * instead of letting the rep argue a line we manufactured. `sitemap`: the
 * crawler only fetches robots.txt for our own benchmark sites, so every
 * prospect fails this check by construction (2026-09-01 integrity audit,
 * finding 4). Removing it from the model is a coordinated MODEL_VERSION
 * bump; until then the card refuses to sell it.
 */
const UNMEASURABLE_CHECKS: Record<string, string> = {
  sitemap:
    "This check cannot currently be measured for prospect sites (we never fetch their robots file), so it fails for every prospect. Do not quote it; it is a flaw in our model, not their site.",
};

/**
 * The pinpointed measurement behind one check (Adon, 2026-09-01: "you have to
 * pinpoint things in the website that are showing that"). Renders the
 * crawler's own numbers for THIS site next to the check they decided --
 * "Server took 2,340 ms to send its first byte; under 800 ms earns the
 * point." -- so a score is never a number a rep has to take on faith.
 *
 * Three states, all honest (Adon, 2026-09-01: "you don't generate
 * information, you just say it"):
 *   - measured   -> "Seen on the site: ..." with the site's own numbers
 *   - unmeasured -> the crawl recorded other things but not what THIS check
 *                   needs: said in words, never guessed
 *   - unmeasurable -> a check our model cannot currently measure for any
 *                   prospect: named as our flaw, with an instruction to
 *                   ignore it
 * Only when there is no signals blob at all does nothing render -- there is
 * nothing to distinguish "unrecorded" from "very old row" without one.
 */
function MeasuredLine({ code, signals }: { code: string; signals: Record<string, unknown> | null }) {
  const unmeasurable = UNMEASURABLE_CHECKS[code];
  if (unmeasurable) {
    return (
      <p className="mt-1.5 text-xs leading-relaxed text-fg-dim [font-family:var(--battle-data)]">
        <span className="font-medium text-fg-muted">Not measurable:</span> {unmeasurable}
      </p>
    );
  }
  const line = checkEvidenceFor(code, signals);
  if (line) {
    return (
      <p className="mt-1.5 text-xs leading-relaxed text-fg-muted [font-family:var(--battle-data)]">
        <span className="font-medium" style={{ color: "#7dd3fc" }}>Seen on the site:</span> {line}
      </p>
    );
  }
  if (signals) {
    return (
      <p className="mt-1.5 text-xs leading-relaxed text-fg-dim [font-family:var(--battle-data)]">
        <span className="font-medium text-fg-muted">Not recorded:</span> the crawl did not capture what this check
        needs, so treat this line with caution and verify by eye before quoting it.
      </p>
    );
  }
  return null;
}

/**
 * The honest-sentence panel that replaces the entire scored body when trust
 * says the stored score cannot be stood behind (lib/web-leads/trust.ts).
 * A sentence, never a chart -- the same discipline as NotScored (rule 2).
 * The re-check control lives on the MeasurementHonesty panel directly above.
 */
function UntrustedPanel({ hide }: { hide: NonNullable<TrustAssessment["hide"]> }) {
  return (
    <Panel>
      <SectionTitle>Why there is no score</SectionTitle>
      <p className="mt-3 max-w-3xl text-xl font-semibold leading-snug text-fg">{hide.headline}</p>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-fg-muted">{hide.detail}</p>
    </Panel>
  );
}

/**
 * MeasurementHonesty — what this card knows about its OWN reliability, in one
 * always-visible strip: URL-ownership state, trust warnings, what "measured"
 * means, and the one-lead re-check control (Adon, 2026-09-01: fix bad cards
 * one at a time instead of re-crawling 30,000).
 *
 * Copy rules as everywhere: hand-written, no verdict colours (the verified
 * line uses the constant cyan every telemetry accent uses, worn identically
 * whatever the verdict), no em dashes, nothing generated.
 */
function MeasurementHonesty({
  audit, verification, warnings, hidden, recheck, canMutate, busy, postError, onRecheck,
}: {
  audit: AuditResult;
  verification: UrlVerification;
  warnings: TrustAssessment["warnings"];
  hidden: boolean;
  recheck: RecheckStatus | null;
  canMutate: boolean;
  busy: boolean;
  postError: string | null;
  onRecheck: (url?: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [showHow, setShowHow] = useState(false);
  const open = recheck !== null && (recheck.status === "pending" || recheck.status === "running");

  return (
    <Panel>
      <SectionTitle>How much to trust this card</SectionTitle>
      <div className="mt-3 space-y-2 text-xs leading-relaxed">
        {verification.verdict === "verified" && (
          <p className="text-fg-muted">
            <span className="font-medium" style={{ color: "#7dd3fc" }}>Ownership confirmed.</span> This website was
            verified as this business&apos;s own site
            {verification.verifiedAt ? ` on ${formatDate(verification.verifiedAt)}` : ""}.
          </p>
        )}
        {warnings.map((w) => (
          <p key={w.code} className="text-fg-muted">{w.line}</p>
        ))}
        {audit.state === "scored" && !hidden && (
          <p className="text-fg-dim [font-family:var(--battle-data)]">
            Every number on this card was measured by our crawler on {formatDate(audit.measuredAt)}. Nothing is
            estimated; where we could not measure something, the card says so in words instead of showing a number.
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowHow((v) => !v)}
        aria-expanded={showHow}
        className="mt-3 rounded text-[11px] font-semibold text-fg-dim transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none"
      >
        {showHow ? "Hide how we measure" : "How we measure, and what we cannot see"}
      </button>
      {showHow && (
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-fg-dim motion-safe:animate-fade-in">
          Our crawler reads the homepage&apos;s raw source and up to three of its stylesheets, once. It does not run
          the site&apos;s code the way a browser does, so sites that build their page in the browser can look empty to
          it, and it does not visit other pages, so a contact form living on a contact page is invisible to the
          score. Styling hosted on another domain may not be read. Where any of that makes a number unsafe, this card
          hides the number and says so rather than showing it.
        </p>
      )}

      <div className="mt-4 border-t border-bg-border pt-3">
        {open ? (
          <p className="text-xs text-fg-muted [font-family:var(--battle-data)]">
            Re-check {recheck.status === "running" ? "in progress" : "queued"}, requested{" "}
            {formatDate(recheck.requestedAt)}. This card refreshes itself when the new measurement lands, usually
            within a minute or two.
          </p>
        ) : canMutate ? (
          <>
            {recheck?.status === "failed" && (
              <p className="mb-2 text-xs text-fg-muted">
                The last re-check failed{recheck.error ? `: ${recheck.error}` : ""}. You can try again.
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Correct website link (optional)"
                className="min-w-0 flex-1 rounded-lg border border-bg-border bg-bg-raised/50 px-3 py-2 text-xs text-fg placeholder:text-fg-faint focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 [font-family:var(--battle-data)]"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => onRecheck(url.trim() || undefined)}
                className="shrink-0 rounded-lg border border-accent/40 px-4 py-2 text-xs font-semibold text-fg transition-[color,border-color,box-shadow] hover:border-accent/70 hover:shadow-glow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:opacity-50 motion-reduce:transition-none"
              >
                {busy ? "Queuing…" : "Re-check this site now"}
              </button>
            </div>
            {postError && (
              <p className="mt-2 text-xs text-fg-muted">
                {postError === "invalid_url"
                  ? "That link does not look like a website address. Check it and try again."
                  : postError === "no_url_to_check"
                    ? "There is no website on file to re-check. Paste the business's link first."
                    : `Could not queue the re-check (${postError}). Try again, and tell an operator if it keeps failing.`}
              </p>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-fg-faint">
              Pasting a link records that YOU supplied it, updates the business&apos;s website on file, and re-measures
              that site fresh. Leave it empty to re-measure the link already on file.
            </p>
          </>
        ) : (
          <p className="text-xs text-fg-dim">
            A re-check can be requested by anyone who can work this lead; ask an operator if that is not you.
          </p>
        )}
      </div>
    </Panel>
  );
}

/** The arithmetic behind an area score, from the stored profile itself:
 *  points earned by passing checks, out of the area's 100. */
function earnedPoints(d: DimensionProfile): number {
  return d.checks.reduce((n, c) => n + (c.has ? c.points : 0), 0);
}

/** The bar's LENGTH is the value; its colour, when a `hue` is given, is the
 *  dimension's fixed identity hue (see battle-hud.ts) -- the same hue at 4 as
 *  at 94, so rule 1 holds. With no hue it stays the neutral fill. The tick
 *  overlay segments the fill into a HUD readout; it is engraved on the track,
 *  identical at every value. */
function Meter({
  value, drawn, reduced, hue,
}: {
  value: number;
  drawn: boolean;
  reduced: boolean;
  hue?: { from: string; to: string };
}) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-bg-border" aria-hidden>
      {/* Drawn with transform, not width (round 9): width is a layout
          property and animating it re-lays-out every frame; scaleX from a
          left origin is the identical picture on the compositor. */}
      <span
        className={hue ? "block h-full rounded-full" : "block h-full rounded-full bg-fg-dim"}
        style={{
          width: `${pct}%`,
          transform: drawn ? "scaleX(1)" : "scaleX(0)",
          transformOrigin: "left",
          transition: reduced ? "none" : "transform 420ms cubic-bezier(0.22, 1, 0.36, 1)",
          background: hue ? `linear-gradient(90deg, ${hue.from}, ${hue.to})` : undefined,
          boxShadow: hue ? `0 0 8px ${hue.to}55` : undefined,
        }}
      />
      <span
        className="absolute inset-0"
        style={{ background: "repeating-linear-gradient(90deg, transparent 0px, transparent 7px, rgba(6,7,10,0.6) 7px, rgba(6,7,10,0.6) 8px)" }}
      />
    </span>
  );
}

/**
 * ParticleField — the drifting plexus behind the hero (Adon, 2026-09-01:
 * "have a video background, whatever it is"). A 2D canvas, ~70 points and
 * the lines between near neighbours: the living-backdrop effect a looping
 * video would give, with no licensed asset, no network fetch, and a couple
 * of kilobytes of code. Chrome, keyed to nothing. Under reduced motion it
 * draws exactly ONE still frame -- texture without motion -- and the loop
 * never starts; a hidden tab pauses it.
 */
function ParticleField({ reduced }: { reduced: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let running = true;
    const size = { w: 0, h: 0 };
    const pts = Array.from({ length: 70 }, () => ({
      x: Math.random(), y: Math.random(),
      vx: (Math.random() - 0.5) * 0.0005, vy: (Math.random() - 0.5) * 0.0005,
    }));
    const frame = (still: boolean) => {
      const { w, h } = size;
      ctx.clearRect(0, 0, w, h);
      if (!still) {
        for (const p of pts) {
          p.x += p.vx; p.y += p.vy;
          if (p.x < 0 || p.x > 1) p.vx *= -1;
          if (p.y < 0 || p.y > 1) p.vy *= -1;
        }
      }
      ctx.fillStyle = "rgba(103,232,249,0.55)";
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      const maxD = 120;
      ctx.lineWidth = 0.6;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = (pts[i].x - pts[j].x) * w;
          const dy = (pts[i].y - pts[j].y) * h;
          const d2 = dx * dx + dy * dy;
          if (d2 < maxD * maxD) {
            ctx.strokeStyle = `rgba(59,130,246,${(0.26 * (1 - Math.sqrt(d2) / maxD)).toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(pts[i].x * w, pts[i].y * h);
            ctx.lineTo(pts[j].x * w, pts[j].y * h);
            ctx.stroke();
          }
        }
      }
      if (!still && running) raf = requestAnimationFrame(() => frame(false));
    };
    const resize = () => {
      size.w = canvas.width = parent.clientWidth || 1;
      size.h = canvas.height = parent.clientHeight || 1;
      if (reduced) frame(true);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    if (reduced) frame(true);
    else raf = requestAnimationFrame(() => frame(false));
    const onVis = () => {
      running = document.visibilityState === "visible";
      cancelAnimationFrame(raf);
      if (running && !reduced) raf = requestAnimationFrame(() => frame(false));
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [reduced]);
  return <canvas ref={ref} aria-hidden className="pointer-events-none absolute inset-0 opacity-50" />;
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

/**
 * The radar, as a HOLOGRAM STACK (Adon, 2026-09-01: "3D-shaped... Iron Man").
 *
 * One component, four layers, each its own SVG so the caller can lift them to
 * different Z depths inside a CSS `preserve-3d` tilt:
 *
 *   base   — grid rings, spokes, labels, the rotating tick ring, the legend.
 *            The only layer with a role: it carries the aria-label naming all
 *            seven scores, so assistive tech reads ONE chart, not four.
 *   shadow — a dark blurred copy of the data polygon, low over the grid. This
 *            is what makes the lifted layer read as floating.
 *   data   — the holographic polygon (cool-spectrum gradient fill, cyan glow
 *            edge), per-dimension hue vertices, and the GOLD dashed benchmark.
 *   hits   — the transparent pointer targets, topmost.
 *
 * When the table tilts, the layers parallax against each other -- real depth,
 * from CSS transforms and ~zero bytes of library. The rotating tick ring is
 * the one AMBIENT motion on the card (Adon: it should feel alive); it is
 * decoration on chrome, carries no data, and is `motion-safe:` gated so
 * reduced-motion users never see it move.
 *
 * Colour on this chart is identity, never verdict: each vertex/label wears its
 * dimension's fixed hue at every score; the prospect's outline is always cyan
 * and the benchmark always gold (rule 1, as restated in the module header).
 */
type RadarLayer = "base" | "shadow" | "data" | "hits";

function Radar({
  dimensions, leader, leaderName, drawn, reduced, selected, onSelect, layer,
}: {
  dimensions: DimensionProfile[];
  leader: { key: string; leader: number }[] | null;
  leaderName: string | null;
  drawn: boolean;
  reduced: boolean;
  /** The dimension the rep is inspecting. Selection brightens its axis; the
   *  hue itself never changes with the value on it (rule 1). */
  selected?: string | null;
  onSelect?: (key: string) => void;
  layer: RadarLayer;
}) {
  const uid = useId();
  const n = dimensions.length;
  if (n < 3) return null;

  const theirs = dimensions.map((d, i) => radarPoint(i, n, d.score));
  const leaderByKey = new Map((leader || []).map((l) => [l.key, l.leader]));
  const leaderPts = leader ? dimensions.map((d, i) => radarPoint(i, n, leaderByKey.get(d.key) ?? 0)) : null;
  const toPath = (pts: { x: number; y: number }[]) => pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  // Draws once on mount, from the centre outward, on every geometry layer at
  // once. transformOrigin is given in user units because SVG has no
  // percentage transform box here.
  const drawnGroupStyle = {
    transformOrigin: `${RADAR.cx}px ${RADAR.cy}px`,
    transform: drawn ? "scale(1)" : "scale(0)",
    transition: reduced ? "none" : "transform 480ms cubic-bezier(0.22, 1, 0.36, 1)",
  } as const;

  if (layer === "shadow") {
    return (
      <svg viewBox={`0 0 ${RADAR.w} ${RADAR.h}`} className="h-full w-full" aria-hidden>
        <g style={drawnGroupStyle}>
          <polygon points={toPath(theirs)} fill="#020617" fillOpacity={0.55} style={{ filter: "blur(6px)" }} />
        </g>
      </svg>
    );
  }

  if (layer === "data") {
    return (
      <svg viewBox={`0 0 ${RADAR.w} ${RADAR.h}`} className="h-full w-full" aria-hidden>
        <defs>
          <radialGradient id={`holo-${uid}`} cx="50%" cy="50%" r="65%">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.45" />
            <stop offset="60%" stopColor="#3b82f6" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.10" />
          </radialGradient>
        </defs>
        <g style={drawnGroupStyle}>
          {/* The benchmark competitor: gold, dashed, softly lit. Gold is WHOSE
              mark this is, worn identically whether it beats the prospect on
              an axis or loses to them. */}
          {leaderPts && (
            <polygon
              points={toPath(leaderPts)}
              fill="none"
              stroke={GOLD}
              strokeOpacity={0.85}
              strokeWidth={1.5}
              strokeDasharray="5 4"
              style={{ filter: `drop-shadow(0 0 4px ${GOLD}66)` }}
            />
          )}
          <polygon
            points={toPath(theirs)}
            fill={`url(#holo-${uid})`}
            stroke="#67e8f9"
            strokeOpacity={0.95}
            strokeWidth={2}
            style={{ filter: "drop-shadow(0 0 6px rgba(34,211,238,0.5))" }}
          />
          {theirs.map((p, i) => {
            const d = dimensions[i];
            const hue = hueFor(d.key);
            const active = selected === d.key;
            return (
              <g key={d.key}>
                {active && <circle cx={p.x} cy={p.y} r={7} fill="none" stroke="#e2e8f0" strokeOpacity={0.9} strokeWidth={1} />}
                <circle
                  cx={p.x} cy={p.y}
                  r={active ? 4 : 3}
                  fill={hue.to}
                  style={{ filter: `drop-shadow(0 0 4px ${hue.to})` }}
                />
              </g>
            );
          })}
        </g>
      </svg>
    );
  }

  if (layer === "hits") {
    return (
      <svg viewBox={`0 0 ${RADAR.w} ${RADAR.h}`} className="h-full w-full">
        {/* Invisible hit targets, one per axis, covering the vertex and the
            label. aria-hidden on purpose: the dimension list next to this
            chart is the accessible, keyboard-reachable way to make the same
            selection, and it is ALWAYS rendered (the radar itself is
            display:none below `sm`). These exist so a mouse or a thumb can
            use the chart itself. */}
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
      </svg>
    );
  }

  // base
  return (
    <svg
      viewBox={`0 0 ${RADAR.w} ${RADAR.h}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Seven-dimension shape: ${dimensions.map((d) => `${d.label} ${d.score}`).join(", ")}`}
    >
      {/* The rotating tick rings -- ambient decoration, motion-safe gated. */}
      <g className="motion-safe:animate-[spin_75s_linear_infinite]" style={{ transformOrigin: `${RADAR.cx}px ${RADAR.cy}px` }}>
        <circle cx={RADAR.cx} cy={RADAR.cy} r={150} fill="none" stroke="#22d3ee" strokeOpacity={0.18} strokeWidth={1} strokeDasharray="2 9" />
        <circle cx={RADAR.cx} cy={RADAR.cy} r={144} fill="none" stroke="#3b82f6" strokeOpacity={0.12} strokeWidth={0.75} strokeDasharray="18 26" />
      </g>
      {/* Rings. Four, unlabelled: this chart answers "what SHAPE of bad is
          this", and gridline numbers invite reading exact values off it, which
          is what the list beside it is for. */}
      {[25, 50, 75, 100].map((ring) => (
        <polygon
          key={ring}
          points={toPath(dimensions.map((_, i) => radarPoint(i, n, ring)))}
          fill="none"
          stroke="#38bdf8"
          strokeOpacity={ring === 100 ? 0.35 : 0.12}
          strokeWidth={1}
        />
      ))}
      {/* Spokes. The selected axis brightens in its own hue -- keyed to the
          tap, not to the value on it. */}
      {dimensions.map((d, i) => {
        const p = radarPoint(i, n, 100);
        const active = selected === d.key;
        return (
          <line
            key={d.key}
            x1={RADAR.cx} y1={RADAR.cy} x2={p.x} y2={p.y}
            stroke={active ? hueFor(d.key).to : "#38bdf8"}
            strokeOpacity={active ? 0.7 : 0.14}
            strokeWidth={active ? 1.5 : 1}
          />
        );
      })}
      {/* Axis labels, using the model's own rep-facing names, each in its
          dimension's fixed hue. */}
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
            fill={active ? "#f1f5f9" : hueFor(d.key).to}
            fillOpacity={active ? 1 : 0.85}
            style={{ fontSize: 10, fontWeight: active ? 700 : 500, fontFamily: "var(--battle-display)" }}
          >
            {lines.map((line, li) => (
              <tspan key={line} x={lx} dy={li === 0 ? 0 : 11}>{line}</tspan>
            ))}
          </text>
        );
      })}
      {leaderName && (
        <text x={RADAR.cx} y={RADAR.h - 6} textAnchor="middle" fill={GOLD} fillOpacity={0.8} style={{ fontSize: 10, fontFamily: "var(--battle-display)" }}>
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
  const gradId = useId();
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
      <defs>
        {/* ONE gradient for every bar. The corpus wears one colour; only the
            marker says "you are here". */}
        <linearGradient id={gradId} x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stopColor="#1d4ed8" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.75" />
        </linearGradient>
      </defs>
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
            fill={`url(#${gradId})`}
            style={{ transition: reduced ? "none" : `y 420ms ease-out ${i * 22}ms, height 420ms ease-out ${i * 22}ms` }}
          />
        );
      })}
      {/* The marker. A line and a label, no fill change anywhere. */}
      <line
        x1={markerX} x2={markerX}
        y1={STRIP.top - 4} y2={STRIP.top + STRIP.plot + 4}
        stroke={CYAN} strokeOpacity={0.95} strokeWidth={1.5}
        style={{ filter: `drop-shadow(0 0 4px ${CYAN})` }}
      />
      <polygon
        points={`${markerX - 4},${STRIP.top + STRIP.plot + 5} ${markerX + 4},${STRIP.top + STRIP.plot + 5} ${markerX},${STRIP.top + STRIP.plot + 11}`}
        fill={CYAN}
      />
      <text
        x={Math.min(STRIP.w - 30, Math.max(30, markerX))}
        y={STRIP.h - 6}
        textAnchor="middle"
        fill="#e0f2fe"
        style={{ fontSize: 11, fontWeight: 700, fontFamily: "var(--battle-display)" }}
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
  // Bumped to silently refetch the payload: after queuing a re-check, and on
  // the poll while one is pending/running.
  const [nonce, setNonce] = useState(0);
  const [recheckPost, setRecheckPost] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const reduced = useReducedMotion();
  const drawn = useDrawOnce(reduced);

  useEffect(() => {
    let alive = true;
    // A silent refresh keeps the rendered card; only a lead CHANGE shows the
    // skeleton. Re-polling every few seconds while a re-check runs must not
    // strobe the page a rep is reading from.
    setState((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
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
  }, [leadId, nonce]);

  // A lead change is a hard reset back to the skeleton (the silent-refresh
  // rule above only applies within one lead).
  useEffect(() => {
    setState({ status: "loading" });
    setNonce(0);
    setRecheckPost({ busy: false, error: null });
  }, [leadId]);

  // While a re-check is queued or running, poll: the worker writes a fresh
  // audit within ~a minute and the card refreshes itself with it.
  useEffect(() => {
    if (state.status !== "ready") return;
    const r = state.payload.recheck;
    if (!r || (r.status !== "pending" && r.status !== "running")) return;
    const t = window.setTimeout(() => setNonce((n) => n + 1), 6000);
    return () => window.clearTimeout(t);
  }, [state]);

  async function requestRecheck(url?: string) {
    setRecheckPost({ busy: true, error: null });
    try {
      const r = await fetch(`/api/web-leads/${encodeURIComponent(leadId)}/recheck`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(url ? { url } : {}),
      });
      const body = (await r.json().catch(() => null)) as { error?: string } | null;
      if (!r.ok) {
        setRecheckPost({ busy: false, error: (body && body.error) || "request_failed" });
        return;
      }
      setRecheckPost({ busy: false, error: null });
      setNonce((n) => n + 1);
    } catch {
      setRecheckPost({ busy: false, error: "network_failed" });
    }
  }

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
  const urlVerification = state.payload.urlVerification ?? { verdict: "unknown" as const, verifiedAt: null };
  const recheck = state.payload.recheck ?? null;
  // Can this card's numbers be stood behind? Adon's 2026-09-01 decision: a
  // score we cannot stand behind is HIDDEN with the reason in plain words,
  // never shown wearing a warning label. lib/web-leads/trust.ts.
  const trust = assessTrust({ audit, signals, urlVerification });

  return (
    <div className={`${displayFont.variable} ${numeralFont.variable} ${dataFont.variable} ${embedded ? "" : "min-h-screen bg-bg"}`}>
      <Hero lead={lead} audit={audit} competitors={competitors} drawn={drawn} reduced={reduced} canMutate={canMutate} embedded={embedded} scoreHidden={Boolean(trust.hide)} />
      <BattleSections>
        <div className={embedded ? "space-y-5 pt-5" : "mx-auto max-w-6xl space-y-5 px-4 pb-16 lg:px-8"}>
          <SectionToolbar />
          <MeasurementHonesty
            audit={audit}
            verification={urlVerification}
            warnings={trust.warnings}
            hidden={trust.hide !== null}
            recheck={recheck}
            canMutate={canMutate}
            busy={recheckPost.busy}
            postError={recheckPost.error}
            onRecheck={requestRecheck}
          />
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

          {trust.hide ? (
            // The score exists in the database but cannot be stood behind
            // (browser-built shell, or a website flagged as not theirs).
            // Adon's rule: hide it and say why -- never a number wearing a
            // warning. The re-check control is on the honesty panel above.
            <UntrustedPanel hide={trust.hide} />
          ) : audit.state !== "scored" ? (
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
          <BattleSection
            id="industry-automations"
            defaultOpen={true}
            title="What else you can automate for them"
            sub="Matched to this business type. Ask the question first; treat every build and integration as founder-scoped."
            teaser="Industry-specific website features, connected workflows, and custom automation opportunities"
          >
            <IndustryAutomationGuide initialIndustry={lead.industry} />
          </BattleSection>
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
  lead, audit, competitors, drawn, reduced, canMutate, embedded = false, scoreHidden = false,
}: {
  lead: WebLead;
  audit: AuditResult;
  competitors: CompetitorContext | null;
  drawn: boolean;
  reduced: boolean;
  canMutate: boolean;
  embedded?: boolean;
  /** Trust said the stored score cannot be stood behind: render no number
   *  anywhere, including here and the percentile it feeds. */
  scoreHidden?: boolean;
}) {
  const websiteHref = preferredSiteUrl(lead.websiteUrl);
  const ringId = useId();
  // Hooks before any branch: the count-up runs for every state and simply
  // counts to 0 when there is no score to show.
  const shownScore = useCountUp(audit.state === "scored" && !scoreHidden ? audit.composite : 0, reduced);
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
      {/* The blueprint grid and the counter-glow. Chrome, keyed to nothing:
          a 4 and a 94 get the same room. The grid fades out radially so it
          reads as depth behind the header, not as a chart axis. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            "linear-gradient(rgba(59,130,246,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(59,130,246,0.07) 1px, transparent 1px)",
          backgroundSize: "36px 36px",
          maskImage: "radial-gradient(85% 120% at 30% 0%, black, transparent 85%)",
          WebkitMaskImage: "radial-gradient(85% 120% at 30% 0%, black, transparent 85%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{ background: "radial-gradient(50% 90% at 95% 115%, rgba(59,130,246,0.08), transparent 70%)" }}
      />
      {/* The living backdrop: drifting plexus + a static CRT scanline
          texture. Both chrome, both keyed to nothing. */}
      <ParticleField reduced={reduced} />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{ background: "repeating-linear-gradient(0deg, rgba(59,130,246,0.04) 0px, rgba(59,130,246,0.04) 1px, transparent 1px, transparent 3px)" }}
      />
      {/* HUD corner marks. Decoration with a job: they frame the header as the
          instrument panel the rest of the card hangs off. */}
      <span aria-hidden className="pointer-events-none absolute left-3 top-3 h-4 w-4 border-l-2 border-t-2 border-accent/30" />
      <span aria-hidden className="pointer-events-none absolute right-3 top-3 h-4 w-4 border-r-2 border-t-2 border-accent/30" />
      <div className={embedded ? "relative px-4 py-6 lg:px-6" : "relative mx-auto max-w-6xl px-4 py-7 lg:px-8 lg:py-9"}>
        {!embedded && <BackLink />}
        <div className={`${embedded ? "" : "mt-4"} flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between`}>
          <div className="min-w-0">
            <h1 className="text-3xl font-bold leading-tight tracking-tight text-fg [font-family:var(--battle-display)] lg:text-4xl">{lead.name}</h1>
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
            {audit.state === "scored" && scoreHidden ? (
              <p className="max-w-xs text-base font-semibold leading-snug text-fg-muted">
                No score is shown for this site. The measurement panel below says exactly why.
              </p>
            ) : audit.state === "scored" ? (
              <>
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-fg-muted">Website score</p>
                {/* The number counts up inside a ring that draws once around
                    it. The ring's LENGTH is the score out of 100 -- the same
                    encoding every Meter on this card already uses -- and its
                    colour is one neutral stroke with a constant glow whether
                    the score is 4 or 94 (rule 1). The animated figure is
                    theatre and is hidden from assistive tech; the sr-only span
                    carries the real number so a screen reader never announces
                    an intermediate frame. */}
                <div className="relative mt-2 inline-flex h-36 w-36 items-center justify-center">
                  {/* The arc-reactor halo: a constant pulse behind the ring,
                      motion-safe gated, identical at every score. */}
                  <div aria-hidden className="absolute inset-3 rounded-full bg-accent/10 blur-xl motion-safe:animate-pulse-slow" />
                  <svg viewBox="0 0 120 120" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden>
                    <defs>
                      <linearGradient id={ringId} x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#22d3ee" />
                        <stop offset="100%" stopColor="#3b82f6" />
                      </linearGradient>
                    </defs>
                    <circle cx="60" cy="60" r="54" fill="none" strokeWidth="2.5" className="stroke-bg-border" />
                    <circle cx="60" cy="60" r="47" fill="none" strokeWidth="1" stroke="#22d3ee" strokeOpacity="0.18" strokeDasharray="1 6" />
                    <circle
                      cx="60" cy="60" r="54" fill="none" strokeWidth="2.5" strokeLinecap="round"
                      stroke={`url(#${ringId})`}
                      strokeDasharray={`${(2 * Math.PI * 54).toFixed(2)}`}
                      strokeDashoffset={
                        drawn
                          ? ((1 - Math.min(100, Math.max(0, audit.composite)) / 100) * 2 * Math.PI * 54).toFixed(2)
                          : (2 * Math.PI * 54).toFixed(2)
                      }
                      style={{
                        transition: reduced ? "none" : "stroke-dashoffset 900ms cubic-bezier(0.22, 1, 0.36, 1)",
                        filter: "drop-shadow(0 0 6px rgba(34,211,238,0.5))",
                      }}
                    />
                  </svg>
                  <p className="text-[2.6rem] font-bold leading-none tracking-tight tabular-nums text-fg drop-shadow-[0_0_22px_rgba(59,130,246,0.26)] [font-family:var(--battle-numeral)]">
                    <span aria-hidden>{shownScore}</span>
                    <span className="sr-only">{audit.composite}</span>
                  </p>
                </div>
                <p className="mt-1 text-xs text-fg-dim [font-family:var(--battle-data)]">Measured {formatDate(audit.measuredAt)}</p>
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

        {audit.state === "scored" && !scoreHidden && competitors && (
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

/**
 * The DESIGNATION PLATE (round 5): the name of the shape, stamped above the
 * chart that draws it.
 *
 * Every word comes verbatim from the hand-written tables in
 * lib/web-leads/lead-profile.ts (battle-card rule 3); the classifier that
 * picks WHICH entry applies is ordered arithmetic over the same dimension
 * scores the radar renders, so the plate and the chart can never disagree.
 * The plate wears the neutral accent at every designation -- "Full rebuild"
 * and "Strong contender" get identical chrome (rule 1); the only hue on it
 * is the identity dot of each defining dimension, the same dot those areas
 * wear on the radar, the list and the fix ranking. The readouts on the right
 * are the shape's own numbers: the floor (worst area), the ceiling (best),
 * and the spread between them, in the telemetry face.
 */
function DesignationPlate({
  audit, selected, onSelect, reduced,
}: {
  audit: Extract<AuditResult, { state: "scored" }>;
  /** The shape section's shared selection (round 7): the plate's chips are
   *  the same control as the list rows and the beams -- tapping a defining
   *  area here selects it there and flies the 3D stage to it. */
  selected: string | null;
  onSelect: (key: string) => void;
  reduced: boolean;
}) {
  const designation = useMemo(
    () => designateLead(audit.dimensions, audit.composite),
    [audit.dimensions, audit.composite],
  );
  const decodedName = useDecode(designation.name, reduced);
  const byKey = useMemo(() => new Map(audit.dimensions.map((d) => [d.key, d])), [audit.dimensions]);
  const scores = audit.dimensions.map((d) => d.score);
  const floor = Math.min(...scores);
  const ceiling = Math.max(...scores);

  return (
    <div className="relative mb-4 overflow-hidden rounded-lg border border-accent/25 bg-bg-raised/60 p-4 backdrop-blur-sm [clip-path:polygon(0_0,calc(100%-16px)_0,100%_16px,100%_100%,0_100%)]">
      {/* The lit diagonal along the clipped corner, and a faint scan texture.
          Constant chrome, identical for every designation. */}
      <span aria-hidden className="pointer-events-none absolute -right-[7px] top-[4px] h-px w-6 rotate-45 bg-accent/60" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{ background: "repeating-linear-gradient(0deg, rgba(59,130,246,0.05) 0px, rgba(59,130,246,0.05) 1px, transparent 1px, transparent 4px)" }}
      />
      <div className="relative flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 max-w-2xl">
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-fg-muted [font-family:var(--battle-display)]">
            Designation
          </p>
          {/* The name resolves through a brief glyph decode (round 8); the
              aria-label carries the real designation so assistive tech never
              hears a scramble frame. */}
          <p
            aria-label={designation.name}
            className="mt-1 text-xl font-bold uppercase leading-none tracking-[0.06em] text-fg [font-family:var(--battle-display)] lg:text-2xl"
          >
            <span aria-hidden>{decodedName || " "}</span>
          </p>
          <p className="mt-2 text-sm leading-relaxed text-fg-dim">{designation.meaning}</p>
          <p className="mt-1.5 text-sm leading-relaxed text-fg-dim">
            <span className="font-medium text-fg-muted">The play:</span> {designation.play}
          </p>
          {/* The defining areas, wearing the same identity dots they wear on
              every other surface of this card. Identity, never verdict --
              and since round 7 they are BUTTONS on the section's shared
              selection: tapping one selects it in the list, opens its
              detail, and flies the 3D stage to its beam. */}
          <div className="mt-3 flex flex-wrap gap-2">
            {designation.primary.map((key) => {
              const d = byKey.get(key);
              if (!d) return null;
              const hue = hueFor(key);
              const active = selected === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onSelect(key)}
                  aria-pressed={active}
                  className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none ${active ? "border-accent/50 bg-bg-raised/80 text-fg" : "border-bg-border bg-bg-panel/70 text-fg-muted hover:border-accent/30 hover:text-fg"}`}
                >
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: hue.to, boxShadow: `0 0 6px ${hue.to}` }} />
                  {d.label}
                  <span className="tabular-nums text-fg [font-family:var(--battle-data)]">{d.score}</span>
                </button>
              );
            })}
          </div>
        </div>
        <dl className="flex shrink-0 gap-4 text-right">
          {(
            [
              ["Floor", floor],
              ["Ceiling", ceiling],
              ["Spread", ceiling - floor],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt className="text-[9px] font-bold uppercase tracking-[0.18em] text-fg-muted [font-family:var(--battle-display)]">{label}</dt>
              <dd className="mt-0.5 text-lg font-medium tabular-nums leading-none text-fg [font-family:var(--battle-data)]">{value}</dd>
            </div>
          ))}
        </dl>
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
  // ONE selection for the whole shape section (round 7): the designation
  // plate's chips, the dimension list, the SVG radar and the WebGL stage all
  // share it, so tapping an area anywhere focuses it everywhere -- including
  // the camera flight on the 3D stage. Null means "the worst area", resolved
  // inside DimensionShape where worstFirst is already the ordering truth.
  const [dimSel, setDimSel] = useState<string | null>(null);

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
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted [font-family:var(--battle-display)]">
            1. Say this
          </p>
          <p className="mt-1.5 max-w-4xl text-lg font-semibold leading-relaxed text-fg">
            &ldquo;{angle.angle.opener}&rdquo;
          </p>

          <p className="mt-5 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted [font-family:var(--battle-display)]">
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
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted [font-family:var(--battle-display)]">
                3. Once they answer, this is why it costs them
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-fg-dim">{angle.angle.cost}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted [font-family:var(--battle-display)]">
                If they say &ldquo;{angle.angle.objection.says}&rdquo;
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-fg-dim">{angle.angle.objection.response}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted [font-family:var(--battle-display)]">What we&apos;d build</p>
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
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted [font-family:var(--battle-display)]">
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
          <DesignationPlate audit={audit} selected={dimSel} onSelect={setDimSel} reduced={reduced} />
          <DimensionShape
            dimensions={audit.dimensions}
            worstFirst={worstFirst}
            competitors={competitors}
            signals={signals}
            drawn={drawn}
            reduced={reduced}
            selected={dimSel}
            onSelect={setDimSel}
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
            signals={signals}
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
        sub="Grouped by what it affects, worst first. An area's score is plain arithmetic: the points its passing checks earn, out of 100. Every failing check below names what the crawler actually measured on this site, so no number here has to be taken on faith."
        teaser={`${failed.length} ${failed.length === 1 ? "check" : "checks"} failing across ${failingAreas} ${failingAreas === 1 ? "area" : "areas"}, worst first, with what each one costs them`}
      >
        <div className="space-y-6">
          {worstFirst.map((d) => {
            const misses = d.checks.filter((c) => !c.has);
            return (
              <div key={d.key} id={`battle-dim-${d.key}`} className="scroll-mt-24 border-t border-bg-border pt-4 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-base font-semibold text-fg">{d.label}</h3>
                  <p className="text-xs text-fg-muted [font-family:var(--battle-data)]">
                    Scores <span className="tabular-nums text-fg">{d.score}</span> ·{" "}
                    {earnedPoints(d)} of 100 points earned ·{" "}
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
                          <div className="flex items-baseline justify-between gap-3">
                            <p className="text-sm font-semibold text-fg">{check.label}</p>
                            {/* The check's exact worth in this area's 100 --
                                the score is these numbers added up, and a rep
                                should be able to do the addition out loud. */}
                            <span className="shrink-0 text-[11px] tabular-nums text-fg-dim [font-family:var(--battle-data)]">
                              {check.points} of this area&apos;s 100 pts
                            </span>
                          </div>
                          <MeasuredLine code={check.code} signals={signals} />
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
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted [font-family:var(--battle-display)]">{group.title}</p>
                <dl className="mt-2 divide-y divide-bg-border/60">
                  {group.rows.map((row) => (
                    <div
                      key={row.label}
                      className="-mx-1.5 flex items-baseline justify-between gap-3 rounded px-1.5 py-1.5 transition-colors hover:bg-accent/5 motion-reduce:transition-none"
                    >
                      <dt className="text-xs text-fg-dim">{row.label}</dt>
                      <dd className="shrink-0 text-xs font-medium tabular-nums text-fg-muted [font-family:var(--battle-data)]">{row.value}</dd>
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
  dimensions, worstFirst, competitors, signals, drawn, reduced, selected, onSelect,
}: {
  dimensions: DimensionProfile[];
  worstFirst: DimensionProfile[];
  competitors: CompetitorContext | null;
  signals: Record<string, unknown> | null;
  drawn: boolean;
  reduced: boolean;
  /** Selection is OWNED BY ScoredBody (round 7): the designation plate's
   *  chips, this list, the SVG radar and the WebGL stage all read and write
   *  the same state, so a tap anywhere focuses everywhere. */
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const bus = useBattleSections();
  const setSelected = onSelect;
  // The SFX preference, mirrored into state so the toggle re-renders. Read
  // in an effect for the same SSR-hydration reason as useReducedMotion.
  const [sfxOn, setSfxOn] = useState(false);
  useEffect(() => setSfxOn(sfx.enabled), []);
  // The holo-table tilt for the 2D FALLBACK stack: the radar sits on a
  // gentle base pitch and leans toward the pointer. USER-DRIVEN motion only.
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  // The WebGL radar's lifecycle: pending (initializing invisibly behind the
  // SVG), on (3D live, SVG unmounted), off (probe/import/init failed -- the
  // SVG stays, permanently, and nothing is retried or blank).
  const [gl, setGl] = useState<"pending" | "on" | "off">("pending");
  // Desktop check as STATE, not CSS: `hidden` would only hide the canvas --
  // the effect behind it would still download three.js onto every phone.
  // Read in an effect for the same hydration reason as useReducedMotion.
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    setDesktop(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setDesktop(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const sel = selected ?? worstFirst[0]?.key ?? null;
  const dim = dimensions.find((d) => d.key === sel) || null;
  const headToHead = competitors?.headToHead || null;
  // Memoised: Radar3D rebuilds its whole GL scene when this identity
  // changes, and a fresh array per render would rebuild it per click.
  const leaderArr = useMemo(
    () => headToHead?.dimensions.map((d) => ({ key: d.key, leader: d.leader })) || null,
    [headToHead],
  );
  const leaderFor = dim ? headToHead?.dimensions.find((l) => l.key === dim.key) || null : null;
  const misses = dim ? dim.checks.filter((c) => !c.has).sort((a, b) => b.points - a.points) : [];
  // The ONE truth for "is the 3D radar actually on screen". The SVG hides on
  // exactly this, not on `gl` alone: a rep who enables reduced motion after
  // the scene initialized unmounts Radar3D while `gl` still says "on", and a
  // fallback keyed to `gl` alone would leave a blank hole where a chart was.
  // (Codex review, 2026-09-01.)
  const glLive = drawn && !reduced && desktop && gl === "on";

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
          nothing has to. The seven dimension buttons below already carry
          every number the radar encodes, labelled, in one column, and they
          were always there. So the phone gets the buttons and the desktop
          gets the chart.

          On desktop the chart is the WebGL hologram (Radar3D) when it can
          be: `drawn` gates the mount one frame so a reduced-motion
          preference has already been read (a reduced-motion user never even
          downloads three.js), and while the GL scene initializes -- or if it
          fails -- the 2D SVG hologram stack below renders instead, so the
          card is never blank and never waits. The SVG stack is also the
          aria carrier; when the canvas takes over, an sr-only summary keeps
          the same sentence available to assistive tech. */}
      {drawn && !reduced && desktop && gl !== "off" && (
        <div className={gl === "on" ? "relative" : "pointer-events-none absolute h-px w-px overflow-hidden opacity-0"}>
          <Radar3D
            dimensions={dimensions}
            leader={leaderArr}
            selected={sel}
            onSelect={setSelected}
            onStatus={(ok) => setGl(ok ? "on" : "off")}
            className="h-[380px] w-full"
          />
          {gl === "on" && (
            <>
              <p className="sr-only">{`Seven-dimension shape: ${dimensions.map((d) => `${d.label} ${d.score}`).join(", ")}`}</p>
              <div className="flex items-center justify-center gap-3">
                {headToHead && (
                  <p className="text-center text-[10px] text-fg-dim [font-family:var(--battle-display)]" style={{ color: GOLD, opacity: 0.75 }}>
                    Gold outline: {headToHead.competitor.name} · tap a beam to focus · drag to orbit · double-click to reset
                  </p>
                )}
                {/* Sound is OPT-IN, per rep: this card sits next to a live
                    phone call, so the HUD ships silent and stays silent
                    until the rep flips this. battle-sfx.ts synthesizes the
                    palette from oscillators -- zero audio files. */}
                <button
                  type="button"
                  onClick={() => {
                    const next = !sfxOn;
                    sfx.setEnabled(next);
                    setSfxOn(next);
                  }}
                  aria-pressed={sfxOn}
                  className={`rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none [font-family:var(--battle-display)] ${sfxOn ? "border-accent/50 text-fg" : "border-bg-border text-fg-dim hover:text-fg-muted"}`}
                >
                  SFX {sfxOn ? "on" : "off"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <div className={glLive ? "hidden" : "relative hidden justify-center sm:flex"} style={{ perspective: "1100px" }}>
        {(() => {
          const radarProps = {
            dimensions,
            leader: headToHead?.dimensions.map((d) => ({ key: d.key, leader: d.leader })) || null,
            leaderName: headToHead?.competitor.name || null,
            drawn,
            reduced,
            selected: sel,
            onSelect: setSelected,
          };
          return (
            <div
              className="relative w-full max-w-[420px]"
              style={{
                transform: reduced ? "none" : `rotateX(${(18 + tilt.x).toFixed(2)}deg) rotateY(${tilt.y.toFixed(2)}deg)`,
                // Conditional like every other transition in this file:
                // `reduced` starts false and corrects on mount, so an
                // unconditional 180ms here animated the base pitch flat for
                // exactly the users who asked for no motion. With it
                // conditional, the correction is a one-frame snap. (Codex
                // review, 2026-08-31.)
                transition: reduced ? "none" : "transform 180ms ease-out",
                transformStyle: "preserve-3d",
              }}
              onPointerMove={
                reduced
                  ? undefined
                  : (e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      const px = (e.clientX - r.left) / r.width - 0.5;
                      const py = (e.clientY - r.top) / r.height - 0.5;
                      setTilt({ x: -py * 9, y: px * 12 });
                    }
              }
              onPointerLeave={() => setTilt({ x: 0, y: 0 })}
            >
              {/* The hologram stack: grid on the table, shadow just above it,
                  the data polygon floating over both, hit targets on top.
                  Under tilt the layers parallax -- that gap IS the 3D. Flat
                  (reduced motion) the layers align exactly and nothing is
                  lost but the theatre. */}
              <Radar {...radarProps} layer="base" />
              <div aria-hidden className="pointer-events-none absolute inset-0" style={{ transform: "translateZ(10px)" }}>
                <Radar {...radarProps} layer="shadow" />
              </div>
              <div aria-hidden className="pointer-events-none absolute inset-0" style={{ transform: "translateZ(28px)" }}>
                <Radar {...radarProps} layer="data" />
              </div>
              <div className="absolute inset-0" style={{ transform: "translateZ(34px)" }}>
                <Radar {...radarProps} layer="hits" />
              </div>
            </div>
          );
        })()}
        {/* The holo base: a soft light pool under the table. Constant. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-1 left-1/2 h-8 w-3/5 -translate-x-1/2 rounded-[100%] bg-accent/10 blur-xl"
        />
      </div>
      <div className="mt-4 space-y-1 sm:border-t sm:border-bg-border sm:pt-4">
        {dimensions.map((d) => {
          const active = d.key === sel;
          const hue = hueFor(d.key);
          return (
            <button
              key={d.key}
              type="button"
              onClick={() => setSelected(d.key)}
              aria-pressed={active}
              className={`block w-full rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none ${active ? "bg-bg-raised/70" : "hover:bg-bg-raised/40"}`}
            >
              <span className="flex items-center justify-between gap-3 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  {/* The dimension's identity hue -- the same dot at every
                      score, matching its vertex on the radar above. */}
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: hue.to, boxShadow: `0 0 6px ${hue.to}` }} />
                  <span className={active ? "truncate font-semibold text-fg" : "truncate text-fg-muted"}>{d.label}</span>
                </span>
                <span className={`tabular-nums [font-family:var(--battle-data)] ${active ? "text-fg" : "text-fg-dim"}`}>{d.score}</span>
              </span>
              <span className="mt-1 block"><Meter value={d.score} drawn={drawn} reduced={reduced} hue={hue} /></span>
            </button>
          );
        })}
      </div>

      {dim && (
        <div
          className="relative mt-4 rounded-lg border bg-bg-raised/50 p-4 backdrop-blur-sm"
          // The selected dimension's identity hue frames its own detail --
          // the same hue this area wears everywhere, at every score.
          style={{ borderColor: `${hueFor(dim.key).to}40` }}
        >
          {/* The targeting brackets: this is the one inset on the card that
              answers a selection, so it gets the HUD marks. Constant chrome. */}
          <span aria-hidden className="pointer-events-none absolute left-1 top-1 h-2.5 w-2.5 border-l border-t border-accent/40" />
          <span aria-hidden className="pointer-events-none absolute bottom-1 right-1 h-2.5 w-2.5 border-b border-r border-accent/40" />
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-fg [font-family:var(--battle-display)]">
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: hueFor(dim.key).to, boxShadow: `0 0 6px ${hueFor(dim.key).to}` }} />
              {dim.label}
            </p>
            <p className="text-xs text-fg-muted [font-family:var(--battle-data)]">
              Scores <span className="tabular-nums text-fg">{dim.score}</span> ·{" "}
              {earnedPoints(dim)} of 100 points earned ·{" "}
              {misses.length === 0
                ? "nothing failing here"
                : `${misses.length} of ${dim.checks.length} ${misses.length === 1 ? "check" : "checks"} failing`}
            </p>
          </div>
          {misses.length === 0 ? (
            <p className="mt-2 text-sm text-fg-dim">Everything we check in this area passed.</p>
          ) : (
            <div className="mt-2.5">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted [font-family:var(--battle-display)]">Biggest gap in this area</p>
              <p className="mt-1 text-sm font-semibold text-fg">{misses[0].label}</p>
              <MeasuredLine code={misses[0].code} signals={signals} />
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
  worstFirst, maxRecoverable, totalAreas, totalChecks, signals, drawn, reduced,
}: {
  worstFirst: DimensionProfile[];
  maxRecoverable: number;
  totalAreas: number;
  totalChecks: number;
  signals: Record<string, unknown> | null;
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
          const hue = hueFor(d.key);
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
                  {/* The same identity hue this dimension wears on the radar
                      and in the shape list -- one colour, three surfaces. */}
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: hue.to, boxShadow: `0 0 6px ${hue.to}` }} />
                  <span className="truncate text-fg">{d.label}</span>
                  {expandable && (
                    <span className="shrink-0 text-[10px] text-fg-faint">
                      {misses.length} {misses.length === 1 ? "check" : "checks"}
                    </span>
                  )}
                </span>
                {/* One constant cyan for every "+points" figure -- the metric's
                    own identity, not a grade. */}
                <span className="shrink-0 tabular-nums [font-family:var(--battle-data)]" style={{ color: "#7dd3fc" }}>+{points.toFixed(1)}</span>
              </span>
              <span className="mt-1.5 block">
                <Meter value={(points / maxRecoverable) * 100} drawn={drawn} reduced={reduced} hue={hue} />
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
                <ul className="mb-1.5 ml-2 mt-1 space-y-2.5 rounded-lg border border-accent/15 bg-bg-raised/50 p-3 backdrop-blur-sm motion-safe:animate-fade-in">
                  {misses.map((check) => (
                    <li key={check.code}>
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-sm font-semibold text-fg">{check.label}</p>
                        <span className="shrink-0 text-[11px] tabular-nums text-fg-dim [font-family:var(--battle-data)]">
                          {check.points} of this area&apos;s 100 pts
                        </span>
                      </div>
                      <MeasuredLine code={check.code} signals={signals} />
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
 * A card that leans toward the pointer, in CSS 3D.
 *
 * The same contract as the holo-table tilt above: user-driven only (the card
 * echoes the rep's own hand, nothing moves on its own), one neutral chrome
 * whatever the numbers on the card say, and reduced motion renders it flat --
 * the handlers are not even attached. Hover border/glow classes stay on the
 * caller; the inline transition names border-color and box-shadow so those
 * class transitions survive the inline `transition` property.
 */
function TiltCard({ reduced, className = "", children }: { reduced: boolean; className?: string; children: React.ReactNode }) {
  const [t, setT] = useState({ x: 0, y: 0 });
  return (
    <div
      className={className}
      style={{
        transform:
          reduced || (t.x === 0 && t.y === 0)
            ? undefined
            : `perspective(700px) rotateX(${t.x.toFixed(2)}deg) rotateY(${t.y.toFixed(2)}deg)`,
        transition: reduced ? undefined : "transform 160ms ease-out, border-color 160ms ease-out, box-shadow 160ms ease-out",
        willChange: reduced ? undefined : "transform",
      }}
      onPointerMove={
        reduced
          ? undefined
          : (e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const px = (e.clientX - r.left) / r.width - 0.5;
              const py = (e.clientY - r.top) / r.height - 0.5;
              setT({ x: -py * 6, y: px * 8 });
            }
      }
      onPointerLeave={() => setT({ x: 0, y: 0 })}
    >
      {children}
    </div>
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
              style={{
                opacity: drawn ? 1 : 0,
                transform: drawn ? "none" : "translateY(6px)",
                transition: reduced ? "none" : `opacity 320ms ease-out ${i * 60}ms, transform 320ms ease-out ${i * 60}ms`,
              }}
            >
              {/* Entry stagger on the <li>, 3D tilt on the inner card: two
                  transforms, two elements, no fighting over one style. */}
              <TiltCard
                reduced={reduced}
                className="h-full rounded-lg border border-bg-border bg-bg-raised/60 p-4 hover:border-accent/40 hover:shadow-glow"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-fg">{c.name}</p>
                    <p className="mt-0.5 truncate text-xs text-fg-dim">
                      {[c.city, c.province].filter(Boolean).join(", ") || "Location not recorded"}
                    </p>
                  </div>
                  <span className="shrink-0 text-2xl font-bold leading-none tabular-nums text-fg [font-family:var(--battle-display)]" style={{ textShadow: "0 0 14px rgba(34,211,238,0.35)" }}>{c.score}</span>
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
              </TiltCard>
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
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: hueFor(d.key).to, boxShadow: `0 0 6px ${hueFor(d.key).to}` }} />
                  <span className="truncate">{d.label}</span>
                </span>
                <span className="text-xs tabular-nums text-fg-dim [font-family:var(--battle-data)]">
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
 * being sold. The colours are WHOSE-marks, fixed identities worn at every
 * score: the prospect's fill is always cyan, the benchmark's tick is always
 * gold -- the same pair the radar overlay wears (rule 1).
 */
function TwoUpTrack({ theirs, leader, drawn, reduced }: { theirs: number; leader: number; drawn: boolean; reduced: boolean }) {
  const t = Math.min(100, Math.max(0, theirs));
  const l = Math.min(100, Math.max(0, leader));
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-bg-border" aria-hidden>
      {/* Same compositor discipline as Meter: transform, never width. */}
      <div
        className="absolute inset-y-0 left-0 rounded-full"
        style={{
          width: `${t}%`,
          transform: drawn ? "scaleX(1)" : "scaleX(0)",
          transformOrigin: "left",
          transition: reduced ? "none" : "transform 420ms cubic-bezier(0.22, 1, 0.36, 1)",
          background: "linear-gradient(90deg, #22d3ee, #60a5fa)",
          boxShadow: "0 0 8px rgba(34,211,238,0.35)",
        }}
      />
      <div
        className="absolute inset-y-0 w-0.5"
        style={{
          left: `calc(${l}% - 1px)`,
          opacity: drawn ? 1 : 0,
          transition: reduced ? "none" : "opacity 420ms ease-out 120ms",
          background: GOLD,
          boxShadow: `0 0 6px ${GOLD}`,
        }}
      />
    </div>
  );
}

export default BattleCard;
