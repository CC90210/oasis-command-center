"use client";

/**
 * P0 web-vitals beacon (instant-load plan, 2026-09-01).
 *
 * Reports TTFB/FCP/LCP/INP/CLS (+ Next.js custom metrics) to our own
 * /api/perf/vitals endpoint. First-party on purpose: the fleet is
 * mid-cutover Vercel→Cloudflare, so a @vercel/speed-insights dependency
 * would stop reporting the day the host flips. This survives the move.
 *
 * Payload carries metric name, value, rating, and pathname ONLY — no
 * lead data, no query strings (they can embed filter text), no user
 * identity. Fail-open: a failed beacon never surfaces to the operator.
 *
 * Also installs the click → route-commit timing (lib/perf/nav-timing.ts,
 * 2026-10-28), which the board completes with reportBoardVisible().
 */

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useReportWebVitals } from "next/web-vitals";
import { recordLinkClick, reportRouteCommit, sendVital } from "@/lib/perf/nav-timing";

export function PerfVitals() {
  useReportWebVitals((metric) => {
    try {
      sendVital(
        metric.name,
        metric.value,
        (metric as { rating?: string }).rating ?? null,
        window.location.pathname,
      );
    } catch {
      // fail-open
    }
  });

  useEffect(() => {
    document.addEventListener("click", recordLinkClick, true);
    return () => document.removeEventListener("click", recordLinkClick, true);
  }, []);

  const pathname = usePathname();
  useEffect(() => {
    reportRouteCommit(pathname);
  }, [pathname]);

  return null;
}
