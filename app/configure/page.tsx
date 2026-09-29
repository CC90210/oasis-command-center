import { notFound } from "next/navigation";

/**
 * /configure — retired 2026-09-29 (OASIS OS plan, F0 containment).
 *
 * It was the public agent configurator: a visitor answered a few questions and
 * got an install one-liner that cloned CC90210/CEO-Agent, which went private
 * that day, so every command it produced failed for the public. The OS plan
 * cuts the developer funnel (wrong buyer), so the page now answers 404 for
 * everyone and is off middleware's public list and the full-bleed layout list.
 *
 * Pinned by tests/f0-containment.test.ts.
 */
export default function RetiredConfigurePage(): never {
  notFound();
}
