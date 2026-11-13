"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { CTA_PRIMARY } from "@/components/marketing/Cta";
import { HoneypotField } from "@/components/forms/HoneypotField";
import { trapValue } from "@/lib/forms/honeypot";
import type { ConsentIdentity } from "@/lib/consent/ledger-disclosure";
import type { ScanView } from "@/lib/site-scan/types";
import { claimHeading } from "@/lib/site-scan/score";
import { ScanReport } from "@/components/scan/ScanReport";
import { ClaimForm } from "@/components/scan/ClaimForm";
import { LiveWorkspace } from "@/components/scan/LiveWorkspace";
import { useScanStream } from "@/components/scan/useScanStream";
import { scanPath, startScan, storedClaimKey, trackScan } from "@/components/scan/start-scan";

/**
 * The free scan, end to end in the browser: paste a domain, POST /api/scan, then follow
 * GET /api/scan/:id/stream (components/scan/useScanStream.ts): the agent's work log line by line,
 * and the report's sections as their data lands. Nothing is drawn before the server has it.
 */

type Props = {
  initialScanId: string | null;
  consentIdentity: ConsentIdentity;
  bookingUrl: string | null;
  proof: { scans: number; domains: number } | null;
  /** The form "Send it to the OASIS team" submits (lib/site-scan/claim.ts scanClaimFormSlug). */
  claimFormSlug: string;
};

export function ScanApp({ initialScanId, consentIdentity, bookingUrl, proof, claimFormSlug }: Props) {
  const [website, setWebsite] = useState("");
  const [scanId, setScanId] = useState<string | null>(initialScanId);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);
  // Read once on the client; the claim section draws only after the first frame, so server and client markup agree.
  const [claimKey, setClaimKey] = useState<string | null>(() => (typeof window !== "undefined" && initialScanId ? storedClaimKey(initialScanId) : null));
  const trapRef = useRef<HTMLInputElement | null>(null);
  const trapLatch = useRef("");
  const inFlight = useRef(false);
  const live = useScanStream(scanId);
  const scan: ScanView | null = live.scan;
  const error = startError ?? live.error;
  const setError = setStartError;

  useEffect(() => {
    if (scan?.claimed) setClaimed(true);
  }, [scan?.claimed]);

  // The free scan's offer counts (offer_funnel_events): one view per page load, and a finished
  // report once per scan this visitor watched run (a permalink opened later is not a new finish).
  useEffect(() => {
    trackScan("page_view");
  }, []);
  const finishedCounted = useRef<string | null>(null);
  useEffect(() => {
    if (!scanId || !live.finished || live.wasFinished || finishedCounted.current === scanId) return;
    finishedCounted.current = scanId;
    trackScan("scan_finished");
  }, [scanId, live.finished, live.wasFinished]);

  // A scan started from the form brings the agent's workspace into view: on /scan it opens below
  // the hero, where a visitor would otherwise miss the work starting.
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const startedHere = useRef(false);
  useEffect(() => {
    if (!scanId || !startedHere.current) return;
    startedHere.current = false;
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    workspaceRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [scanId]);

  async function start(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    const trapped = trapValue(trapRef.current, trapLatch);
    setStarting(true);
    try {
      const started = await startScan(website, trapped);
      if (!started.ok) {
        setError(started.error);
        // A trapped submission stays latched: a script that filled the honeypot does not retry.
        if (!started.trapped) inFlight.current = false;
        return;
      }
      setClaimed(false);
      setClaimKey(started.claimKey);
      startedHere.current = true;
      setScanId(started.scanId);
      // The page's own query (utm_*) stays on the address, so the claim files the lead with it.
      if (typeof window !== "undefined") window.history.replaceState(null, "", scanPath(started.scanId));
      inFlight.current = false;
    } finally {
      setStarting(false);
    }
  }

  function reset() {
    setScanId(null);
    setError(null);
    setClaimed(false);
    setClaimKey(null);
    if (typeof window !== "undefined") window.history.replaceState(null, "", `/scan${window.location.search}`);
  }

  if (!scanId) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <form onSubmit={start} className="relative">
          <HoneypotField inputRef={trapRef} />
          <label htmlFor="scan-website" className="sr-only">Your website</label>
          <div className="flex flex-col gap-3 border border-ops-edge bg-ops-panel/90 p-2 backdrop-blur sm:flex-row sm:items-center">
            <input
              id="scan-website"
              name="website"
              type="text"
              inputMode="url"
              autoComplete="url"
              autoFocus
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="Paste your website, e.g. yourbusiness.com"
              className="min-w-0 flex-1 bg-transparent px-4 py-3 text-[17px] text-fg placeholder:text-fg-dim focus:outline-none"
              required
            />
            <button type="submit" disabled={starting} className={`${CTA_PRIMARY} shrink-0`}>
              {starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Scan my business
              {!starting ? <ArrowRight className="h-4 w-4" aria-hidden="true" /> : null}
            </button>
          </div>
        </form>
        {error ? <p role="alert" className="mt-3 text-[14px] text-status-warm">{error}</p> : null}
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-fg-dim">
          <span>Free. No account. About a minute.</span>
          {proof && proof.domains >= 25 ? <span className="font-data text-[11px] uppercase tracking-[0.2em]">{proof.domains.toLocaleString("en-CA")} businesses scanned</span> : null}
          {bookingUrl ? (
            <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-ops-edge underline-offset-4 hover:text-fg">
              I don&rsquo;t have a website
            </a>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div ref={workspaceRef} className="mx-auto w-full max-w-6xl scroll-mt-24">
      {/* Above the workspace, where the visitor is looking, with the way out right under it. */}
      {error ? <p role="alert" className="mb-4 border border-status-warm/40 bg-ops-panel p-4 text-[14px] text-status-warm">{error}</p> : null}
      <LiveWorkspace scan={scan} events={live.events} finished={live.finished} wasFinished={live.wasFinished} stopped={live.gone} />
      <button type="button" onClick={reset} className="mt-4 text-[13px] text-fg-dim underline decoration-ops-edge underline-offset-4 hover:text-fg">
        Scan a different site
      </button>
      <div className="mt-8 min-w-0">
        {scan ? <ScanReport scan={scan} /> : null}
        {scan && scan.facts && !scan.error ? (
          <section id="claim" className="mt-12 scroll-mt-24 border border-ops-edge bg-ops-panel/90 p-6 sm:p-8">
            {claimed ? (
              <ClaimedPanel bookingUrl={bookingUrl} />
            ) : claimKey ? (
              <>
                <p className="font-data text-[10px] uppercase tracking-[0.24em] text-signal">Keep this report</p>
                <h2 className="mt-3 font-display text-2xl font-semibold text-fg">{claimHeading(scan.score?.fixes.length ?? 0)}</h2>
                <p className="mt-2 text-[15px] leading-relaxed text-fg-muted">
                  Send this report to the OASIS team and it becomes a live audit in our Command Center. A founder reads it, prices the fixes, and emails you; book a call if you want one. No obligation.
                </p>
                <div className="mt-6">
                  <ClaimForm scanId={scan.id} claimKey={claimKey} businessName={scan.facts.signals?.business_name ?? scan.domain} website={scan.url} consentIdentity={consentIdentity} formSlug={claimFormSlug} onClaimed={() => setClaimed(true)} />
                </div>
              </>
            ) : (
              <>
                <p className="font-data text-[10px] uppercase tracking-[0.24em] text-signal">Your own business?</p>
                <h2 className="mt-3 font-display text-2xl font-semibold text-fg">Run the free scan on your site.</h2>
                <p className="mt-2 text-[15px] leading-relaxed text-fg-muted">This is a shared report. A report can be sent to the OASIS team from the browser that ran it.</p>
                <button type="button" onClick={reset} className={`${CTA_PRIMARY} mt-6`}>
                  Scan my business <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function ClaimedPanel({ bookingUrl }: { bookingUrl: string | null }) {
  return (
    <div>
      <p className="font-data text-[10px] uppercase tracking-[0.24em] text-status-engaged">Saved</p>
      <h2 className="mt-3 font-display text-2xl font-semibold text-fg">Your report is in the audit queue.</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-fg-muted">
        A founder reads every one. You will get the priced fixes by email; the fastest way to the fixes themselves is a short call.
      </p>
      {bookingUrl ? (
        <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className={`${CTA_PRIMARY} mt-6`}>
          Have OASIS do the outreach <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}
