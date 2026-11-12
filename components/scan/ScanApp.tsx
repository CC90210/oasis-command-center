"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { CTA_PRIMARY } from "@/components/marketing/Cta";
import { HoneypotField } from "@/components/forms/HoneypotField";
import { trapValue } from "@/lib/forms/honeypot";
import type { ConsentIdentity } from "@/lib/consent/ledger-disclosure";
import type { ScanView } from "@/lib/site-scan/types";
import { ScanReport } from "@/components/scan/ScanReport";
import { StageRail } from "@/components/scan/StageRail";
import { ClaimForm } from "@/components/scan/ClaimForm";

/**
 * The free scan, end to end in the browser: paste a domain, POST /api/scan, then watch
 * GET /api/scan/:id every two seconds until nothing is running. Sections appear as their data
 * lands; nothing is drawn before the server has it.
 */

const POLL_MS = 2_000;
const CLAIM_KEY_STORE = "oasis-scan-claim:";

/** The claim key POST /api/scan gave this browser, kept for the tab so a reload can still save the report. */
function storedClaimKey(scanId: string): string | null {
  try {
    return window.sessionStorage.getItem(CLAIM_KEY_STORE + scanId);
  } catch {
    return null;
  }
}

function storeClaimKey(scanId: string, key: string): void {
  try {
    window.sessionStorage.setItem(CLAIM_KEY_STORE + scanId, key);
  } catch {
    // Private mode or storage off: the key still lives in memory for this page.
  }
}

type Props = {
  initialScanId: string | null;
  consentIdentity: ConsentIdentity;
  bookingUrl: string | null;
  proof: { scans: number; domains: number } | null;
};

const INPUT_ERRORS: Record<string, string> = {
  website_required: "Paste your website address first.",
  not_a_website: "That does not look like a public website address. Try the form www.yourbusiness.com.",
  social_profile: "That is a social profile, not a website. Paste the business's own site, or tell us you don't have one.",
  rate_limited: "That is a lot of scans from one place. Give it an hour, or book a call and we will run them with you.",
  not_installed: "The scanner is being set up on this deployment. Try again shortly.",
  forbidden: "Open this page on oasisai.work and try again.",
};

export function ScanApp({ initialScanId, consentIdentity, bookingUrl, proof }: Props) {
  const [website, setWebsite] = useState("");
  const [scanId, setScanId] = useState<string | null>(initialScanId);
  const [scan, setScan] = useState<ScanView | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);
  // Read once on the client; the claim section draws only after the first poll, so server and client markup agree.
  const [claimKey, setClaimKey] = useState<string | null>(() => (typeof window !== "undefined" && initialScanId ? storedClaimKey(initialScanId) : null));
  const trapRef = useRef<HTMLInputElement | null>(null);
  const trapLatch = useRef("");
  const inFlight = useRef(false);

  const poll = useCallback(async (id: string): Promise<ScanView | null> => {
    const res = await fetch(`/api/scan/${encodeURIComponent(id)}`, { cache: "no-store" });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; scan?: ScanView; error?: string } | null;
    if (!res.ok || !data?.ok || !data.scan) {
      setError(data?.error === "not_found" ? "That scan link has expired. Start a new one below." : "The scan could not be read right now.");
      return null;
    }
    return data.scan;
  }, []);

  useEffect(() => {
    if (!scanId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const next = await poll(scanId);
      if (!alive) return;
      if (next) {
        setScan(next);
        setClaimed((c) => c || next.claimed);
        const running = next.stages.some((s) => s.state === "running" || s.state === "pending") && next.status !== "failed";
        if (running) timer = setTimeout(tick, POLL_MS);
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [scanId, poll]);

  async function start(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    const trapped = trapValue(trapRef.current, trapLatch);
    setStarting(true);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ website, honeypot: trapped }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; scan_id?: string; claim_key?: string | null; trapped?: boolean; error?: string; platform?: string } | null;
      if (data?.trapped) {
        setError("Thanks. We will take it from here.");
        return;
      }
      if (!res.ok || !data?.ok || !data.scan_id) {
        setError(INPUT_ERRORS[data?.error ?? ""] ?? "That didn't go through. Try again in a moment.");
        inFlight.current = false;
        return;
      }
      setScan(null);
      setClaimed(false);
      setClaimKey(data.claim_key ?? null);
      if (data.claim_key) storeClaimKey(data.scan_id, data.claim_key);
      setScanId(data.scan_id);
      if (typeof window !== "undefined") window.history.replaceState(null, "", `/scan/${data.scan_id}`);
      inFlight.current = false;
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
      inFlight.current = false;
    } finally {
      setStarting(false);
    }
  }

  function reset() {
    setScanId(null);
    setScan(null);
    setError(null);
    setClaimed(false);
    setClaimKey(null);
    if (typeof window !== "undefined") window.history.replaceState(null, "", "/scan");
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
    <div className="mx-auto grid w-full max-w-6xl gap-8 lg:grid-cols-[260px_1fr]">
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <StageRail scan={scan} />
        <button type="button" onClick={reset} className="mt-6 text-[13px] text-fg-dim underline decoration-ops-edge underline-offset-4 hover:text-fg">
          Scan a different site
        </button>
      </aside>
      <div className="min-w-0">
        {error ? <p role="alert" className="mb-4 border border-status-warm/40 bg-ops-panel p-4 text-[14px] text-status-warm">{error}</p> : null}
        {scan ? <ScanReport scan={scan} /> : <p className="font-data text-[12px] uppercase tracking-[0.22em] text-fg-dim">Connecting to the scanner…</p>}
        {scan && scan.facts && !scan.error ? (
          <section id="claim" className="mt-12 scroll-mt-24 border border-ops-edge bg-ops-panel/90 p-6 sm:p-8">
            {claimed ? (
              <ClaimedPanel bookingUrl={bookingUrl} />
            ) : claimKey ? (
              <>
                <p className="font-data text-[10px] uppercase tracking-[0.24em] text-signal">Keep this report</p>
                <h2 className="mt-3 font-display text-2xl font-semibold text-fg">Get the three fixes priced by a founder.</h2>
                <p className="mt-2 text-[15px] leading-relaxed text-fg-muted">
                  Send this report to the OASIS team and it becomes a live audit in our Command Center. A founder reads it, prices the fixes, and emails you; book a call if you want one. No obligation.
                </p>
                <div className="mt-6">
                  <ClaimForm scanId={scan.id} claimKey={claimKey} businessName={scan.facts.signals?.business_name ?? scan.domain} website={scan.url} consentIdentity={consentIdentity} onClaimed={() => setClaimed(true)} />
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
