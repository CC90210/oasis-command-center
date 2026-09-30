import { notFound } from "next/navigation";

/**
 * /start — retired 2026-09-29 (OASIS OS plan, F0 containment).
 *
 * It was the entry-path chooser (build an agent / sign in / download), the
 * front door of the developer install funnel: /configure generated a one-liner
 * that cloned CC90210/CEO-Agent, which went private that day. The OS plan cuts
 * the funnel (wrong buyer), so the page now calls notFound() and is off
 * middleware's public list, the marketing registry, the footer and the sitemap.
 * Off the public list means a signed-out visitor is sent to /login first, like
 * any other path that is not public, and meets the 404 after signing in.
 * /welcome and /command-centre-explained 308 to "/" instead (next.config.js).
 *
 * Pinned by tests/f0-containment.test.ts.
 */
export default function RetiredStartPage(): never {
  notFound();
}
