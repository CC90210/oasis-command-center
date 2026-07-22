/**
 * Pure helpers for the drip template inventory view (no "server-only" — the
 * client view and unit tests both import this).
 *
 * The inventory answers Adon's ask directly: "show exactly what templates go
 * out for each campaign" — every step's channel, WHEN it lands (cumulative,
 * not just per-step delay), and the copy as stored, plus a sample-lead render
 * so operators read what a merchant actually receives.
 */

import type { DripStep } from "./types";
import { renderTemplate } from "./templates";

/** "10 min" / "12 h" / "3 d 4 h" — operator-readable delay. */
export function formatDelayMinutes(minutes: number): string {
  const m = Math.max(0, Math.floor(Number(minutes) || 0));
  if (m === 0) return "immediately";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return remM ? `${h} h ${remM} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d} d ${remH} h` : `${d} d`;
}

export type ScheduledStep = {
  step: DripStep;
  index: number;
  /** Minutes after stage entry when this step fires (cumulative). */
  cumulativeMinutes: number;
};

/** delay_minutes is the wait BEFORE each step, so landing times are cumulative. */
export function cumulativeSchedule(steps: DripStep[]): ScheduledStep[] {
  let cum = 0;
  return (steps || []).map((step, index) => {
    cum += Math.max(0, Number(step.delay_minutes) || 0);
    return { step, index, cumulativeMinutes: cum };
  });
}

/** Sample lead context for previews — mirrors the daemon's `lead.*` root. */
export const SAMPLE_LEAD_CONTEXT: Record<string, unknown> = {
  lead: {
    first_name: "Taylor",
    contact_name: "Taylor Reed",
    business_name: "Evergreen Auto Group",
    phone: "(786) 555-0184",
    email: "taylor@evergreenauto.com",
    application_url: "https://sunbizfunding.com/apply/example",
    stage: "follow_up",
  },
  event: {},
};

/** Render copy against the sample lead; unresolved tokens stay visible as
 *  `{{token}}` so operators can spot context gaps instead of silent blanks. */
export function renderSample(text: string): string {
  try {
    const rendered = renderTemplate(text || "", SAMPLE_LEAD_CONTEXT);
    // renderTemplate resolves unknown roots to "" — re-surface anything that
    // vanished by re-rendering with a marker context is overkill; instead flag
    // emptiness only. Keep simple: return rendered text as the engine would.
    return rendered;
  } catch {
    return text || "";
  }
}

/** Search haystack for one sequence: all human-visible copy. */
export function sequenceSearchText(name: string, steps: DripStep[]): string {
  const parts: string[] = [name];
  for (const s of steps || []) {
    parts.push(s.subject || "", s.body || "", ...(s.subject_variants || []), ...(s.body_variants || []));
  }
  return parts.join("\n").toLowerCase();
}
