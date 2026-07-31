import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "@/lib/marketing/routes";

/**
 * sitemap.xml — the public marketing surface only.
 *
 * Hand-listed rather than derived from MARKETING_PATHS, because the two
 * lists genuinely differ: MARKETING_PATHS contains "/home" (the rewrite
 * target, which must never be indexed) and this contains "/" (which is not
 * a route file at all). Deriving one from the other would be tidier and
 * wrong.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const pages: Array<{ path: string; priority: number; freq: "weekly" | "monthly" | "yearly" }> = [
    { path: "/", priority: 1, freq: "weekly" },
    { path: "/fleet", priority: 0.9, freq: "monthly" },
    { path: "/work", priority: 0.9, freq: "monthly" },
    { path: "/contact", priority: 0.8, freq: "monthly" },
    { path: "/about", priority: 0.7, freq: "monthly" },
    { path: "/start", priority: 0.5, freq: "monthly" },
    { path: "/privacy", priority: 0.3, freq: "yearly" },
    { path: "/terms", priority: 0.3, freq: "yearly" },
    { path: "/dmca", priority: 0.2, freq: "yearly" },
  ];

  return pages.map((p) => ({
    url: `${SITE_ORIGIN}${p.path}`,
    lastModified: now,
    changeFrequency: p.freq,
    priority: p.priority,
  }));
}
