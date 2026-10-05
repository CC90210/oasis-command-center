import type { AuditResult } from "@/lib/web-leads/audit";

/** A synthetic scored audit. Labels are deliberately long so the harness finds
 *  the width floor rather than a comfortable average. */
export const AUDIT: AuditResult = {
  state: "scored",
  url: "https://example-fixture-one.test",
  measuredAt: "2026-08-19T14:02:00.000Z",
  composite: 34,
  dimensions: [
    { key: "performance", label: "Performance", score: 21, weight: 0.2, missing: [], checks: [
      { code: "lcp_under_2500", label: "Main content appears within 2.5 seconds", points: 14, has: false },
      { code: "img_lazy", label: "Images load only when scrolled into view", points: 6, has: false },
      { code: "gzip", label: "Server compresses what it sends", points: 5, has: true },
    ] },
    { key: "mobile", label: "Mobile", score: 30, weight: 0.2, missing: [], checks: [
      { code: "viewport_meta", label: "Page is built to fit a phone screen", points: 12, has: false },
      { code: "tap_targets", label: "Buttons are big enough to tap with a thumb", points: 8, has: false },
    ] },
    { key: "trust", label: "Trust", score: 40, weight: 0.15, missing: [], checks: [
      { code: "https", label: "Address bar shows the site is secure", points: 10, has: true },
    ] },
    { key: "content", label: "Content", score: 44, weight: 0.15, missing: [], checks: [
      { code: "hours_on_page", label: "Opening hours are written on the page", points: 7, has: false },
    ] },
    { key: "seo", label: "Findability", score: 38, weight: 0.15, missing: [], checks: [
      { code: "title_tag", label: "Page has a title search engines can read", points: 9, has: false },
    ] },
    { key: "conversion", label: "Turning visits into calls", score: 25, weight: 0.1, missing: [], checks: [
      { code: "click_to_call", label: "Phone number is tappable on a phone", points: 11, has: false },
    ] },
    { key: "accessibility", label: "Accessibility", score: 52, weight: 0.05, missing: [], checks: [
      { code: "alt_text", label: "Images describe themselves to screen readers", points: 4, has: false },
    ] },
  ],
};
