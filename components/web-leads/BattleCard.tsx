"use client";

/**
 * BattleCard — what a rep needs on screen while they are on the phone with one
 * prospect, and nothing they do not.
 *
 * ═══ THE COMPACT CARD (Adon, 2026-10-01) ════════════════════════════════════
 *
 * "Compact the battle card to make only the useful information that's going
 * to actually help us on sale... there's a lot of redundancy here... it's
 * just way too much for me to be actually going through each one."
 *
 * The card had grown to fifteen blocks, nine of them open by default, and a
 * third of them said the same thing twice: two openers built from the same
 * worst gap, an objection and a build line inside the opener that the
 * objection console and the build list below already carried, two separate
 * sell-lists, three depths of the same audit (the shape chart, the fault
 * list, the raw crawl) plus a WebGL radar and a 3D arena. It is now seven,
 * read top to bottom in the order a call happens:
 *
 *   1. Header          who to ask for, the number, their site, the score and
 *                      the one sentence that makes the score mean something.
 *   2. Before you dial what we have already sent them, the directory's facts,
 *                      and how far to trust this card (closed).
 *   3. The script      say this, ask this and stop talking, then why it costs
 *                      them. The reserve statistic sits under it.
 *   4. Objections      ranked for this business, one-tap log.
 *   5. What we would build for them
 *                      the lead's own ranked catalogue, with the wider
 *                      industry list folded underneath it.
 *   6. Proof           rivals, every failing check, online presence and the
 *                      raw crawl, for when a prospect pushes back (closed).
 *   7. Log this call   the one write surface, never collapsible.
 *
 * The HUD rounds of 2026-08-31 to 2026-09-02 (particle field, scanlines, the
 * WebGL radar, the 3D arena, the designation plate, sound, the glyph decode,
 * the count-up ring) are removed, not hidden. They are in git history if they
 * are ever wanted back; none of them told a rep what to say.
 *
 * ═══ THE RULES THIS FILE DOES NOT GET TO BREAK ══════════════════════════════
 *
 * 1. NO COLOUR IS KEYED TO A SCORE. A red 22 renders a judgement the
 *    measurement does not support, and a rep who sees red says something
 *    they cannot back up. tests/web-leads-guards.test.ts bans the verdict
 *    colour classes in this file outright.
 *
 * 2. THE NON-SCORED STATES RENDER AS SENTENCES. Never a zero, never a blank,
 *    never an empty chart for a site our crawler could not read.
 *
 * 3. EVERY WORD IS HAND-WRITTEN. remedies.ts, angles.ts and evidence.ts are
 *    fixed tables rendered verbatim. Nothing on this page is generated per
 *    lead, because a model writing sales copy will eventually assert a
 *    measurement we never took and a rep will say it aloud to a stranger.
 *
 * 4. `prefers-reduced-motion` DISABLES ALL OF IT. What little still moves
 *    (the catalogue's meters drawing once) simply appears.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import localFont from "next/font/local";
import { ArrowLeft, ChevronDown, ExternalLink, Phone } from "lucide-react";
import type { AuditResult, CheckResult, DimensionProfile, UrlVerification, RecheckStatus } from "@/lib/web-leads/audit";
import { assessTrust, type TrustAssessment } from "@/lib/web-leads/trust";
import type { CompetitorContext } from "@/lib/web-leads/competitors";
import type { WebLead } from "@/lib/web-leads/data";
import { preferredSiteUrl } from "@/lib/web-leads/url-safety";
import { selectAngle, recoverablePoints, IF_THE_ANSWER_IS_CLEAN } from "@/lib/web-leads/angles";
import { evidenceFrom } from "@/lib/web-leads/evidence";
import { BusinessFacts, fullAddress } from "./BusinessFacts";
import { CallOutcomeLog } from "./CallOutcomeLog";
import { LeadTimelinePanel } from "@/components/leads/LeadTimelinePanel";
import { ObjectionConsole } from "./ObjectionConsole";
import { BattleSection, BattleSections, SectionToolbar } from "./BattleSection";
import { MeasuredLine, RemedyLines } from "./audit-parts";
import { CapabilityCatalogue } from "./CapabilityCatalogue";
import { hasLiveWebsite } from "@/lib/web-leads/automations-match";
import { PresenceBlock } from "./PresenceBlock";
import type { OnlinePresence } from "@/lib/web-leads/presence";
import { IndustryAutomationGuide } from "@/components/playbook/IndustryAutomationGuide";

/**
 * The display face for section labels: Chakra Petch, vendored latin woff2 in
 * app/fonts/ (from @fontsource, see OFL.md), loaded with next/font/local,
 * never next/font/google: tests/font-selfhost.test.ts bans the build-time
 * Google fetch that failed two deploys in August. Scoped to this card through
 * a CSS variable on its root.
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
 * The telemetry face: JetBrains Mono (already vendored, loaded locally) for
 * measured values. Two different values never render at two different widths
 * mid-call.
 */
const dataFont = localFont({
  src: [
    { path: "../../app/fonts/JetBrainsMono-400.woff2", weight: "400", style: "normal" },
    { path: "../../app/fonts/JetBrainsMono-500.woff2", weight: "500", style: "normal" },
  ],
  variable: "--battle-data",
});

type Payload = {
  lead: WebLead;
  audit: AuditResult;
  competitors: CompetitorContext | null;
  signals: Record<string, unknown> | null;
  urlVerification?: UrlVerification | null;
  recheck?: RecheckStatus | null;
  onlinePresence?: OnlinePresence | null;
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
 * mismatch.
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
 * Flips true one frame after mount, so the catalogue's meters can draw from
 * empty to their real value exactly once, and never again on a re-render.
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
  return (
    <h2 className="text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted [font-family:var(--battle-display)]">
      {children}
    </h2>
  );
}

/** A small uppercase label inside a section. */
function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted [font-family:var(--battle-display)]">
      {children}
    </p>
  );
}

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-bg-border bg-bg-panel p-5 lg:p-6 ${className}`}>
      {children}
    </section>
  );
}

/**
 * The honest-sentence panel that replaces the scored body when trust says the
 * stored score cannot be stood behind (lib/web-leads/trust.ts). A sentence,
 * never a chart -- the same discipline as NotScored (rule 2).
 */
function UntrustedPanel({ hide }: { hide: NonNullable<TrustAssessment["hide"]> }) {
  return (
    <Panel>
      <SectionTitle>Why there is no score</SectionTitle>
      <p className="mt-3 max-w-3xl text-xl font-semibold leading-snug text-fg">{hide.headline}</p>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-fg-muted">{hide.detail}</p>
      <p className="mt-3 text-xs text-fg-dim">To re-measure the site, open &ldquo;Before you dial&rdquo; above.</p>
    </Panel>
  );
}

/**
 * Trust warnings, shown OUTSIDE every drawer and only when there are any. A
 * clean card shows nothing here; a card a rep should be careful with says so
 * before they read a single line of the script.
 */
function TrustWarnings({ warnings }: { warnings: TrustAssessment["warnings"] }) {
  if (warnings.length === 0) return null;
  return (
    <Panel className="space-y-1.5">
      <SectionTitle>Read this before you trust the numbers</SectionTitle>
      {warnings.map((w) => (
        <p key={w.code} className="text-sm text-fg-muted">{w.line}</p>
      ))}
    </Panel>
  );
}

/**
 * What this card knows about its OWN reliability: URL-ownership state, what
 * "measured" means, and the one-lead re-check control (Adon, 2026-09-01: fix
 * bad cards one at a time instead of re-crawling 30,000). Content only; it
 * lives inside the "Before you dial" drawer. The warnings themselves render
 * outside every drawer, in TrustWarnings.
 */
function MeasurementHonesty({
  audit, verification, hidden, recheck, canMutate, busy, postError, onRecheck,
}: {
  audit: AuditResult;
  verification: UrlVerification;
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
    <div>
      <Label>How much to trust this card</Label>
      <div className="mt-2 space-y-2 text-xs leading-relaxed">
        {verification.verdict === "verified" && (
          <p className="text-fg-muted">
            <span className="font-medium text-fg">Ownership confirmed.</span> This website was verified as this
            business&apos;s own site{verification.verifiedAt ? ` on ${formatDate(verification.verifiedAt)}` : ""}.
          </p>
        )}
        {audit.state === "scored" && !hidden && (
          <p className="text-fg-dim">
            Every number on this card was measured by our crawler on {formatDate(audit.measuredAt)}. Nothing is
            estimated; where we could not measure something, the card says so in words instead of showing a number.
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowHow((v) => !v)}
        aria-expanded={showHow}
        className="mt-2 rounded text-[11px] font-semibold text-fg-dim transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none"
      >
        {showHow ? "Hide how we measure" : "How we measure, and what we cannot see"}
      </button>
      {showHow && (
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-fg-dim">
          Our crawler reads the homepage&apos;s raw source and up to three of its stylesheets, once. It does not run
          the site&apos;s code the way a browser does, so sites that build their page in the browser can look empty to
          it, and it does not visit other pages, so a contact form living on a contact page is invisible to the
          score. Styling hosted on another domain may not be read. Where any of that makes a number unsafe, this card
          hides the number and says so rather than showing it.
        </p>
      )}

      <div className="mt-3 border-t border-bg-border pt-3">
        {open ? (
          <p className="text-xs text-fg-muted">
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
                aria-label="Correct website link (optional)"
                className="min-w-0 flex-1 rounded-lg border border-bg-border bg-bg-raised/50 px-3 py-2 text-xs text-fg placeholder:text-fg-faint focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => onRecheck(url.trim() || undefined)}
                className="shrink-0 rounded-lg border border-bg-border px-4 py-2 text-xs font-semibold text-fg transition-colors hover:border-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:opacity-50 motion-reduce:transition-none"
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
    </div>
  );
}

/** The arithmetic behind an area score, from the stored profile itself:
 *  points earned by passing checks, out of the area's 100. */
function earnedPoints(d: DimensionProfile): number {
  return d.checks.reduce((n, c) => n + (c.has ? c.points : 0), 0);
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
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-fg-muted">
        Nothing measured yet, so there is no score, ranking or chart. Sell from what we would build, below.
      </p>
    </Panel>
  );
}

/**
 * THE BUILD SECTION, WHICH THIS CARD MOUNTS TWICE (fix round 1, 2026-09-14).
 *
 * The catalogue's whole reason for existing is the lead with no website, and
 * the scored body renders only for `audit.state === "scored"`, so a lead with
 * no site gets the catalogue at container level instead. The two mounts are
 * mutually exclusive (one per arm of the body ternary), share the two
 * constants below for their wording, and both render `BuildCatalogue`, which
 * is the ONE place `CapabilityCatalogue` is invoked, so neither call site can
 * carry its own prop set. Pinned in tests/web-leads-battlecard.test.ts.
 */
const BUILD_TITLE = "What we would build for them";

/** True on EVERY lead: it promises no audit, claims no ranking
 *  unconditionally, and does not say "everything" -- the clean capabilities
 *  sit behind the catalogue's own "show all" control. */
const BUILD_SUB =
  "What Oasis would build, own and run for this business. Where their own audit found something, the heaviest items come first. Tap a row for what it is, what it is costing them, and the line to say.";

/** An empty audit, as a module constant so `CapabilityCatalogue`'s memo on
 *  `dimensions` is not invalidated by a fresh `[]` every render. */
const NO_DIMENSIONS: DimensionProfile[] = [];

/**
 * The industry-wide opportunity list, folded UNDER the lead's own catalogue
 * (compact card, 2026-10-01). It was its own open section, which put two
 * sell-lists one block apart; the lead's ranked catalogue is what a rep
 * reads on the call, and this is a browsing tool for when that runs out.
 */
function IndustryIdeas({ industry }: { industry: string | null | undefined }) {
  return (
    <details className="group mt-5 border-t border-bg-border pt-4">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded text-xs font-semibold text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden className="h-3.5 w-3.5 -rotate-90 transition-transform group-open:rotate-0 motion-reduce:transition-none" />
        More to offer this industry
      </summary>
      <div className="mt-4">
        <IndustryAutomationGuide initialIndustry={industry} />
      </div>
    </details>
  );
}

/** The single invocation of `CapabilityCatalogue` in this file. Both mounts
 *  render this rather than the catalogue directly, so the prop set cannot
 *  drift between them. */
function BuildCatalogue({
  dimensions, hasWebsite, signals, selectedAngleKey, industry, drawn, reduced,
}: {
  dimensions: DimensionProfile[];
  hasWebsite: boolean;
  signals: Record<string, unknown> | null;
  selectedAngleKey: string | null;
  industry: string | null | undefined;
  drawn: boolean;
  reduced: boolean;
}) {
  return (
    <>
      <CapabilityCatalogue
        dimensions={dimensions}
        hasWebsite={hasWebsite}
        signals={signals}
        drawn={drawn}
        reduced={reduced}
        selectedAngleKey={selectedAngleKey}
      />
      <IndustryIdeas industry={industry} />
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// The card
// ───────────────────────────────────────────────────────────────────────────

/**
 * `embedded` renders the SAME card inside another page, for /pipeline/[id].
 *
 * WHY THE SAME COMPONENT (Adon, 2026-08-25): "we have to ensure that the leads
 * tab and the pipeline are completely synonymous." A second rendering of one
 * business's failings is two things that can disagree mid-call, so the
 * pipeline gets this component, reading the same payload through the same
 * authorization boundary. Embedded only changes CHROME, never content: no
 * full-viewport background and no "Back to leads" link. Collapse state is
 * shared through the same localStorage keys on both surfaces.
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
  // One presence enqueue per lead per mount -- see the effect below.
  const presenceAskedRef = useRef(false);
  // What the card actually knows about that enqueue, which is what the
  // section is allowed to claim: idle (never asked / not needed), asking,
  // queued (the server took it), failed (it did not).
  const [presenceAsk, setPresenceAsk] = useState<{ status: "idle" | "asking" | "queued" | "failed" }>({ status: "idle" });
  const [presencePolls, setPresencePolls] = useState(0);
  // A MONOTONIC generation for presence requests. An in-flight POST captures
  // the current value and its answer is accepted only if the generation has
  // not moved -- so only a LEAD CHANGE or unmount discards it, never an
  // unrelated payload refresh.
  //
  // Why a counter and not the lead id (Codex review, 2026-09-03): navigating
  // A -> B -> A before the first A request settles makes an identity check
  // pass again, letting a stale response overwrite the newer request's state
  // and start polling from the wrong completion. A generation never repeats.
  const presenceGenRef = useRef(0);
  useEffect(() => {
    presenceGenRef.current += 1;
    return () => { presenceGenRef.current += 1; };
  }, [leadId]);

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
    presenceAskedRef.current = false;
    setPresenceAsk({ status: "idle" });
    setPresencePolls(0);
  }, [leadId]);

  // ON-DEMAND presence (phase 2): opening a card whose presence blob is
  // absent or stale asks the worker for ONE measurement.
  //
  // NOT fire-and-forget (Codex review, 2026-09-03, three findings that
  // compound): the empty state TELLS the rep a lookup was requested, so the
  // card must actually know that it was. The outcome drives the copy, a
  // bounded poll brings the answer back while they read, and the effect
  // refuses to act on a payload belonging to a different lead.
  useEffect(() => {
    if (state.status !== "ready" || presenceAskedRef.current) return;
    // THE LEAD-SWITCH RACE: a mounted card handed a new leadId clears the
    // ref one render before the new payload arrives, so this effect can see
    // the PREVIOUS lead's payload against the new id and spend a worker
    // request on the wrong business. The payload names its own lead; only
    // act when the two agree.
    if (state.payload.lead?.id !== leadId) return;
    const p = state.payload.onlinePresence ?? null;
    const wants = !p || p.state === "none" || (p.state === "measured" && p.stale);
    if (!wants) return;
    presenceAskedRef.current = true;
    // CANCELLATION IS SCOPED TO THE LEAD, NOT TO `state` (Codex review,
    // 2026-09-03): this effect depends on `state`, so a cleanup-based
    // `alive` flag is torn down by any unrelated payload refresh -- and the
    // card polls every 6s while a website re-check runs. That discarded the
    // POST's own answer and stranded the section at "asking" forever. The
    // generation captured here moves on exactly the two events that should
    // cancel: a lead change and unmount.
    const askedFor = presenceGenRef.current;
    setPresenceAsk({ status: "asking" });
    fetch(`/api/web-leads/${encodeURIComponent(leadId)}/presence`, { method: "POST" })
      .then((r) => {
        if (presenceGenRef.current !== askedFor) return;
        if (r.ok || r.status === 202) {
          setPresenceAsk({ status: "queued" });
          // The worker answers in ~a minute; poll a bounded number of times
          // so the section fills in while the rep is still on the page, and
          // stops rather than polling a card left open all shift.
          setPresencePolls(1);
          return;
        }
        // 409 (no business behind this lead), 500, anything else: say so.
        // A card that claims a request exists when none does is the exact
        // dishonesty this feature was built to remove.
        setPresenceAsk({ status: "failed" });
      })
      .catch(() => {
        if (presenceGenRef.current === askedFor) setPresenceAsk({ status: "failed" });
      });
  }, [state, leadId]);

  // The bounded presence poll: refresh the payload a few times after a
  // successful enqueue, then stop. Ends early the moment a measured,
  // non-stale blob arrives (the effect above will not re-ask for one).
  useEffect(() => {
    if (presencePolls === 0 || presencePolls > PRESENCE_POLL_LIMIT) return;
    if (state.status === "ready") {
      const p = state.payload.onlinePresence ?? null;
      if (p && p.state === "measured" && !p.stale) return;
    }
    const t = window.setTimeout(() => {
      setNonce((n) => n + 1);
      setPresencePolls((c) => c + 1);
    }, 8000);
    return () => window.clearTimeout(t);
  }, [presencePolls, state]);

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
  const onlinePresence = state.payload.onlinePresence ?? null;
  // DOES THIS BUSINESS HAVE A LIVE WEBSITE, from the AUDIT rather than from
  // the directory's `websiteUrl` field (`hasLiveWebsite` in
  // lib/web-leads/automations-match.ts, unit-tested against every state).
  // Computed HERE because this is the last scope in which `audit` is still
  // the whole union; inside the scored branch the type has narrowed and the
  // no-website comparison does not compile at all.
  const hasWebsite = hasLiveWebsite(audit);
  const scored = audit.state === "scored" && !trust.hide ? audit : null;

  return (
    <div className={`${displayFont.variable} ${dataFont.variable} ${embedded ? "" : "min-h-screen bg-bg"}`}>
      <Hero lead={lead} audit={audit} competitors={competitors} canMutate={canMutate} embedded={embedded} scoreHidden={Boolean(trust.hide)} />
      <BattleSections>
        <div className={embedded ? "space-y-4 pt-4" : "mx-auto max-w-6xl space-y-4 px-4 pb-16 pt-4 lg:px-8"}>
          <SectionToolbar />
          <TrustWarnings warnings={trust.warnings} />
          {/* BEFORE YOU DIAL: the three reference blocks a rep wants once,
              before the phone rings, and never during the call. History comes
              first because being the second person from the same company to
              phone someone this week is the fastest way to sound like the
              cold-call operation we are telling them we are not. Closed by
              default; the header already carries the name, address and phone. */}
          <BattleSection
            id="before-dial"
            defaultOpen={false}
            title="Before you dial"
            sub="What we have already sent them, what the directory recorded (unverified), and how far to trust this card."
            teaser="Past emails and calls, business details, and how far to trust this card"
          >
            <div className="space-y-6">
              <div>
                <Label>What we have already sent them</Label>
                <div className="mt-2">
                  <LeadTimelinePanel leadId={leadId} />
                </div>
              </div>
              <div>
                <Label>Who you are calling</Label>
                <div className="mt-2">
                  <BusinessFacts lead={lead} layout="grid" />
                </div>
              </div>
              <MeasurementHonesty
                audit={audit}
                verification={urlVerification}
                hidden={trust.hide !== null}
                recheck={recheck}
                canMutate={canMutate}
                busy={recheckPost.busy}
                postError={recheckPost.error}
                onRecheck={requestRecheck}
              />
            </div>
          </BattleSection>

          {trust.hide ? (
            // The score exists in the database but cannot be stood behind
            // (browser-built shell, or a website flagged as not theirs).
            // Adon's rule: hide it and say why -- never a number wearing a
            // warning. The industry list still renders: the rep still has a
            // business on the phone and something to offer it.
            <>
              <UntrustedPanel hide={trust.hide} />
              <Panel>
                <SectionTitle>What we could offer them</SectionTitle>
                <div className="mt-3">
                  <IndustryAutomationGuide initialIndustry={lead.industry} />
                </div>
              </Panel>
            </>
          ) : audit.state !== "scored" ? (
            // THE SECOND MOUNT. `NotScored` is the honest sentence about what
            // we do and do not know; the catalogue underneath it is the
            // entire pitch for this lead. A business with no website at all
            // is the best lead this feature produces. `NO_DIMENSIONS` is not
            // a stand-in for an audit: no non-scored state carries dimensions,
            // so this IS the lead's audit data, and `hasWebsite` alone picks
            // the catalogue's intro.
            <>
              <NotScored audit={audit} />
              <BattleSection id="build" defaultOpen={true} title={BUILD_TITLE} sub={BUILD_SUB}>
                <BuildCatalogue
                  dimensions={NO_DIMENSIONS}
                  hasWebsite={hasWebsite}
                  signals={signals}
                  // No dimensions means `selectAngle` has nothing to choose
                  // from, so no angle renders on this card.
                  selectedAngleKey={null}
                  industry={lead.industry}
                  drawn={drawn}
                  reduced={reduced}
                />
              </BattleSection>
            </>
          ) : (
            <ScoredBody
              lead={lead}
              audit={audit}
              signals={signals}
              hasWebsite={hasWebsite}
              drawn={drawn}
              reduced={reduced}
            />
          )}

          {/* PROOF: everything a rep reaches for only when a prospect pushes
              back. One drawer instead of four sections. The presence block
              renders for every lead (it is the pitch for a lead with no
              website); the audit-derived parts render only for a score we
              can stand behind. */}
          <BattleSection
            id="proof"
            defaultOpen={false}
            title="Proof, if they push back"
            teaser={
              scored
                ? "Who they are up against, every failing check, their online presence, and the raw crawl"
                : "Their online presence: Google, one consistent identity, email that lands"
            }
          >
            <div className="space-y-8">
              {scored && (
                <ScoredProof lead={lead} audit={scored} competitors={competitors} signals={signals} />
              )}
              <div>
                <Label>Their online presence</Label>
                <p className="mt-1 text-xs text-fg-dim">
                  Where customers look first: Google, one consistent identity, email that lands. Measured separately
                  from the website score.
                </p>
                <div className="mt-3">
                  <PresenceBlock presence={onlinePresence} ask={presenceAsk.status} />
                </div>
              </div>
            </div>
          </BattleSection>

          <Panel>
            {/* Reused wholesale rather than restyled: one component owns the
                outcomes, and logging an outcome IS the transfer to the pipeline
                (lib/web-leads/outcome.ts). It brings its own "Log this call"
                heading. Deliberately NOT collapsible: this is the card's one
                write surface, and the transfer to the pipeline must never be
                sitting behind a closed drawer when the call ends. */}
            <CallOutcomeLog leadId={leadId} canMutate={canMutate} />
          </Panel>
        </div>
      </BattleSections>
    </div>
  );
}

/** How many times a card re-polls for a queued presence measurement before
 *  giving up. Six 8-second polls ≈ 48s, which covers the worker's ~30s poll
 *  plus one lookup; past that a card left open all shift must stop asking. */
const PRESENCE_POLL_LIMIT = 6;

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
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-6 lg:px-8">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-44 rounded-xl border border-bg-border bg-bg-panel animate-pulse-slow" />
        ))}
      </div>
    </div>
  );
}

/**
 * The header: who to ask for, the number to dial, their site, the score, and
 * the one sentence that makes the score mean something. No backdrop layers:
 * everything here is information.
 */
function Hero({
  lead, audit, competitors, canMutate, embedded = false, scoreHidden = false,
}: {
  lead: WebLead;
  audit: AuditResult;
  competitors: CompetitorContext | null;
  canMutate: boolean;
  embedded?: boolean;
  /** Trust said the stored score cannot be stood behind: render no number
   *  anywhere, including here and the percentile it feeds. */
  scoreHidden?: boolean;
}) {
  const websiteHref = preferredSiteUrl(lead.websiteUrl);
  return (
    <header className="border-b border-bg-border bg-bg-panel/60">
      <div className={embedded ? "px-4 py-5 lg:px-6" : "mx-auto max-w-6xl px-4 py-6 lg:px-8"}>
        {!embedded && <BackLink />}
        <div className={`${embedded ? "" : "mt-4"} flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between`}>
          <div className="min-w-0">
            <h1 className="text-3xl font-bold leading-tight tracking-tight text-fg">{lead.name}</h1>
            {/* WHO TO ASK FOR, directly under the business name because that
                is the order the sentence comes out: "Hi, is Marc in?" Rendered
                only when somebody is actually identified; there is no fallback
                to the business name, which would put "Ask for HVAC Mechanical
                Systems Inc" in the rep's mouth. */}
            {lead.ownerName && (
              <p className="mt-1.5 text-base font-semibold text-accent">
                Ask for {lead.ownerName}
                {lead.ownerTitle ? <span className="font-normal text-fg-muted"> · {lead.ownerTitle}</span> : null}
              </p>
            )}
            {/* The FULL address, street and postal code included: a rep
                confirming a business by name needs the street to be sure they
                have the right branch. */}
            <p className="mt-2 text-sm text-fg-muted">
              {[lead.industry, fullAddress(lead)].filter(Boolean).join(" · ") || "No location on file"}
            </p>
            {/* Full width and 56px tall below `sm`: a rep reading this on a
                phone is usually about to dial, and `tel:` is the one control
                here that does something better on a phone. `whitespace-nowrap`
                because `+1-416-` / `259-` / `9326` is not a number a rep can
                read out. */}
            <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
              {lead.phone && canMutate ? (
                <a
                  href={`tel:${lead.phone}`}
                  className="inline-flex min-h-14 w-full items-center justify-center gap-2.5 whitespace-nowrap rounded-lg bg-accent px-5 text-lg font-bold tabular-nums text-white transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 motion-reduce:transition-none sm:min-h-0 sm:w-auto sm:py-3 sm:text-base"
                >
                  <Phone className="h-5 w-5 shrink-0" />{lead.phone}
                </a>
              ) : lead.phone ? (
                <p className="rounded-lg border border-bg-border px-5 py-3 text-center text-base tabular-nums text-fg-muted sm:text-left">{lead.phone}</p>
              ) : (
                <p className="rounded-lg border border-bg-border px-5 py-3 text-sm text-fg-dim">No phone number on file</p>
              )}
              {/* preferredSiteUrl adds a scheme to bare domains, allowlists
                  http/https (these come from OpenStreetMap, which anyone can
                  edit), and prefers the origin over a stale deep path. Render
                  NOTHING when it returns null -- a missing button is honest, a
                  dead one is not. */}
              {websiteHref && (
                <a
                  href={websiteHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-bg-border bg-bg-panel px-4 text-sm font-semibold text-fg transition-colors hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 motion-reduce:transition-none sm:py-3"
                >
                  <ExternalLink className="h-4 w-4" />View website
                </a>
              )}
            </div>
          </div>

          <div className="shrink-0 lg:text-right">
            {audit.state === "scored" && scoreHidden ? (
              <p className="max-w-xs text-sm font-semibold leading-snug text-fg-muted">
                No score is shown for this site. The panel below says exactly why.
              </p>
            ) : audit.state === "scored" ? (
              <>
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-fg-muted">Website score</p>
                <p className="mt-1 text-4xl font-bold leading-none tabular-nums text-fg">
                  {audit.composite}
                  <span className="text-base font-medium text-fg-dim">/100</span>
                </p>
                <p className="mt-1 text-xs text-fg-dim">Measured {formatDate(audit.measuredAt)}</p>
              </>
            ) : (
              <p className="max-w-xs text-sm font-semibold leading-snug text-fg-muted">
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
          <PercentileSentence competitors={competitors} />
        )}
      </div>
    </header>
  );
}

/**
 * The strongest honest sentence this system can produce, and the reason the
 * competitor work exists at all. It never quotes a percentile without naming
 * the group, and never against a group small enough for a prospect to count
 * (lib/web-leads/competitors.ts guarantees that, and hands back every
 * rejected slice so this can say so out loud).
 */
function PercentileSentence({ competitors }: { competitors: CompetitorContext }) {
  const { slice, percentile, rejected } = competitors;
  const pctText = percentile.lowerThanPct === 0 ? "under 1%" : `${percentile.lowerThanPct}%`;
  return (
    <div className="mt-5 border-t border-bg-border pt-4">
      <p className="text-lg font-semibold leading-snug text-fg">
        {percentile.rank === 1
          ? `Nothing we have measured among ${fmt(slice.peerCount)} ${slice.label} scores higher.`
          : `Scores lower than ${pctText} of the ${fmt(slice.peerCount)} ${slice.label} we have measured.`}
      </p>
      {/* NEVER a silent fallback. If the local slice was too thin to be
          honest, the wider one that replaced it is named here. */}
      {rejected.length > 0 && (
        <p className="mt-1 text-xs leading-relaxed text-fg-faint">
          Only {fmt(rejected[0].peerCount)} {rejected[0].label} have been scored, too few to compare against, so this
          is measured against {slice.label} instead.
        </p>
      )}
    </div>
  );
}

/**
 * The call itself, for a scored lead: the script, the objections, and what we
 * would build. Everything else is reference and lives in the two drawers.
 */
function ScoredBody({
  lead, audit, signals, hasWebsite, drawn, reduced,
}: {
  lead: WebLead;
  audit: Extract<AuditResult, { state: "scored" }>;
  signals: Record<string, unknown> | null;
  /** Read off the audit's own state by the container (the one scope where
   *  `AuditResult` is still the whole union) and handed down, so the
   *  MEASUREMENT decides it and never the directory's `websiteUrl` field. */
  hasWebsite: boolean;
  drawn: boolean;
  reduced: boolean;
}) {
  const angle = useMemo(() => selectAngle(audit.dimensions), [audit.dimensions]);

  return (
    <>
      {/* ── THE SCRIPT ─────────────────────────────────────────────────────
          One opener, not two: the old "one thing to lead with" line and this
          script were both built from the same worst gap. Rendered in the order
          the beats are spoken, because a rep mid-call reads down the page and
          says what is in front of them. Beat one is stated; beat two is asked
          and followed by silence; beat three only earns its place AFTER an
          answer -- delivering it early manufactures the objection to it.
          Rationale and sources in lib/web-leads/angles.ts. */}
      {angle && (
        <BattleSection
          id="opening"
          defaultOpen={true}
          title="The script"
          sub={<>Chosen because {angle.label.toLowerCase()} is costing them the most. Give your name and company first, then these in order.</>}
        >
          <Label>1. Say this</Label>
          <p className="mt-1.5 max-w-4xl text-lg font-semibold leading-relaxed text-fg">&ldquo;{angle.angle.opener}&rdquo;</p>
          <div className="mt-5"><Label>2. Ask this, then stop talking</Label></div>
          <p className="mt-1.5 max-w-4xl text-lg font-semibold leading-relaxed text-fg">&ldquo;{angle.angle.diagnostic}&rdquo;</p>
          {/* With the question, never below the fold of it: after a clean
              answer, the cost line below describes a problem the prospect has
              just shown they do not have. */}
          <p className="mt-2 max-w-4xl text-xs leading-relaxed text-fg-muted">{IF_THE_ANSWER_IS_CLEAN}</p>
          <div className="mt-5"><Label>3. Once they answer, why it costs them</Label></div>
          <p className="mt-1.5 max-w-4xl text-sm leading-relaxed text-fg-dim">{angle.angle.cost}</p>
          {/* Held in reserve, and labelled as such: what a rep reaches for when
              the prospect disputes the general claim, with the source beside it
              so a rep challenged twice can name where it came from. */}
          {angle.angle.proof && (
            <div className="mt-5 rounded-lg border border-bg-border bg-bg-raised/60 p-4">
              <Label>Only if they push back on that</Label>
              <p className="mt-1.5 max-w-4xl text-sm leading-relaxed text-fg-dim">{angle.angle.proof.stat}</p>
              <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">Source: {angle.angle.proof.source}</p>
            </div>
          )}
        </BattleSection>
      )}

      {/* DEFAULT OPEN (Adon, 2026-09-10): the cards are ranked for the business
          on the phone, and a section a rep has to open first is a section a rep
          does not open mid-sentence. */}
      <BattleSection
        id="brushoffs"
        defaultOpen={true}
        title="Objections and what to say"
        teaser="The objections this business is most likely to raise, ranked, with the counter for each and a one-tap log"
      >
        <ObjectionConsole leadId={lead.id} bare />
      </BattleSection>

      {/* The capability catalogue (Task 5, 2026-09-14): the fifteen reviewed
          capabilities, ranked for this lead, in words an owner recognises as
          something they would buy. Read mid-call, so it may not cost a click. */}
      <BattleSection
        id="fixes"
        defaultOpen={true}
        title={BUILD_TITLE}
        sub={BUILD_SUB}
      >
        <BuildCatalogue
          dimensions={audit.dimensions}
          hasWebsite={hasWebsite}
          signals={signals}
          selectedAngleKey={angle?.key ?? null}
          industry={lead.industry}
          drawn={drawn}
          reduced={reduced}
        />
      </BattleSection>
    </>
  );
}

/**
 * The audit-derived half of the proof drawer, for a score we can stand
 * behind: rivals, every failing check, and the raw crawl.
 */
function ScoredProof({
  lead, audit, competitors, signals,
}: {
  lead: WebLead;
  audit: Extract<AuditResult, { state: "scored" }>;
  competitors: CompetitorContext | null;
  signals: Record<string, unknown> | null;
}) {
  const worstFirst = useMemo(
    () => [...audit.dimensions].sort((a, b) => recoverablePoints(b) - recoverablePoints(a)),
    [audit.dimensions],
  );
  const evidence = useMemo(() => evidenceFrom(signals), [signals]);
  const totalChecks = audit.dimensions.reduce((n, d) => n + d.checks.length, 0);
  const failing = worstFirst.filter((d) => d.checks.some((c) => !c.has));

  return (
    <>
      <div>
        <Label>Who they are up against</Label>
        {competitors && (
          <p className="mt-1 text-xs text-fg-dim">
            The best-scoring {competitors.slice.label} we have measured, on the same {totalChecks} checks. Real
            businesses, open any of them while you are on the call.
          </p>
        )}
        <div className="mt-3">
          <Competitors competitors={competitors} audit={audit} lead={lead} />
        </div>
      </div>

      <div>
        <Label>Everything failing on their site</Label>
        <p className="mt-1 text-xs text-fg-dim">
          Grouped by what it affects, worst first. Each line names what the crawler actually measured, so no number
          has to be taken on faith.
        </p>
        {failing.length === 0 ? (
          <p className="mt-3 text-sm text-fg-dim">Every check we run passed on this site.</p>
        ) : (
          <div className="mt-3 space-y-5">
            {failing.map((d) => {
              const misses = d.checks.filter((c) => !c.has).sort((a, b) => b.points - a.points);
              return (
                <div key={d.key} id={`battle-dim-${d.key}`} className="scroll-mt-24">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-semibold text-fg">{d.label}</h3>
                    <p className="text-xs tabular-nums text-fg-muted">
                      Scores <span className="text-fg">{d.score}</span> · {earnedPoints(d)} of 100 points earned ·{" "}
                      {misses.length} of {d.checks.length} {misses.length === 1 ? "check" : "checks"} failing
                    </p>
                  </div>
                  <ul className="mt-2 grid gap-2 md:grid-cols-2">
                    {misses.map((check: CheckResult) => (
                      <li key={check.code} className="rounded-lg border border-bg-border bg-bg-raised/60 p-3">
                        <div className="flex items-baseline justify-between gap-3">
                          <p className="text-sm font-semibold text-fg">{check.label}</p>
                          {/* The check's exact worth in this area's 100: the
                              score is these numbers added up, and a rep
                              should be able to do the addition out loud. */}
                          <span className="shrink-0 text-[11px] tabular-nums text-fg-dim">
                            {check.points} of this area&apos;s 100 pts
                          </span>
                        </div>
                        <MeasuredLine code={check.code} signals={signals} />
                        <RemedyLines code={check.code} />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <Label>The raw crawl</Label>
        <p className="mt-1 text-xs text-fg-dim">
          For when a prospect says they redid the site last year. Every line is something the crawler saw on{" "}
          {formatDate(audit.measuredAt)}; anything it did not record is left out rather than shown as a zero.
        </p>
        {evidence.length === 0 ? (
          <p className="mt-3 text-sm text-fg-muted">
            No raw measurements were stored alongside this score, so there is nothing to quote here.
          </p>
        ) : (
          <div className="mt-3 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {evidence.map((group) => (
              <div key={group.title}>
                <p className="text-xs font-semibold text-fg-muted">{group.title}</p>
                <dl className="mt-1.5 divide-y divide-bg-border/60">
                  {group.rows.map((row) => (
                    <div key={row.label} className="flex items-baseline justify-between gap-3 py-1.5">
                      <dt className="text-xs text-fg-dim">{row.label}</dt>
                      <dd className="shrink-0 text-right text-xs font-medium tabular-nums text-fg-muted">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Real, named, locally-measured competitors: the top few, each openable, and
 * the area-by-area numbers against the one we hold a full breakdown for.
 */
function Competitors({
  competitors, audit, lead,
}: {
  competitors: CompetitorContext | null;
  audit: Extract<AuditResult, { state: "scored" }>;
  lead: WebLead;
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
            <li key={`${c.name}-${i}`} className="rounded-lg border border-bg-border bg-bg-raised/60 p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-fg">{c.name}</p>
                  <p className="mt-0.5 truncate text-xs text-fg-dim">
                    {[c.city, c.province].filter(Boolean).join(", ") || "Location not recorded"}
                  </p>
                </div>
                <span className="shrink-0 text-xl font-bold leading-none tabular-nums text-fg">{c.score}</span>
              </div>
              {href && (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-bg-border px-2.5 py-1.5 text-[11px] font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none"
                >
                  <ExternalLink className="h-3 w-3" />Open their site
                </a>
              )}
            </li>
          );
        })}
      </ul>

      {headToHead && (
        <div className="mt-5 border-t border-bg-border pt-4">
          <p className="text-sm font-semibold text-fg">
            {lead.name} against {headToHead.competitor.name}, area by area
          </p>
          {/* "The best-scoring" is only said when it IS the best-scoring.
              buildHeadToHead falls through to the next candidate when the top
              one has no readable profile, and calling that one the best is a
              false claim about a named business made on a live call. (Codex
              review, 2026-08-24.) */}
          <p className="mt-1 text-xs text-fg-dim">
            {headToHead.rankInSlice === 1
              ? `The best-scoring of the ${fmt(slice.peerCount)} ${slice.label} we have measured, last checked ${formatDate(headToHead.measuredAt)}.`
              : `Among the top-scoring ${slice.label} we have measured, last checked ${formatDate(headToHead.measuredAt)}. We do not hold an area-by-area breakdown for the highest-scoring one, so this is the closest that we do.`}{" "}
            It scores {headToHead.composite} where this one scores {audit.composite}.
          </p>
          <dl className="mt-3 divide-y divide-bg-border/60">
            {headToHead.dimensions.map((d) => (
              <div key={d.key} className="flex items-baseline justify-between gap-4 py-1.5">
                <dt className="min-w-0 truncate text-xs text-fg-muted">{d.label}</dt>
                {/* A signed number, not a colour and not an arrow. The sign is
                    a fact about two measurements; a red arrow is a verdict. */}
                <dd className="shrink-0 text-right text-xs tabular-nums text-fg-dim">
                  <span className="font-semibold text-fg">{d.theirs}</span> vs {d.leader}
                  <span className="ml-2 text-fg-muted">({d.diff > 0 ? "+" : ""}{d.diff})</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </>
  );
}

export default BattleCard;
