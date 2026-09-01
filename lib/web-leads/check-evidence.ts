/**
 * check-evidence.ts — the measured sentence behind every check on the battle
 * card.
 *
 * ═══ WHY (Adon, 2026-09-01) ═════════════════════════════════════════════════
 *
 * "You have to explain in detail why you're giving that score... pinpoint
 * things in the website that are showing that, so the reps could really
 * understand how you're getting the score. If it is just random numbers
 * you're generating, that's a problem of its own."
 *
 * The numbers were never random: every area score is arithmetic over named
 * checks, and every check is a boolean computed by the crawler from a
 * measured signal (services/leadgen/lib/quality-model.js -- its own rule:
 * "nothing here is a judgement call dressed as a measurement"). What the card
 * lacked was the JOIN: "Working on a phone: 30" never said WHAT the crawler
 * saw on this site. This module is that join. For a check code and the stored
 * signal blob it returns one sentence naming the measurement and the bar:
 *
 *   fast_ttfb  ->  "Server took 2,340 ms to send its first byte; under
 *                   800 ms earns the point."
 *   tel_link   ->  "0 tap-to-call links found in the page; one or more
 *                   earns the point."
 *
 * ═══ THE RULES ══════════════════════════════════════════════════════════════
 *
 * 1. THIS MODULE NEVER JUDGES. Pass/fail comes from the stored profile
 *    (`check.has`, computed at crawl time); these sentences only verbalize
 *    the stored measurement and name the bar. Re-evaluating here would let
 *    the sentence and the score disagree about one site mid-call.
 * 2. NEVER INVENT A MEASUREMENT. Every field is type-guarded; a signal the
 *    crawler did not record returns null and NO line renders -- same
 *    discipline as evidence.ts. A measured zero IS a measurement and does
 *    render ("0 tap-to-call links found").
 * 3. HAND-WRITTEN, WITH MEASURED NUMBERS INTERPOLATED. No generation, no em
 *    dashes, no jargon a rep cannot say to a plumber (pinned by test, same
 *    house rules as angles.ts / remedies.ts).
 * 4. THE NAMED BARS MIRROR quality-model.js IN JARVIS. That file is the one
 *    source of truth for thresholds; the literals here are display copy of
 *    it. If the model's bars ever move, this copy must move in the same
 *    change -- tests/web-leads-battlecard.test.ts pins today's bars so a
 *    silent drift fails loudly instead of lying quietly.
 */

type Signals = Record<string, unknown> | null | undefined;

const num = (s: Signals, key: string): number | null => {
  const v = s ? s[key] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const bool = (s: Signals, key: string): boolean | null => {
  const v = s ? s[key] : undefined;
  return typeof v === "boolean" ? v : null;
};
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtMs = (n: number) => `${fmtInt(n)} ms`;
const fmtSize = (n: number) => {
  if (n < 1024) return `${Math.round(n)} bytes`;
  if (n < 1024 * 1024) return `${fmtInt(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

type Line = (s: Signals) => string | null;

const LINES: Record<string, Line> = {
  // ── conversion ─────────────────────────────────────────────────────────
  tel_link: (s) => {
    const n = num(s, "telLinks");
    return n === null ? null : `${fmtInt(n)} tap-to-call ${plural(n, "link", "links")} found in the page; one or more earns the point.`;
  },
  phone_in_header: (s) => {
    const b = bool(s, "phoneInHeader");
    return b === null ? null : b ? "A phone number sits in the page header." : "No phone number in the page header, the first place a visitor looks.";
  },
  contact_form: (s) => {
    const n = num(s, "formCount");
    return n === null ? null : `${fmtInt(n)} contact ${plural(n, "form", "forms")} found in the page; one or more earns the point.`;
  },
  short_form: (s) => {
    const forms = num(s, "formCount");
    const fields = num(s, "maxFormFields");
    if (forms === 0) return "No form on the page to measure.";
    if (fields === null) return null;
    return `The longest form asks for ${fmtInt(fields)} ${plural(fields, "field", "fields")}; six or fewer earns the point.`;
  },
  cta_present: (s) => {
    const n = num(s, "ctaCount");
    return n === null ? null : `${fmtInt(n)} call-to-action ${plural(n, "phrase", "phrases")} found in the copy; one or more earns the point.`;
  },
  cta_above_fold: (s) => {
    const b = bool(s, "ctaAboveFold");
    return b === null ? null : b ? "A call to action appears before any scrolling." : "Nothing asks for the business before the visitor has to scroll.";
  },
  booking: (s) => {
    const b = bool(s, "hasBooking");
    return b === null ? null : b ? "Online booking or scheduling found." : "No online booking or scheduling anywhere on the page.";
  },
  email_route: (s) => {
    const mail = num(s, "mailtoLinks");
    const forms = num(s, "formCount");
    if (mail === null && forms === null) return null;
    const parts: string[] = [];
    if (mail !== null) parts.push(`${fmtInt(mail)} email ${plural(mail, "link", "links")}`);
    if (forms !== null) parts.push(`${fmtInt(forms)} ${plural(forms, "form", "forms")}`);
    return `${parts.join(" and ")} found; either route earns the point.`;
  },
  chat: (s) => {
    const b = bool(s, "hasChat");
    return b === null ? null : b ? "A chat widget is installed." : "No live chat or messaging on the page.";
  },
  multi_route: (s) => {
    const tel = num(s, "telLinks");
    const forms = num(s, "formCount");
    const mail = num(s, "mailtoLinks");
    const booking = bool(s, "hasBooking");
    if (tel === null || forms === null || mail === null || booking === null) return null;
    const k = [tel > 0, forms > 0, mail > 0, booking].filter(Boolean).length;
    return `${k} of 4 contact routes present (call, form, email, booking); two or more earns the point.`;
  },

  // ── trust ──────────────────────────────────────────────────────────────
  testimonials: (s) => {
    const b = bool(s, "hasTestimonials");
    return b === null ? null : b ? "Customer quotes found on the page." : "No customer quotes anywhere on the page.";
  },
  review_platform: (s) => {
    const b = bool(s, "hasReviewWidget");
    return b === null ? null : b ? "Reviews from Google or a review site are shown." : "No reviews from Google or any review site are shown.";
  },
  credentials: (s) => {
    const b = bool(s, "hasCredentials");
    return b === null ? null : b ? "Licence, certification or insurance wording found." : "No licence, certification or insurance wording anywhere in the copy.";
  },
  real_photos: (s) => {
    const n = num(s, "contentImages");
    const stock = bool(s, "stockOnly");
    // BOTH measurements or nothing: this check is "enough photos AND they are
    // real". A legacy blob carrying the count but not the stock verdict could
    // otherwise render "8 photos found; four or more earns the point" beside
    // a stored FAIL, and the evidence would contradict the score it exists to
    // explain. (Codex review, 2026-09-01.)
    if (n === null || stock === null) return null;
    const stockNote = stock ? ", and every one came from a stock library" : "";
    return `${fmtInt(n)} content ${plural(n, "photo", "photos")} found${stockNote}; four or more real photos earns the point.`;
  },
  address: (s) => {
    const b = bool(s, "hasPostalAddress");
    return b === null ? null : b ? "A postal address is on the page." : "No postal address anywhere on the page.";
  },
  map: (s) => {
    const b = bool(s, "hasMap");
    return b === null ? null : b ? "A map of where they are is embedded." : "No map showing where the business is.";
  },
  years_trading: (s) => {
    const b = bool(s, "hasYearsInBusiness");
    return b === null ? null : b ? "The page says how long they have been in business." : "Nothing says how long they have been in business.";
  },
  guarantee: (s) => {
    const b = bool(s, "hasGuarantee");
    return b === null ? null : b ? "A guarantee or warranty is mentioned." : "No guarantee or warranty mentioned anywhere.";
  },
  social_proof: (s) => {
    const n = num(s, "socialLinks");
    return n === null ? null : `${fmtInt(n)} ${plural(n, "link", "links")} to social profiles found; one or more earns the point.`;
  },

  // ── design ─────────────────────────────────────────────────────────────
  modern_layout: (s) => {
    const b = bool(s, "usesFlexOrGrid");
    return b === null ? null : b ? "Built on a modern layout engine." : "No modern layout engine in the stylesheet; this is how sites were built over a decade ago.";
  },
  web_fonts: (s) => {
    const b = bool(s, "hasWebFonts");
    return b === null ? null : b ? "Chosen typography is loaded." : "No chosen typography; the site renders in browser-default fonts.";
  },
  not_default_tpl: (s) => {
    const b = bool(s, "looksDefaultTemplate");
    return b === null ? null : b ? "The page reads as an unmodified stock template." : "The page does not read as a stock template.";
  },
  image_rich: (s) => {
    const n = num(s, "contentImages");
    return n === null ? null : `${fmtInt(n)} content ${plural(n, "image", "images")} on the page; six or more earns the point.`;
  },
  no_dated_markup: (s) => {
    const tags = num(s, "deprecatedTagCount");
    const tables = num(s, "layoutTables");
    if (tags === null && tables === null) return null;
    const parts: string[] = [];
    if (tags !== null) parts.push(`${fmtInt(tags)} retired ${plural(tags, "tag", "tags")}`);
    if (tables !== null) parts.push(`${fmtInt(tables)} layout ${plural(tables, "table", "tables")}`);
    return `${parts.join(" and ")} found in the page source; none of either earns the point.`;
  },
  consistent_brand: (s) => {
    const logo = bool(s, "hasLogo");
    const colors = num(s, "distinctColors");
    if (logo === null && colors === null) return null;
    const parts: string[] = [];
    if (logo !== null) parts.push(logo ? "a logo is present" : "no logo found");
    if (colors !== null) parts.push(`${fmtInt(colors)} distinct brand ${plural(colors, "colour", "colours")} detected`);
    const joined = parts.join(" and ");
    return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}; a logo plus two colours earns the point.`;
  },
  favicon: (s) => {
    const b = bool(s, "hasFavicon");
    return b === null ? null : b ? "A browser-tab icon is set." : "No browser-tab icon; the tab shows a blank page symbol.";
  },
  no_builder_badge: (s) => {
    const b = bool(s, "builderBadge");
    return b === null ? null : b ? "A free website-builder badge is still on the page." : "No website-builder badge on the page.";
  },

  // ── mobile ─────────────────────────────────────────────────────────────
  viewport: (s) => {
    const b = bool(s, "hasViewportMeta");
    return b === null ? null : b ? "The page tells phones how to display it." : "Nothing in the page source tells a phone how to display it, so phones show the desktop page shrunken.";
  },
  responsive_css: (s) => {
    const mq = bool(s, "hasMediaQueries");
    const fw = bool(s, "hasResponsiveFramework");
    if (mq === null && fw === null) return null;
    if (mq || fw) return "The layout has rules for adapting to a phone screen.";
    return "No small-screen layout rules and no responsive framework found; the layout cannot adapt to a phone.";
  },
  no_fixed_width: (s) => {
    const b = bool(s, "hasFixedWidthBody");
    return b === null ? null : b ? "The page body is locked to a fixed desktop width." : "The page body is not locked to a desktop width.";
  },
  tap_targets: (s) => {
    const tel = num(s, "telLinks");
    const nav = bool(s, "hasMobileNav");
    if (tel === null && nav === null) return null;
    const hasTel = tel !== null && tel > 0;
    if (hasTel || nav) return "The phone number or menu is built to be tapped.";
    return "Neither the phone number nor the menu is built for a fingertip.";
  },
  no_flash: (s) => {
    const b = bool(s, "hasFlash");
    return b === null ? null : b ? "Flash content found, which no modern phone can run at all." : "Nothing on the page that phones cannot run.";
  },

  // ── content ────────────────────────────────────────────────────────────
  substantial: (s) => {
    const n = num(s, "wordCount");
    return n === null ? null : `${fmtInt(n)} ${plural(n, "word", "words")} of copy on the homepage; 300 or more earns the point.`;
  },
  service_detail: (s) => {
    const mentions = num(s, "serviceMentions");
    const pages = num(s, "internalPages");
    if (mentions === null && pages === null) return null;
    const parts: string[] = [];
    if (mentions !== null) parts.push(`${fmtInt(mentions)} ${plural(mentions, "mention", "mentions")} of what they do`);
    if (pages !== null) parts.push(`${fmtInt(pages)} internal ${plural(pages, "page", "pages")}`);
    return `${parts.join(" and ")} found; three mentions or four pages earns the point.`;
  },
  headings: (s) => {
    const n = num(s, "headingCount");
    return n === null ? null : `${fmtInt(n)} ${plural(n, "heading", "headings")} structuring the page; three or more earns the point.`;
  },
  service_area: (s) => {
    const b = bool(s, "mentionsServiceArea");
    return b === null ? null : b ? "The page says what area they serve." : "Nothing says what area they serve.";
  },
  pricing_signal: (s) => {
    const b = bool(s, "mentionsPricing");
    return b === null ? null : b ? "Price or quoting is mentioned." : "No mention of price or how to get a quote.";
  },
  fresh: (s) => {
    const b = bool(s, "copyrightFresh");
    return b === null ? null : b ? "The copyright year is current." : "The copyright year is out of date, which tells a visitor nobody is maintaining the site.";
  },

  // ── performance ────────────────────────────────────────────────────────
  fast_ttfb: (s) => {
    const n = num(s, "ttfbMs");
    return n === null || n <= 0 ? null : `Server took ${fmtMs(n)} to send its first byte; under 800 ms earns the point.`;
  },
  lean_html: (s) => {
    const n = num(s, "bytes");
    return n === null || n <= 0 ? null : `The page weighs ${fmtSize(n)}; under 500 KB earns the point.`;
  },
  few_blocking: (s) => {
    const n = num(s, "blockingScripts");
    return n === null ? null : `${fmtInt(n)} ${plural(n, "script holds", "scripts hold")} up first paint; five or fewer earns the point.`;
  },
  https: (s) => {
    const b = bool(s, "isHttps");
    return b === null ? null : b ? "Served over a secure connection." : "Served over a plain connection, so browsers mark the site not secure.";
  },

  // ── discoverability ────────────────────────────────────────────────────
  title: (s) => {
    const b = bool(s, "hasTitle");
    return b === null ? null : b ? "The page has a title for search results." : "The page has no title, so search results show the bare address.";
  },
  meta_desc: (s) => {
    const b = bool(s, "hasMetaDescription");
    return b === null ? null : b ? "A search-result description is set." : "No search-result description, so Google writes its own.";
  },
  local_schema: (s) => {
    const b = bool(s, "hasLocalBusinessSchema");
    return b === null ? null : b ? "Structured business data for search engines is present." : "No structured business data, so search engines have to guess what this business is.";
  },
  og_tags: (s) => {
    const b = bool(s, "hasOgTags");
    return b === null ? null : b ? "Shared links preview properly." : "No preview tags, so the link looks broken when shared in a message.";
  },
  h1: (s) => {
    const n = num(s, "h1Count");
    return n === null ? null : `${fmtInt(n)} main ${plural(n, "heading", "headings")} on the page; one or more earns the point.`;
  },
  analytics: (s) => {
    const b = bool(s, "hasAnalytics");
    return b === null ? null : b ? "Analytics is installed." : "No analytics installed, so nobody can measure whether the site works.";
  },
  sitemap: (s) => {
    const b = bool(s, "hasSitemapRef");
    return b === null ? null : b ? "A sitemap is referenced for search engines." : "No sitemap referenced for search engines.";
  },
};

/** Every check code this module can explain — exported so tests can pin
 *  coverage against the remedy table. */
export const EXPLAINED_CODES = Object.keys(LINES);

/**
 * The measured sentence for one check on one site, or null when the crawl did
 * not record what the sentence would need. Null means "render nothing", never
 * "render a guess".
 */
export function checkEvidenceFor(code: string, signals: Signals): string | null {
  const line = LINES[code];
  if (!line) return null;
  try {
    return line(signals);
  } catch {
    // A malformed blob must never take the card down mid-call; the sentence
    // simply does not render.
    return null;
  }
}

const checkEvidenceModule = { EXPLAINED_CODES, checkEvidenceFor };
export default checkEvidenceModule;
