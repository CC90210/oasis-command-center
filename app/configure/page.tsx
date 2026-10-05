import { notFound } from "next/navigation";

/**
 * /configure — retired 2026-09-29 (OASIS OS plan, F0 containment).
 *
 * It was the public agent configurator: a visitor answered a few questions and
 * got an install one-liner that cloned CC90210/CEO-Agent, which went private
 * that day, so every command it produced failed for the public. The OS plan
 * cuts the developer funnel (wrong buyer), so the page now calls notFound() and
 * is off middleware's public list and the full-bleed layout list. Off the public
 * list means a signed-out visitor is sent to /login first, like any other path
 * that is not public, and meets the 404 after signing in.
 *
 * Pinned by tests/f0-containment.test.ts.
 */
export default function RetiredConfigurePage(): never {
  notFound();
}
