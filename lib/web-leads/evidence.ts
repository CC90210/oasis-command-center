/**
 * lib/web-leads/evidence.ts — the raw crawl, in plain language, for the rep who
 * gets challenged.
 *
 * WHY THIS EXISTS (design spec 2026-08-24, §4 "The evidence"): everything else
 * on the battle card is an interpretation. The score is derived, the dimension
 * names are rep-facing rewrites, the remedies are sales copy. All of that is
 * honest and none of it survives the sentence a prospect actually says, which
 * is "no, we redid the site last year." What survives that is the measurement:
 * *"No tel: link on the homepage. Page weight 4.2 MB. No viewport meta tag."*
 *
 * THREE RULES, all of them about not manufacturing confidence:
 *
 * 1. A SIGNAL WE DID NOT MEASURE IS NOT RENDERED. Not as "0", not as "—", not
 *    as "No". The crawler's signal blob predates several of these fields, so an
 *    older audit row genuinely lacks them, and printing "Tap-to-call links: 0"
 *    for a row that never looked is a fabricated finding -- the exact failure
 *    the whole feature is built around. Absent key, absent row.
 *
 * 2. EVERY VALUE IS A MEASUREMENT, NEVER A VERDICT. "Not found" is what the
 *    crawler saw. "Missing", "Broken" and "Bad" are conclusions, and a rep
 *    reading a conclusion off a screen states it as fact.
 *
 * 3. THE COPY IS HAND-WRITTEN AND FIXED. Same discipline as remedies.ts: no
 *    per-lead text is ever generated, here or anywhere else on this card.
 *
 * Signal names mirror JARVIS services/leadgen/lib/deep-signals.js exactly.
 * They are duplicated rather than imported for the same reason remedies.ts's
 * copy was: oasis and JARVIS are separate deployments with no shared module
 * graph. A key that disappears upstream simply stops rendering its row, which
 * is rule 1 doing its job rather than a crash.
 */

export type EvidenceRow = { label: string; value: string };
export type EvidenceGroup = { title: string; rows: EvidenceRow[] };

type Formatter = (raw: unknown) => string | null;

/** Present only when the crawler actually recorded a number. */
const count: Formatter = (raw) => (typeof raw === "number" && Number.isFinite(raw) ? String(raw) : null);

const found: Formatter = (raw) => (typeof raw === "boolean" ? (raw ? "Found" : "Not found") : null);

const yesNo: Formatter = (raw) => (typeof raw === "boolean" ? (raw ? "Yes" : "No") : null);

const ms: Formatter = (raw) =>
  typeof raw === "number" && Number.isFinite(raw) ? `${Math.round(raw).toLocaleString("en-US")} ms` : null;

/** Bytes as a rep would say them out loud. 4,412,882 is unreadable; 4.2 MB is
 *  a sentence. */
const size: Formatter = (raw) => {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  if (raw < 1024) return `${Math.round(raw)} bytes`;
  if (raw < 1024 * 1024) return `${Math.round(raw / 1024).toLocaleString("en-US")} KB`;
  return `${(raw / (1024 * 1024)).toFixed(1)} MB`;
};

const words: Formatter = (raw) =>
  typeof raw === "number" && Number.isFinite(raw) ? `${Math.round(raw).toLocaleString("en-US")} words` : null;

const httpStatus: Formatter = (raw) =>
  typeof raw === "number" && Number.isFinite(raw) ? String(Math.round(raw)) : null;

/** The one free-text signal. Length-capped because a pathological redirect
 *  chain can leave a URL long enough to break the layout a rep is reading. */
const url: Formatter = (raw) => {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const trimmed = raw.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
};

const GROUPS: { title: string; fields: { key: string; label: string; format: Formatter }[] }[] = [
  {
    title: "What we fetched",
    fields: [
      { key: "finalUrl", label: "Page we measured", format: url },
      { key: "status", label: "HTTP status it returned", format: httpStatus },
      { key: "isHttps", label: "Served over HTTPS", format: yesNo },
      { key: "ttfbMs", label: "Time to first byte", format: ms },
      { key: "totalMs", label: "Time to finish loading", format: ms },
      { key: "bytes", label: "Weight of the page", format: size },
      { key: "internalPages", label: "Other pages we could reach", format: count },
    ],
  },
  {
    title: "How a visitor gets in touch",
    fields: [
      { key: "telLinks", label: "Tap-to-call links on the page", format: count },
      { key: "phoneInHeader", label: "Phone number in the header", format: found },
      { key: "mailtoLinks", label: "Email links on the page", format: count },
      { key: "formCount", label: "Contact forms on the page", format: count },
      { key: "maxFormFields", label: "Fields in the longest form", format: count },
      { key: "ctaCount", label: "Call-to-action wording on the page", format: count },
      { key: "ctaAboveFold", label: "A call to action before scrolling", format: found },
      { key: "hasBooking", label: "Online booking", format: found },
      { key: "hasChat", label: "Chat widget", format: found },
    ],
  },
  {
    title: "What the page says about them",
    fields: [
      { key: "wordCount", label: "Words on the homepage", format: words },
      { key: "headingCount", label: "Headings", format: count },
      { key: "h1Count", label: "Top-level headings", format: count },
      { key: "serviceMentions", label: "Mentions of what they do", format: count },
      { key: "mentionsPricing", label: "Any mention of price", format: found },
      { key: "mentionsServiceArea", label: "Any mention of the area they serve", format: found },
      { key: "hasTestimonials", label: "Customer quotes", format: found },
      { key: "hasReviewWidget", label: "Reviews shown on the site", format: found },
      { key: "hasCredentials", label: "Licence or insurance wording", format: found },
      { key: "hasPostalAddress", label: "A postal address", format: found },
      { key: "copyrightFresh", label: "Copyright year within the last year", format: yesNo },
    ],
  },
  {
    title: "How it behaves on a phone",
    fields: [
      { key: "hasViewportMeta", label: "Viewport meta tag", format: found },
      { key: "hasMediaQueries", label: "Layout rules for small screens", format: found },
      { key: "hasResponsiveFramework", label: "A responsive layout framework", format: found },
      { key: "hasFixedWidthBody", label: "A fixed-width page body", format: found },
      { key: "hasMobileNav", label: "A menu built for a phone", format: found },
      { key: "hasFlash", label: "Flash content", format: found },
    ],
  },
  {
    title: "How it is built",
    fields: [
      { key: "blockingScripts", label: "Scripts that hold up first paint", format: count },
      { key: "deprecatedTagCount", label: "Retired HTML tags still in use", format: count },
      { key: "layoutTables", label: "Tables used for layout", format: count },
      { key: "usesFlexOrGrid", label: "Modern layout (flex or grid)", format: found },
      { key: "hasWebFonts", label: "Web fonts", format: found },
      { key: "hasLogo", label: "A logo image", format: found },
      { key: "hasFavicon", label: "A browser-tab icon", format: found },
      { key: "builderBadge", label: "A site-builder badge left on the page", format: found },
      { key: "looksDefaultTemplate", label: "Reads as an unmodified template", format: yesNo },
      { key: "contentImages", label: "Content images", format: count },
      { key: "stockOnly", label: "Every image came from a stock library", format: yesNo },
    ],
  },
  {
    title: "How it gets found",
    fields: [
      { key: "hasTitle", label: "Page title", format: found },
      { key: "hasMetaDescription", label: "Search-result description", format: found },
      { key: "hasOgTags", label: "Preview tags for shared links", format: found },
      { key: "hasLocalBusinessSchema", label: "Local-business markup", format: found },
      { key: "hasAnalytics", label: "Any analytics installed", format: found },
      { key: "hasSitemapRef", label: "A sitemap reference", format: found },
      { key: "socialLinks", label: "Links to social profiles", format: count },
    ],
  },
];

/**
 * Turn a raw signal blob into rendered groups. A group with no measured fields
 * disappears entirely rather than rendering an empty heading.
 */
export function evidenceFrom(signals: Record<string, unknown> | null | undefined): EvidenceGroup[] {
  if (!signals) return [];
  const out: EvidenceGroup[] = [];
  for (const group of GROUPS) {
    const rows: EvidenceRow[] = [];
    for (const field of group.fields) {
      // Rule 1: a key the crawler never wrote is not a zero and is not a "No".
      if (!(field.key in signals)) continue;
      const value = field.format(signals[field.key]);
      if (value === null) continue;
      rows.push({ label: field.label, value });
    }
    if (rows.length > 0) out.push({ title: group.title, rows });
  }
  return out;
}

const evidenceModule = { evidenceFrom };
export default evidenceModule;
