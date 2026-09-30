import { notFound } from "next/navigation";

/**
 * /templates - retired 2026-09-30 (OASIS OS plan, track T1).
 *
 * It was SunBiz's HTML email template library, whose buttons asked the SunBiz agents by name to draft variants and send them.
 *
 * SunBiz was retired on 2026-09-28 and these legacy pages were still reachable
 * by URL from every workspace, OASIS's clients included. The page now calls
 * notFound(), the same mechanism #479 used for /start, /configure and
 * /demo/sun. A signed-out visitor meets the login page first (the path is not
 * public), a signed-in one the 404.
 *
 * Pinned by tests/client-route-gating.test.ts; tests/os-redirects.test.ts
 * fails if anything in app/, components/ or lib/ links here again.
 */
export default function RetiredTemplatesPage(): never {
  notFound();
}
