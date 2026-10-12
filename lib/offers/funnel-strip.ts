/**
 * lib/offers/funnel-strip.ts - the seven-day funnel strip every Offer card
 * shows (R1, HANDOVER section 3). Only leads has real data today (form
 * submissions in the last 7 days, lib/offer-pages/store.ts:countRecentLeads).
 * The rest - views, video plays, booked, sent to community - have no
 * tracking yet (section 5 of the handover ships it): they render "-" with an
 * accessible label of "not tracked yet", NEVER a 0. A 0 would read as "zero
 * people did this," which is a false claim; "-" with the label reads as
 * "nobody has measured this yet."
 *
 * No em dash in the label or the glyph: "-" is a plain hyphen.
 */

export type FunnelMetricKey = "views" | "video_plays" | "leads" | "booked" | "community";

export const FUNNEL_METRICS: ReadonlyArray<{ key: FunnelMetricKey; label: string }> = [
  { key: "views", label: "Views" },
  { key: "video_plays", label: "Video plays" },
  { key: "leads", label: "Leads" },
  { key: "booked", label: "Booked" },
  { key: "community", label: "Sent to community" },
];

export const NOT_TRACKED_LABEL = "not tracked yet";
export const UNAVAILABLE_LABEL = "couldn't load";

/**
 * Why a cell has no number: the metric has never been tracked, or it is
 * tracked (leads) but this read failed. The two must not share a label: "not
 * tracked yet" on a failed leads read would hide an outage behind a feature
 * gap.
 */
export type FunnelGapReason = "untracked" | "unavailable";

/**
 * A funnel cell's text and, when the number could not be read or has never
 * been tracked, the accessible label to pair with it. `text` is what a sighted
 * user sees ("-", never "0"); `ariaLabel`, when present, is what a screen
 * reader says instead of the bare hyphen.
 */
export function funnelCell(
  value: number | null | undefined,
  reason: FunnelGapReason = "untracked",
): { text: string; ariaLabel?: string } {
  if (typeof value === "number" && Number.isFinite(value)) return { text: String(value) };
  return { text: "-", ariaLabel: reason === "unavailable" ? UNAVAILABLE_LABEL : NOT_TRACKED_LABEL };
}
