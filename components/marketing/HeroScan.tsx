"use client";

import { useRef, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { CTA_PRIMARY } from "@/components/marketing/Cta";
import { HoneypotField } from "@/components/forms/HoneypotField";
import { trapValue } from "@/lib/forms/honeypot";
import { scanPath, startScan } from "@/components/scan/start-scan";

/**
 * The landing page's front door to the free scan (CC, 2026-11-13: "it should live on our landing
 * page"): paste a website, press Scan, land on /scan/<id> with the agent already working. The same
 * start as the /scan page itself (components/scan/start-scan.ts): one request, one claim key, one
 * count on the scan's offer, and the visitor's campaign tags carried on to the claim.
 */
export function HeroScan() {
  const [website, setWebsite] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trapRef = useRef<HTMLInputElement | null>(null);
  const trapLatch = useRef("");
  const inFlight = useRef(false);

  async function start(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setStarting(true);
    const started = await startScan(website, trapValue(trapRef.current, trapLatch));
    if (!started.ok) {
      setError(started.error);
      setStarting(false);
      if (!started.trapped) inFlight.current = false;
      return;
    }
    // The scan is running already: its page follows it live. The claim key is kept for this tab;
    // a browser that keeps no storage gets it in the address fragment instead, so the visitor can
    // still send the report they just started.
    window.location.assign(scanPath(started.scanId, undefined, started.claimKeyKept ? null : started.claimKey));
  }

  return (
    <div className="max-w-2xl">
      <form onSubmit={start} className="relative" aria-label="Free AI scan of your website">
        <HoneypotField inputRef={trapRef} />
        <label htmlFor="hero-scan-website" className="sr-only">
          Your website
        </label>
        <div className="flex flex-col gap-2 border border-ops-edge bg-ops-panel/90 p-2 backdrop-blur sm:flex-row sm:items-center">
          <input
            id="hero-scan-website"
            name="website"
            type="text"
            inputMode="url"
            autoComplete="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="Paste your website, e.g. yourbusiness.com"
            className="min-w-0 flex-1 bg-transparent px-4 py-3 text-[16px] text-fg placeholder:text-fg-dim focus:outline-none"
            required
          />
          <button type="submit" disabled={starting} className={`${CTA_PRIMARY} shrink-0`}>
            {starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Scan my site free
            {!starting ? <ArrowRight className="h-4 w-4" aria-hidden="true" /> : null}
          </button>
        </div>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-[14px] text-status-warm">
          {error}
        </p>
      ) : (
        <p className="mt-2 text-[13px] text-fg-dim">Free. No account. Watch an AI read your site, score it and find who buys from you, in about a minute.</p>
      )}
    </div>
  );
}
