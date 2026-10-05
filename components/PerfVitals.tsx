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
 */

import { useReportWebVitals } from "next/web-vitals";

const ENDPOINT = "/api/perf/vitals";

export function PerfVitals() {
  useReportWebVitals((metric) => {
    try {
      const body = JSON.stringify({
        name: metric.name,
        value: Math.round(metric.value * 1000) / 1000,
        rating: (metric as { rating?: string }).rating ?? null,
        // pathname only — location.search is deliberately excluded.
        path: window.location.pathname.slice(0, 100),
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, body);
      } else {
        fetch(ENDPOINT, {
          method: "POST",
          body,
          keepalive: true,
          headers: { "content-type": "application/json" },
        }).catch(() => {});
      }
    } catch {
      // fail-open
    }
  });
  return null;
}
