import { notFound } from "next/navigation";

/**
 * /demo/sun — retired 2026-09-29 (OASIS OS plan, F0 containment).
 *
 * It was a public SunBiz preview shell. SunBiz was retired on 2026-09-28, so
 * the page now answers 404 for everyone and is off middleware's public list.
 * Its companion /api/demo/sun, which set the demo-shell cookie and redirected
 * here, is deleted.
 *
 * Pinned by tests/f0-containment.test.ts.
 */
export default function RetiredSunDemoPage(): never {
  notFound();
}
