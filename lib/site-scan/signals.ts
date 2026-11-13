/**
 * lib/site-scan/signals.ts — what a website says about itself, read from the pages the audit's
 * site reader fetched. Pure functions over PageSnapshots: no network, no model, deterministic,
 * so the same HTML always yields the same facts and the tests run on fixtures.
 *
 * Reuses the audit's HTML helpers (lib/ai-audit/site-checks.ts) rather than a second parser.
 */
import { asciiLower, decodeEntities, innerOf, tagsOf, visibleText, type PageSnapshot } from "@/lib/ai-audit/site-checks";
import type { SiteSignals } from "@/lib/site-scan/types";

export const TEXT_EXCERPT_MAX = 6_000;
export const MAX_LIST = 12;

const STOPWORDS = new Set(
  (
    "a an and are as at be by for from has have in into is it its of on or our that the their there these this to " +
    "was we were will with you your about all also any can get just more most new not one out over than then them they " +
    "up us was what when where which who why how us here now may each every very via per only own same so some such " +
    "do does did done being been both but if no nor off once off too under until while would could should shall " +
    "home page menu contact us read learn click view see call email phone info copyright rights reserved privacy policy terms " +
    "le la les de des du et en un une pour avec sur nous vous notre vos nos au aux est sont par plus pas"
  ).split(/\s+/),
);

const BOOKING_HOSTS: Array<[RegExp, string]> = [
  [/calendly\.com/i, "Calendly"],
  [/acuityscheduling\.com|squarespace\.com\/scheduling|app\.acuity/i, "Acuity"],
  [/housecallpro\.com/i, "Housecall Pro"],
  [/jobber\.com|clienthub\.app/i, "Jobber"],
  [/servicetitan\.com/i, "ServiceTitan"],
  [/booksy\.com/i, "Booksy"],
  [/vagaro\.com/i, "Vagaro"],
  [/fresha\.com/i, "Fresha"],
  [/mindbodyonline\.com/i, "Mindbody"],
  [/opentable\.com/i, "OpenTable"],
  [/resy\.com/i, "Resy"],
  [/square(?:up)?\.com\/appointments|squareup\.com\/book/i, "Square Appointments"],
  [/setmore\.com/i, "Setmore"],
  [/simplybook\.(?:me|it)/i, "SimplyBook"],
  [/zocdoc\.com/i, "Zocdoc"],
  [/janeapp\.com/i, "Jane"],
  [/cal\.com/i, "Cal.com"],
  [/hubspot\.com\/meetings|meetings\.hubspot/i, "HubSpot Meetings"],
  [/oasisai\.work\/(?:book|meet)/i, "OASIS booking"],
];

const CHAT_TOOLS: Array<[RegExp, string]> = [
  [/intercom/i, "Intercom"],
  [/crisp\.chat/i, "Crisp"],
  [/tawk\.to/i, "Tawk.to"],
  [/drift\.com|js\.driftt/i, "Drift"],
  [/tidio/i, "Tidio"],
  [/livechatinc|livechat\.com/i, "LiveChat"],
  [/zendesk|zdassets/i, "Zendesk"],
  [/hubspot.*conversations|js\.hs-scripts/i, "HubSpot chat"],
  [/podium\.com/i, "Podium"],
  [/birdeye/i, "Birdeye"],
  [/manychat/i, "ManyChat"],
  [/wa\.me\/|api\.whatsapp\.com/i, "WhatsApp"],
  [/m\.me\//i, "Messenger"],
];

const ANALYTICS: Array<[RegExp, string]> = [
  [/googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/, "Google Tag Manager"],
  [/gtag\(|googletagmanager\.com\/gtag|G-[A-Z0-9]{6,}/, "Google Analytics"],
  [/connect\.facebook\.net|fbq\(/, "Meta Pixel"],
  [/static\.hotjar\.com|hj\(/, "Hotjar"],
  [/clarity\.ms/, "Microsoft Clarity"],
  [/plausible\.io/, "Plausible"],
  [/cdn\.segment\.com/, "Segment"],
  [/snap\.licdn\.com/, "LinkedIn Insight"],
  [/analytics\.tiktok\.com/, "TikTok Pixel"],
];

const SOCIAL_HOSTS: Array<[RegExp, string]> = [
  [/^(?:www\.)?(?:facebook|fb)\.com\//i, "facebook"],
  [/^(?:www\.)?instagram\.com\//i, "instagram"],
  [/^(?:www\.)?linkedin\.com\//i, "linkedin"],
  [/^(?:www\.)?(?:twitter|x)\.com\//i, "x"],
  [/^(?:www\.)?tiktok\.com\//i, "tiktok"],
  [/^(?:www\.)?youtube\.com\/|^youtu\.be\//i, "youtube"],
  [/^(?:www\.)?pinterest\.(?:com|ca)\//i, "pinterest"],
  [/^(?:www\.)?yelp\.(?:com|ca)\//i, "yelp"],
  [/^(?:g\.page|maps\.app\.goo\.gl|www\.google\.com\/maps)/i, "google_maps"],
];

const CTA_RE =
  /\b(get a (?:free )?quote|request a quote|free (?:quote|estimate|consultation|assessment|audit)|book (?:now|online|a call|an appointment|a consultation)|schedule (?:a|an|your|now)|call (?:us )?now|contact us today|start (?:now|today|free)|get started|claim your|sign up|try (?:it )?free|order (?:now|online)|reserve (?:a table|now)|apply now|learn more|see pricing|view menu)\b/gi;

const PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const YEAR_RE = /(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-\u2013]\s*)?((?:19|20)\d{2})/i;
// A nav label that is only a heading ("Services", "Our products") names no service. Squarespace
// prefixes a dropdown's hidden label with "Folder:", which the link text picks up.
const NAV_FOLDER = /^folder:\s*/i;
/**
 * A page's own label, never the business's name: "Home page | Cuisina" (Magento's default title,
 * live scan 2026-11-13) is Cuisina, "Accueil - Fleuriste Lune" is Fleuriste Lune.
 */
const GENERIC_PAGE_LABEL = /^(?:home|home ?page|main page|welcome|accueil|page d'accueil|bienvenue|inicio|startseite|index|untitled|official (?:web)?site)$/i;
/**
 * A name with a page's greeting or label around it: "Welcome to Joe's Pizza" is Joe's Pizza, "Mandy
 * Management Home" (live scan 2026-11-13) is Mandy Management. A trailing label is taken off only
 * when two words are left, so "Sweet Home" stays a name.
 */
const LEADING_GREETING = /^(?:welcome to(?: the)?|bienvenue (?:chez|[aà]|sur)|willkommen (?:bei|im|in der)|bienvenido a|benvenuti (?:da|a))\s+/i;
const TRAILING_LABEL = /\s+(?:home ?page|home|accueil|startseite|official (?:web)?site)$/i;
export function tidyName(name: string): string {
  let out = name.trim().replace(LEADING_GREETING, "");
  const cut = out.replace(TRAILING_LABEL, "");
  if (cut !== out && cut.trim().split(/\s+/).length >= 2) out = cut;
  return out.trim() || name.trim();
}
const HEADING_LABEL = /^(?:our |all |view (?:all |our )?|see (?:all |our )?)?(?:services?|solutions?|treatments?|products?|programs?|classes?|lessons?|packages?|plans?|menu)$/i;
const SERVICE_WORDS = /\b(services?|solutions?|treatments?|repairs?|installation|cleaning|design|consulting|therapy|plans?|packages?|menu|products?|programs?|classes?|lessons?)\b/i;
const PRICING_RE = /\b(pricing|prices?|rates?|\$\s?\d{2,}|starting at|per (?:hour|month|session|visit)|packages?)\b/i;
const CA_REGIONS = "ontario|quebec|québec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|prince edward island|yukon|nunavut";
const LOCALITY_RE = new RegExp(
  `\\b(toronto|montreal|montréal|vancouver|calgary|edmonton|ottawa|gatineau|mississauga|brampton|hamilton|laval|longueuil|winnipeg|halifax|victoria|kitchener|waterloo|london|markham|vaughan|oakville|burlington|surrey|burnaby|richmond|kelowna|saskatoon|regina|quebec city|sherbrooke|trois-rivières|barrie|oshawa|windsor|kingston|guelph|${CA_REGIONS})\\b`,
  "gi",
);
const DATE_RE = /\b((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;

function loaded(p: PageSnapshot): boolean {
  return p.status >= 200 && p.status < 300 && !!p.html;
}

function attr(tag: { attrs: Record<string, string> }, name: string): string {
  return (tag.attrs[name] ?? "").trim();
}

function clean(s: string | null | undefined, max = 200): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return t ? t.slice(0, max) : null;
}

function uniq(list: string[], max = MAX_LIST): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const v = raw.trim();
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function metaContent(metas: Array<{ attrs: Record<string, string> }>, key: string): string | null {
  const m = metas.find((t) => {
    const n = (t.attrs.name ?? t.attrs.property ?? "").toLowerCase();
    return n === key;
  });
  return m ? clean(decodeEntities(attr(m, "content")), 400) : null;
}

/** Text nodes of one tag kind, decoded and trimmed. */
function textsOf(html: string, lower: string, name: string, max: number): string[] {
  const out: string[] = [];
  for (const t of tagsOf(html, name, lower)) {
    const inner = innerOf(html, t, name, lower, 4_000);
    if (inner === null) continue;
    const txt = clean(decodeEntities(visibleText(inner)), 160);
    if (txt) out.push(txt);
    if (out.length >= max) break;
  }
  return out;
}

function anchors(html: string, lower: string): Array<{ href: string; text: string }> {
  const out: Array<{ href: string; text: string }> = [];
  for (const a of tagsOf(html, "a", lower)) {
    const href = attr(a, "href");
    if (!href) continue;
    const inner = innerOf(html, a, "a", lower, 2_000);
    out.push({ href, text: clean(decodeEntities(visibleText(inner ?? "")), 80) ?? "" });
    if (out.length >= 1_500) break;
  }
  return out;
}

function schemaTypes(html: string, lower: string): { types: string[]; localities: string[]; names: string[]; services: string[] } {
  const types: string[] = [];
  const localities: string[] = [];
  const names: string[] = [];
  const services: string[] = [];
  for (const s of tagsOf(html, "script", lower)) {
    if (!/ld\+json/i.test(attr(s, "type"))) continue;
    const raw = innerOf(html, s, "script", lower, 60_000);
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    const walk = (node: unknown, depth: number) => {
      if (depth > 6 || !node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const n of node) walk(n, depth + 1);
        return;
      }
      const o = node as Record<string, unknown>;
      const t = o["@type"];
      if (typeof t === "string") types.push(t);
      else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") types.push(x);
      if (typeof o.name === "string" && (typeof t === "string" ? /Organization|Business|Store|Service|Dentist|Restaurant|Salon|Plumber|Electrician|Contractor|Physician|Clinic/i.test(t) : false)) names.push(o.name);
      if (typeof o.addressLocality === "string") localities.push(o.addressLocality);
      if (typeof o.addressRegion === "string") localities.push(o.addressRegion);
      if (typeof t === "string" && /Service|Offer|Product|MenuItem/i.test(t) && typeof o.name === "string") services.push(o.name);
      for (const v of Object.values(o)) walk(v, depth + 1);
    };
    walk(parsed, 0);
  }
  return { types: uniq(types), localities: uniq(localities, 6), names: uniq(names, 3), services: uniq(services) };
}

function keywordsOf(text: string): Array<{ term: string; count: number }> {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().split(/[^a-zà-ÿ0-9'&-]+/)) {
    const t = w.replace(/^['-]+|['-]+$/g, "");
    if (t.length < 4 || t.length > 24 || STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 25)
    .map(([term, count]) => ({ term, count }));
}

/**
 * Read the signals from the pages the site reader loaded. `pages[0]` is the home page. Pages
 * that did not load are ignored (a gap, never a "no").
 */
export function extractSignals(input: { domain: string; pages: readonly PageSnapshot[] }): SiteSignals {
  const pages = input.pages.filter(loaded);
  const home = pages[0];
  const empty: SiteSignals = {
    title: null, meta_description: null, h1: [], og_site_name: null, language: null,
    business_name: input.domain, tagline: null, phones: [], emails: [], localities: [], services: [],
    pricing_mentioned: false, booking_tools: [], forms_count: 0, chat_tools: [], analytics: [], socials: {},
    schema_types: [], copyright_year: null, blog: { found: false, latest_date: null }, images_total: 0,
    images_missing_alt: 0, internal_links: 0, external_links: 0, cta_phrases: [], keywords: [], word_count: 0, text_excerpt: "",
  };
  if (!home) return empty;

  const siteHost = hostOf(home.finalUrl) ?? input.domain;
  const homeLower = asciiLower(home.html);
  const metas = tagsOf(home.html, "meta", homeLower);
  const title = textsOf(home.html, homeLower, "title", 1)[0] ?? null;
  const metaDescription = metaContent(metas, "description");
  const ogSiteName = metaContent(metas, "og:site_name");
  const htmlTag = tagsOf(home.html, "html", homeLower)[0];
  const language = htmlTag ? clean(attr(htmlTag, "lang"), 12) : null;

  const h1: string[] = [];
  const phones: string[] = [];
  const emails: string[] = [];
  const localities: string[] = [];
  const services: string[] = [];
  const booking: string[] = [];
  const chat: string[] = [];
  const analytics: string[] = [];
  const socials: Record<string, string> = {};
  const schema: string[] = [];
  const schemaNames: string[] = [];
  const ctas: string[] = [];
  const blogDates: string[] = [];
  let pricing = false;
  let forms = 0;
  let imagesTotal = 0;
  let imagesMissingAlt = 0;
  let internal = 0;
  let external = 0;
  let copyrightYear: number | null = null;
  let blogFound = false;
  let allText = "";

  for (const page of pages) {
    const lower = asciiLower(page.html);
    const text = decodeEntities(visibleText(page.html));
    allText += (allText ? "\n" : "") + text;
    h1.push(...textsOf(page.html, lower, "h1", 3));
    for (const m of text.match(PHONE_RE) ?? []) phones.push(m.replace(/\s+/g, " ").trim());
    for (const m of text.match(EMAIL_RE) ?? []) emails.push(m.toLowerCase());
    for (const m of text.match(LOCALITY_RE) ?? []) localities.push(m);
    if (PRICING_RE.test(text)) pricing = true;
    for (const m of text.match(CTA_RE) ?? []) ctas.push(m.toLowerCase());
    const y = page.html.match(YEAR_RE);
    if (y) copyrightYear = Math.max(copyrightYear ?? 0, Number(y[1]));
    forms += tagsOf(page.html, "form", lower).filter((f) => !/search/i.test(attr(f, "role") + attr(f, "id") + attr(f, "class"))).length;
    for (const img of tagsOf(page.html, "img", lower)) {
      imagesTotal += 1;
      if (!attr(img, "alt")) imagesMissingAlt += 1;
    }
    for (const [re, name] of CHAT_TOOLS) if (re.test(page.html)) chat.push(name);
    for (const [re, name] of ANALYTICS) if (re.test(page.html)) analytics.push(name);
    for (const [re, name] of BOOKING_HOSTS) if (re.test(page.html)) booking.push(name);
    const sch = schemaTypes(page.html, lower);
    schema.push(...sch.types);
    schemaNames.push(...sch.names);
    localities.push(...sch.localities);
    services.push(...sch.services);
    for (const a of anchors(page.html, lower)) {
      const href = a.href;
      if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
      let url: URL | null = null;
      try {
        url = new URL(href, page.finalUrl);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(url.protocol)) continue;
      const host = url.host.toLowerCase().replace(/^www\./, "");
      if (host === siteHost || host.endsWith(`.${siteHost}`)) {
        internal += 1;
        if (/\/(blog|news|articles?|insights|journal|resources)(\/|$)/i.test(url.pathname)) blogFound = true;
        const label = a.text.replace(NAV_FOLDER, "");
        if (label && label.length <= 40 && !HEADING_LABEL.test(label) && SERVICE_WORDS.test(label + " " + url.pathname)) services.push(label);
      } else {
        external += 1;
        const path = `${host}${url.pathname}`;
        for (const [re, key] of SOCIAL_HOSTS) if (re.test(path) && !socials[key]) socials[key] = `${url.protocol}//${url.host}${url.pathname}`.slice(0, 200);
        for (const [re, name] of BOOKING_HOSTS) if (re.test(url.href)) booking.push(name);
      }
    }
    if (/\/(blog|news|articles?|insights|journal)(\/|$)/i.test(page.finalUrl)) {
      blogFound = true;
      for (const m of page.html.match(DATE_RE) ?? []) blogDates.push(m);
    }
  }

  const separator = /\s[|\-\u2013\u2014:·\u2022]\s/;
  const named = (s: string | null | undefined): string | null => (s && !GENERIC_PAGE_LABEL.test(s.trim()) ? s : null);
  const nameFromTitle = title ? title.split(separator).map((s) => s.trim()).filter((s) => !!named(s)) : [];
  // og:site_name is often the whole page title ("Harper's Garden Centre | Hamilton, Ontario"): the
  // name is what comes before a pipe or dot. Not a hyphen: "Smith - Jones Law" is one name.
  const ogName = named(ogSiteName ? ogSiteName.split(/\s[|\u00b7\u2022]\s/)[0].trim() || null : null);
  const chosenName = ogName ?? schemaNames.find((n) => !!named(n)) ?? (nameFromTitle.length > 1 ? nameFromTitle[nameFromTitle.length - 1].length <= 40 && /inc|ltd|llc|co\.|company|group|clinic|studio|salon|services|plumbing|dental/i.test(nameFromTitle[nameFromTitle.length - 1]) ? nameFromTitle[nameFromTitle.length - 1] : nameFromTitle[0] : nameFromTitle[0]);
  const businessName = clean(chosenName ? tidyName(chosenName) : input.domain, 80) ?? input.domain;
  const tagline = clean(h1[0] ?? metaDescription ?? (nameFromTitle.length > 1 ? nameFromTitle.slice(1).join(" ") : null), 200);
  const words = allText.split(/\s+/).filter(Boolean);

  return {
    title,
    meta_description: metaDescription,
    h1: uniq(h1, 6),
    og_site_name: ogSiteName,
    language,
    business_name: businessName,
    tagline,
    phones: uniq(phones, 4),
    emails: uniq(emails, 4),
    localities: uniq(localities.map((l) => l.replace(/\b\w/g, (c) => c.toUpperCase())), 6),
    services: uniq(services, MAX_LIST),
    pricing_mentioned: pricing,
    booking_tools: uniq(booking, 4),
    forms_count: forms,
    chat_tools: uniq(chat, 4),
    analytics: uniq(analytics, 6),
    socials,
    schema_types: uniq(schema, 8),
    copyright_year: copyrightYear,
    blog: { found: blogFound, latest_date: blogDates.sort().at(-1) ?? null },
    images_total: imagesTotal,
    images_missing_alt: imagesMissingAlt,
    internal_links: internal,
    external_links: external,
    cta_phrases: uniq(ctas, 8),
    keywords: keywordsOf(allText),
    word_count: words.length,
    text_excerpt: allText.replace(/\s+/g, " ").slice(0, TEXT_EXCERPT_MAX),
  };
}
