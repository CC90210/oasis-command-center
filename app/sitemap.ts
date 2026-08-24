import type { MetadataRoute } from "next";
import {
  ALL_MARKETING_PATHS,
  MARKETING_HOME_PATH,
  SITE_ORIGIN,
} from "@/lib/marketing/routes";

/**
 * sitemap.xml — the public marketing surface only.
 *
 * "/" NOT "/home". An anonymous "/" is REWRITTEN (not redirected) to /home, so
 * both URLs serve identical bytes. Only the apex belongs in the sitemap;
 * indexing both is duplicate content and splits whatever authority the apex has.
 *
 * ON DERIVING THE PATH LIST FROM THE REGISTRY. The original version of this file
 * hand-listed the paths and argued against deriving them, because
 * MARKETING_PATHS contains "/home" (must never be indexed) and the sitemap needs
 * "/" (not a route file at all) — "deriving one from the other would be tidier
 * and wrong". That objection is real but narrow: it is one substitution, and it
 * is now made explicit in `sitemapPaths()` and pinned by
 * tests/robots-tiers.test.ts. Deriving buys something the hand-list cannot — a
 * marketing page added to lib/marketing/routes.ts can no longer ship missing
 * from the sitemap, and a page removed can no longer linger in it. Both of those
 * failures are silent.
 *
 * 🚨 lastmod IS NOT BUILD TIME. The original used `lastModified: new Date()`,
 * which stamps every page with the deploy timestamp: a one-line CSS change would
 * tell every crawler that all nine pages just changed. Crawlers learn to
 * distrust a site that does that and start ignoring lastmod entirely, which is
 * worse than omitting it. These are explicit dates, and the test fails if a
 * route has no entry.
 *
 * PRIORITY AND FREQUENCY are carried over verbatim from the hand-written
 * version. They encode a real editorial judgement — /fleet and /work change and
 * matter more than /dmca — and flattening them would have thrown that away.
 */
type PageMeta = {
  priority: number;
  freq: "weekly" | "monthly" | "yearly";
  /** Explicit, never derived from the clock. Bump when the page actually changes. */
  lastmod: string;
};

const PAGES: Record<string, PageMeta> = {
  "/": { priority: 1, freq: "weekly", lastmod: "2026-08-14" },
  "/fleet": { priority: 0.9, freq: "monthly", lastmod: "2026-08-14" },
  "/work": { priority: 0.9, freq: "monthly", lastmod: "2026-08-14" },
  "/contact": { priority: 0.8, freq: "monthly", lastmod: "2026-08-14" },
  "/about": { priority: 0.7, freq: "monthly", lastmod: "2026-08-14" },
  "/start": { priority: 0.5, freq: "monthly", lastmod: "2026-08-14" },
  "/privacy": { priority: 0.3, freq: "yearly", lastmod: "2026-08-14" },
  "/terms": { priority: 0.3, freq: "yearly", lastmod: "2026-08-14" },
  "/dmca": { priority: 0.2, freq: "yearly", lastmod: "2026-08-14" },
};

/** Marketing paths as they should appear in the sitemap: "/home" collapses to "/". */
export function sitemapPaths(): string[] {
  return ALL_MARKETING_PATHS.map((p) => (p === MARKETING_HOME_PATH ? "/" : p));
}

export { PAGES };

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapPaths().map((path) => {
    const meta = PAGES[path];
    return {
      url: new URL(path, SITE_ORIGIN).toString(),
      lastModified: meta.lastmod,
      changeFrequency: meta.freq,
      priority: meta.priority,
    };
  });
}
