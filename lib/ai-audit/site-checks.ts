/**
 * lib/ai-audit/site-checks.ts — what a business's own website shows, measured
 * by code from the pages the Command Center fetched (site-fetch.ts).
 *
 * Every check is a plain reading of the HTML: is there a mobile viewport, a
 * click-to-call link, a contact form, an online booking or chat tool, an
 * analytics tag; which platform the site is built on; what structured data
 * and social links it carries; whether it has a sitemap; how large the home
 * page is and how fast it answered (one measurement, from the Command Center).
 * A "yes" names the page and the bit of HTML that shows it. A "no" means none
 * of the pages read showed it, never that the business does not have it
 * elsewhere, and the brief says which pages were read. When the pages build
 * themselves in the browser (little text in the HTML), content checks say
 * "unknown" instead of "no": the browser check in phase 3 can read them.
 *
 * These results are the brief's Verified facts: our own measurement, dated.
 *
 * LINEAR TIME. The HTML is the client's (or anyone's who controls the site),
 * so nothing here may slow down on a hostile page: tags are found with
 * indexOf and read from a bounded slice, never with a pattern that can
 * backtrack across the whole page ("<a<a<a..." or an unclosed <script>).
 *
 * PURE: no I/O.
 */

export type PageSnapshot = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  html: string;
  bytes: number;
  /** Time to the full response, as measured by the Command Center. */
  ms: number;
  truncated: boolean;
};

export const CHECK_KEYS = [
  "https",
  "mobile_viewport",
  "title",
  "meta_description",
  "click_to_call",
  "email_link",
  "contact_form",
  "online_booking",
  "live_chat",
  "analytics",
  "platform",
  "structured_data",
  "social_links",
  "sitemap",
  "html_size",
  "response_time",
] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];
export type CheckStatus = "yes" | "no" | "unknown";

export type SiteCheck = {
  key: CheckKey;
  status: CheckStatus;
  /** One sentence, in plain words, of what was found. */
  detail: string;
  /** Tools or platforms named, when the check finds any. */
  found: string[];
  /** Where it was seen: the page, and a short piece of its HTML. */
  evidence: { url: string; excerpt: string } | null;
};

export const CHECK_TITLES: Readonly<Record<CheckKey, string>> = {
  https: "Secure address (HTTPS)",
  mobile_viewport: "Set up for phones",
  title: "Page title",
  meta_description: "Search description",
  click_to_call: "Tap-to-call phone link",
  email_link: "Email link",
  contact_form: "Contact form",
  online_booking: "Online booking",
  live_chat: "Live chat",
  analytics: "Visitor analytics",
  platform: "Website platform",
  structured_data: "Structured business data",
  social_links: "Social profiles linked",
  sitemap: "Sitemap",
  html_size: "Home page size",
  response_time: "Home page response time",
};

type Sig = readonly [name: string, re: RegExp];

const BOOKING: readonly Sig[] = [
  ["Calendly", /calendly\.com\//i],
  ["Acuity Scheduling", /acuityscheduling\.com|\bas\.me\//i],
  ["Square Appointments", /squareup\.com\/appointments|square\.site\/book|app\.squareup\.com\/appointments/i],
  ["Jane", /\.janeapp\.com/i],
  ["Vagaro", /vagaro\.com/i],
  ["Booksy", /booksy\.com/i],
  ["Fresha", /fresha\.com/i],
  ["Mindbody", /mindbodyonline\.com|\bmindbody\.io/i],
  ["SimplyBook.me", /simplybook\.(?:me|it|asia|cc)/i],
  ["Setmore", /setmore\.com/i],
  ["Cal.com", /\bcal\.com\//i],
  ["Google Calendar booking", /calendar\.app\.google\/|calendar\.google\.com\/calendar\/appointments/i],
  ["Housecall Pro", /housecallpro\.com/i],
  ["Jobber", /getjobber\.com/i],
  ["ServiceTitan", /servicetitan\.com/i],
  ["OpenTable", /opentable\.(?:com|ca)/i],
  ["Resy", /\bresy\.com/i],
  ["Tock", /exploretock\.com/i],
  ["HighLevel", /leadconnectorhq\.com|msgsndr\.com/i],
  ["HubSpot Meetings", /meetings\.hubspot\.com/i],
  ["Zoho Bookings", /zohobookings\.com|bookings\.zoho\./i],
  ["Microsoft Bookings", /outlook\.office365\.com\/owa\/calendar|bookings\.cloud\.microsoft/i],
  ["Schedulicity", /schedulicity\.com/i],
];

const CHAT: readonly Sig[] = [
  ["Intercom", /widget\.intercom\.io|js\.intercomcdn\.com/i],
  ["Drift", /js\.driftt\.com/i],
  ["Tidio", /code\.tidio\.co/i],
  ["LiveChat", /cdn\.livechatinc\.com/i],
  ["tawk.to", /embed\.tawk\.to/i],
  ["Crisp", /client\.crisp\.chat/i],
  ["Zendesk", /static\.zdassets\.com|\bzopim\.com/i],
  ["HubSpot chat", /js\.usemessages\.com/i],
  ["Facebook Messenger", /xfbml\.customerchat\.js|fb-customerchat/i],
  ["Olark", /static\.olark\.com/i],
  ["Freshchat", /wchat\.freshchat\.com/i],
  ["Smartsupp", /smartsuppchat\.com/i],
  ["Podium", /connect\.podium\.com/i],
  ["Birdeye", /widgets\.birdeye\.com/i],
  ["Chatra", /call\.chatra\.io/i],
  ["JivoChat", /code\.jivosite\.com/i],
  ["Gorgias", /config\.gorgias\.chat/i],
];

const ANALYTICS: readonly Sig[] = [
  ["Google Analytics", /googletagmanager\.com\/gtag\/js\?id=G-|google-analytics\.com\/(?:analytics|ga)\.js|gtag\(\s*['"]config['"]\s*,\s*['"](?:G|UA)-/i],
  ["Google Tag Manager", /googletagmanager\.com\/gtm\.js|\bGTM-[A-Z0-9]{4,}\b/],
  ["Meta Pixel", /connect\.facebook\.net\/[^"']*\/fbevents\.js|fbq\(\s*['"]init/i],
  ["Hotjar", /static\.hotjar\.com/i],
  ["Microsoft Clarity", /clarity\.ms\/tag/i],
  ["Plausible", /plausible\.io\/js/i],
  ["Matomo", /\bmatomo\.js|\bpiwik\.js/i],
  ["TikTok Pixel", /analytics\.tiktok\.com/i],
  ["LinkedIn Insight", /snap\.licdn\.com/i],
  ["HubSpot tracking", /js\.hs-scripts\.com|js\.hs-analytics\.net/i],
  ["Fathom", /cdn\.usefathom\.com/i],
  ["Segment", /cdn\.segment\.com\/analytics/i],
];

const PLATFORM: readonly Sig[] = [
  ["WordPress", /\/wp-content\/|\/wp-includes\//i],
  ["Shopify", /cdn\.shopify\.com|Shopify\.theme|\.myshopify\.com/i],
  ["Wix", /static\.wixstatic\.com|\bparastorage\.com/i],
  ["Squarespace", /static1\.squarespace\.com|squarespace-cdn\.com|<!-- This is Squarespace/i],
  ["Webflow", /data-wf-site=|\bwebflow\.js|assets\.website-files\.com/i],
  ["GoDaddy Website Builder", /img1\.wsimg\.com/i],
  ["Duda", /irp\.cdn-website\.com|\bdudaone\.com/i],
  ["Weebly", /\bweebly\.com|editmysite\.com/i],
  ["HubSpot CMS", /\bhs-sites\.com|hubspotusercontent/i],
  ["Framer", /framerusercontent\.com/i],
  ["BigCommerce", /cdn\d*\.bigcommerce\.com/i],
  ["Drupal", /\/sites\/default\/files\//i],
  ["Next.js", /\/_next\/static\//i],
];
/** What a <meta name="generator"> says, read from the tag itself. */
const GENERATORS: readonly Sig[] = [
  ["WordPress", /WordPress/i],
  ["Wix", /\bWix\b/i],
  ["Joomla", /Joomla/i],
  ["Drupal", /Drupal/i],
  ["Ghost", /\bGhost\b/i],
  ["Squarespace", /Squarespace/i],
  ["Webflow", /Webflow/i],
  ["Duda", /\bDuda\b/i],
];

/** A social profile, from a link's address (tested on the address alone). */
const SOCIAL_LINKS: readonly Sig[] = [
  ["Facebook", /^(?:https?:)?\/\/(?:www\.|m\.)?facebook\.com\/(?!sharer|share|dialog|plugins|tr\b)\S+/i],
  ["Instagram", /^(?:https?:)?\/\/(?:www\.)?instagram\.com\/\S+/i],
  ["LinkedIn", /^(?:https?:)?\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in)\/\S+/i],
  ["TikTok", /^(?:https?:)?\/\/(?:www\.)?tiktok\.com\/@\S+/i],
  ["YouTube", /^(?:https?:)?\/\/(?:www\.)?youtube\.com\/(?:@|channel\/|c\/|user\/)\S+/i],
  ["X (Twitter)", /^(?:https?:)?\/\/(?:www\.)?(?:twitter|x)\.com\/(?!share|intent)\S+/i],
  ["Pinterest", /^(?:https?:)?\/\/(?:www\.)?pinterest\.(?:com|ca)\/\S+/i],
  ["Google Business Profile", /^(?:https?:)?\/\/(?:g\.page|maps\.app\.goo\.gl|(?:www\.)?google\.[a-z.]+\/maps)/i],
  ["Yelp", /^(?:https?:)?\/\/(?:www\.)?yelp\.(?:com|ca)\/biz\/\S+/i],
];

const EMBEDDED_FORMS: readonly Sig[] = [
  ["Typeform", /typeform\.com\/to\/|embed\.typeform\.com/i],
  ["Jotform", /jotform\.com|jotfor\.ms/i],
  ["HubSpot form", /js\.hsforms\.net|\bhsforms\.com/i],
  ["Google Forms", /docs\.google\.com\/forms|forms\.gle\//i],
  ["Formspree", /formspree\.io/i],
  ["Wufoo", /wufoo\.com/i],
  ["Cognito Forms", /cognitoforms\.com/i],
  ["Tally", /tally\.so\//i],
];

// ---------------------------------------------------------------------------
// A linear tag scanner
// ---------------------------------------------------------------------------

const MAX_TAG = 4_000;
const MAX_TAGS = 3_000;
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

export type Tag = { index: number; end: number; raw: string; attrs: Record<string, string> };

/** Each opening `<name ...>` tag (at most MAX_TAGS), found with indexOf and read from a bounded slice. */
export function tagsOf(html: string, name: string, lower = html.toLowerCase()): Tag[] {
  const out: Tag[] = [];
  const open = `<${name}`;
  let pos = 0;
  while (out.length < MAX_TAGS) {
    const i = lower.indexOf(open, pos);
    if (i === -1) break;
    pos = i + open.length;
    const next = lower[pos];
    if (next !== undefined && !/[\s>/]/.test(next)) continue;
    const end = lower.indexOf(">", pos);
    if (end === -1) break;
    if (end - i > MAX_TAG) {
      // Every tag that starts before end - MAX_TAG also runs past the limit
      // (its first ">" is this one): skip them all, so each ">" is looked for once.
      pos = Math.max(pos, end - MAX_TAG);
      continue;
    }
    const raw = html.slice(i, end + 1);
    const attrs: Record<string, string> = {};
    for (const m of raw.matchAll(ATTR)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
    out.push({ index: i, end: end + 1, raw, attrs });
    pos = end + 1;
  }
  return out;
}

/** The text between a tag and its closing tag (at most `cap` characters), or null when it is not closed within that. */
export function innerOf(html: string, tag: Tag, name: string, lower = html.toLowerCase(), cap = 40_000): string | null {
  // Looked for only within `cap` characters, so many unclosed tags cost nothing extra.
  const close = lower.slice(tag.end, tag.end + cap + name.length + 2).indexOf(`</${name}`);
  if (close === -1 || close > cap) return null;
  return html.slice(tag.end, tag.end + close);
}

/** Every link on a page: its address and the words it shows. */
function linksOf(html: string, lower = html.toLowerCase()): Array<{ href: string; text: string; index: number }> {
  return tagsOf(html, "a", lower)
    .filter((t) => t.attrs.href)
    .map((t) => ({ href: decodeAttr(t.attrs.href.trim()), text: stripTags(innerOf(html, t, "a", lower, 400) ?? ""), index: t.index }));
}

function decodeAttr(v: string): string {
  return v.replace(/&amp;/g, "&").replace(/&#x2F;|&#47;/gi, "/");
}

/** Drop markup in one pass: no pattern, so an unclosed "<" costs nothing extra. */
function stripTags(html: string): string {
  let out = "";
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    const c = html[i];
    if (inTag) {
      if (c === ">") {
        inTag = false;
        out += " ";
      }
    } else if (c === "<") inTag = true;
    else out += c;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Remove whole <script>, <style> and <noscript> blocks, scanning forward only. */
function withoutBlocks(html: string, lower = html.toLowerCase()): string {
  let out = "";
  let pos = 0;
  // Where each kind of block next starts; looked up again only once passed, so the page is scanned once per kind.
  const at: Record<string, number> = { script: -2, style: -2, noscript: -2 };
  for (;;) {
    let next = -1;
    let name = "";
    for (const n of ["script", "style", "noscript"]) {
      if (at[n] !== -1 && at[n] < pos) at[n] = lower.indexOf(`<${n}`, pos);
      const i = at[n];
      if (i !== -1 && (next === -1 || i < next)) {
        next = i;
        name = n;
      }
    }
    if (next === -1) return out + html.slice(pos);
    out += html.slice(pos, next);
    const close = lower.indexOf(`</${name}`, next);
    if (close === -1) return out;
    const end = lower.indexOf(">", close);
    pos = end === -1 ? html.length : end + 1;
  }
}

/** A short, single-line piece of HTML around a match, for the evidence column. */
function excerptAt(html: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  return html
    .slice(start, Math.min(html.length, index + Math.max(length, 0) + 80))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Every signature found on any page: names, in order, with the first place each was seen. */
function findAll(pages: readonly PageSnapshot[], sigs: readonly Sig[]): { found: string[]; evidence: SiteCheck["evidence"] } {
  const found: string[] = [];
  let evidence: SiteCheck["evidence"] = null;
  for (const [name, re] of sigs) {
    for (const p of pages) {
      const m = re.exec(p.html);
      if (!m) continue;
      found.push(name);
      if (!evidence) evidence = { url: p.finalUrl, excerpt: excerptAt(p.html, m.index, m[0].length) };
      break;
    }
  }
  return { found, evidence };
}

/** The text a visitor would read: no tags, scripts or styles. */
export function visibleText(html: string): string {
  return stripTags(withoutBlocks(html))
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** A page that builds itself in the browser: very little text in the HTML it was served. */
export function builtInBrowser(page: PageSnapshot): boolean {
  return visibleText(page.html).length < 200 && page.html.toLowerCase().includes("<script");
}

function metaContent(html: string, name: string, lower = html.toLowerCase()): { content: string; tag: Tag } | null {
  for (const t of tagsOf(html, "meta", lower)) {
    if ((t.attrs.name ?? "").toLowerCase() === name && (t.attrs.content ?? "").trim()) return { content: t.attrs.content.trim(), tag: t };
  }
  return null;
}

/** The first link, on any page, whose address passes `test`. */
function firstLink(pages: readonly PageSnapshot[], test: (href: string) => boolean): { page: PageSnapshot; href: string; index: number } | null {
  for (const page of pages) {
    const link = linksOf(page.html).find((l) => test(l.href));
    if (link) return { page, href: link.href, index: link.index };
  }
  return null;
}

/** Contact forms: a form with a field a person fills in, not a site search box. */
function contactForms(pages: readonly PageSnapshot[]): { found: string[]; evidence: SiteCheck["evidence"] } {
  for (const p of pages) {
    const lower = p.html.toLowerCase();
    for (const form of tagsOf(p.html, "form", lower).slice(0, 30)) {
      if (/search/i.test(form.raw)) continue;
      const inner = innerOf(p.html, form, "form", lower, 60_000);
      if (inner === null) continue;
      const innerLower = inner.toLowerCase();
      const fields = [...tagsOf(inner, "input", innerLower), ...tagsOf(inner, "textarea", innerLower), ...tagsOf(inner, "select", innerLower)];
      const meaningful = fields.filter((f) => !["hidden", "submit", "button", "search", "image", "reset"].includes((f.attrs.type ?? "").toLowerCase()));
      const person = meaningful.some((f) => f.raw.toLowerCase().startsWith("<textarea") || ["email", "tel"].includes((f.attrs.type ?? "").toLowerCase()) || /email|phone|tel|message|name|comment/i.test(f.attrs.name ?? ""));
      if (meaningful.length >= 2 && person) return { found: ["a form on the site"], evidence: { url: p.finalUrl, excerpt: excerptAt(p.html, form.index, form.raw.length) } };
    }
  }
  const embedded = findAll(pages, EMBEDDED_FORMS);
  return embedded.found.length ? embedded : { found: [], evidence: null };
}

/** Structured data (schema.org JSON-LD): the types it declares, LocalBusiness and the like. */
function structuredTypes(pages: readonly PageSnapshot[]): { types: string[]; evidence: SiteCheck["evidence"] } {
  const types = new Set<string>();
  let evidence: SiteCheck["evidence"] = null;
  const visit = (v: unknown, depth: number) => {
    if (depth > 6 || !v) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const t = o["@type"];
    for (const x of Array.isArray(t) ? t : [t]) if (typeof x === "string" && x.length < 60) types.add(x);
    if (o["@graph"]) visit(o["@graph"], depth + 1);
  };
  for (const p of pages) {
    const lower = p.html.toLowerCase();
    for (const t of tagsOf(p.html, "script", lower)) {
      if ((t.attrs.type ?? "").toLowerCase() !== "application/ld+json") continue;
      const body = innerOf(p.html, t, "script", lower, 40_000);
      if (body === null) continue;
      try {
        visit(JSON.parse(body), 0);
        if (!evidence) evidence = { url: p.finalUrl, excerpt: body.replace(/\s+/g, " ").trim().slice(0, 160) };
      } catch {
        // Broken JSON-LD is what the site serves; it counts as none.
      }
    }
  }
  return { types: [...types].slice(0, 12), evidence };
}

function kb(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

function yesNo(key: CheckKey, ok: boolean, detailYes: string, detailNo: string, found: string[], evidence: SiteCheck["evidence"], unknown = false): SiteCheck {
  if (!ok && unknown) return { key, status: "unknown", detail: `${detailNo.replace(/\.$/, "")}, but the pages build themselves in the browser, so this may be wrong.`, found: [], evidence: null };
  return { key, status: ok ? "yes" : "no", detail: ok ? detailYes : detailNo, found, evidence };
}

/**
 * Every check, from the home page (pages[0]) and the other pages read.
 * `https`: whether the site answered on HTTPS, and whether plain HTTP sends
 * visitors there (null when that was not tried). `sitemap`: from robots.txt
 * or /sitemap.xml, null when neither could be read.
 */
export function runSiteChecks(input: {
  pages: readonly PageSnapshot[];
  https: { served: boolean; httpRedirects: boolean | null };
  sitemap: { found: boolean; url: string | null } | null;
}): SiteCheck[] {
  const pages = input.pages.filter((p) => p.status >= 200 && p.status < 300);
  const home = pages[0] ?? null;
  const n = pages.length;
  const read = n === 1 ? "the home page" : `${n} pages`;
  const js = !!home && pages.every(builtInBrowser);
  const checks: SiteCheck[] = [];

  checks.push(
    input.https.served
      ? { key: "https", status: "yes", detail: input.https.httpRedirects === false ? "The site answers on HTTPS, but its plain http:// address does not send visitors there." : "The site answers on a secure HTTPS address.", found: [], evidence: home ? { url: home.finalUrl, excerpt: home.finalUrl } : null }
      : { key: "https", status: "no", detail: "The site did not answer on a secure HTTPS address; it was read over plain HTTP.", found: [], evidence: home ? { url: home.finalUrl, excerpt: home.finalUrl } : null },
  );
  if (!home) return checks;

  const homeLower = home.html.toLowerCase();
  const viewport = metaContent(home.html, "viewport", homeLower);
  const fits = !!viewport && /width\s*=\s*device-width/i.test(viewport.content);
  checks.push(yesNo("mobile_viewport", fits, "The home page tells phones to fit it to the screen (a mobile viewport).", "The home page has no mobile viewport setting, so phones may show it zoomed out.", [], fits && viewport ? { url: home.finalUrl, excerpt: viewport.tag.raw.slice(0, 200) } : null));

  const titleTag = tagsOf(home.html, "title", homeLower)[0];
  const titleText = titleTag ? stripTags(innerOf(home.html, titleTag, "title", homeLower, 1_000) ?? "").slice(0, 300) : "";
  checks.push(yesNo("title", !!titleText, `The home page title is "${titleText.slice(0, 90)}".`, "The home page has no title for browsers and search results.", [], titleText ? { url: home.finalUrl, excerpt: titleText.slice(0, 160) } : null));

  const description = metaContent(home.html, "description", homeLower);
  checks.push(yesNo("meta_description", !!description, "The home page has a search description.", "The home page has no search description, so search engines write their own snippet.", [], description ? { url: home.finalUrl, excerpt: description.content.slice(0, 160) } : null));

  const tel = firstLink(pages, (h) => /^tel:/i.test(h));
  checks.push(yesNo("click_to_call", !!tel, "A phone number on the site can be tapped to call.", `None of ${read} has a tap-to-call phone link.`, [], tel ? { url: tel.page.finalUrl, excerpt: excerptAt(tel.page.html, tel.index, 60) } : null, js));

  const mail = firstLink(pages, (h) => /^mailto:/i.test(h));
  checks.push(yesNo("email_link", !!mail, "The site has an email link.", `None of ${read} has an email link.`, [], mail ? { url: mail.page.finalUrl, excerpt: excerptAt(mail.page.html, mail.index, 60) } : null, js));

  const forms = contactForms(pages);
  checks.push(yesNo("contact_form", forms.found.length > 0, `The site has a contact form (${forms.found.join(", ")}).`, `None of ${read} has a contact form.`, forms.found, forms.evidence, js));

  const booking = findAll(pages, BOOKING);
  checks.push(yesNo("online_booking", booking.found.length > 0, `Visitors can book online (${booking.found.join(", ")}).`, `No online booking tool was found on ${read}.`, booking.found, booking.evidence, js));

  const chat = findAll(pages, CHAT);
  checks.push(yesNo("live_chat", chat.found.length > 0, `The site has live chat (${chat.found.join(", ")}).`, `No live chat tool was found on ${read}.`, chat.found, chat.evidence, js));

  const analytics = findAll(pages, ANALYTICS);
  checks.push(yesNo("analytics", analytics.found.length > 0, `The site measures its visitors (${analytics.found.join(", ")}).`, `No visitor analytics tag was found on ${read}.`, analytics.found, analytics.evidence, js));

  const platform = findAll([home], PLATFORM);
  const generator = metaContent(home.html, "generator", homeLower);
  if (generator) {
    for (const [name, re] of GENERATORS) {
      if (re.test(generator.content) && !platform.found.includes(name)) {
        platform.found.push(name);
        platform.evidence ??= { url: home.finalUrl, excerpt: generator.tag.raw.slice(0, 200) };
      }
    }
  }
  checks.push(
    platform.found.length
      ? { key: "platform", status: "yes", detail: `The site is built on ${platform.found.join(" and ")}.`, found: platform.found, evidence: platform.evidence }
      : { key: "platform", status: "unknown", detail: "The platform the site is built on could not be told from its HTML.", found: [], evidence: null },
  );

  const schema = structuredTypes(pages);
  checks.push(yesNo("structured_data", schema.types.length > 0, `The site describes itself to search engines as ${schema.types.join(", ")}.`, `None of ${read} carries structured business data for search engines.`, schema.types, schema.evidence));

  const social: { found: string[]; evidence: SiteCheck["evidence"] } = { found: [], evidence: null };
  for (const page of pages) {
    for (const link of linksOf(page.html)) {
      const hit = SOCIAL_LINKS.find(([name, re]) => re.test(link.href) && !social.found.includes(name));
      if (!hit) continue;
      social.found.push(hit[0]);
      social.evidence ??= { url: page.finalUrl, excerpt: link.href.slice(0, 200) };
    }
  }
  checks.push(yesNo("social_links", social.found.length > 0, `The site links to ${social.found.join(", ")}.`, `None of ${read} links to a social profile.`, social.found, social.evidence, js));

  checks.push(
    input.sitemap === null
      ? { key: "sitemap", status: "unknown", detail: "Neither robots.txt nor /sitemap.xml could be read.", found: [], evidence: null }
      : input.sitemap.found
        ? { key: "sitemap", status: "yes", detail: "The site publishes a sitemap for search engines.", found: [], evidence: input.sitemap.url ? { url: input.sitemap.url, excerpt: input.sitemap.url } : null }
        : { key: "sitemap", status: "no", detail: "The site publishes no sitemap at /sitemap.xml or in robots.txt.", found: [], evidence: null },
  );

  checks.push({
    key: "html_size",
    status: "yes",
    detail: `The home page's HTML is ${kb(home.bytes)}${home.truncated ? " or more (reading stopped at the limit)" : ""}. Images and scripts are not counted.`,
    found: [],
    evidence: { url: home.finalUrl, excerpt: `${home.bytes} bytes` },
  });
  checks.push({
    key: "response_time",
    status: "yes",
    detail: `The home page answered in ${(home.ms / 1000).toFixed(1)} seconds (one measurement, from the Command Center's servers, not the visitor's phone).`,
    found: [],
    evidence: { url: home.finalUrl, excerpt: `${home.ms} ms` },
  });
  return checks;
}

/** Links worth reading after the home page: contact, booking, services, pricing, about. At most `max`, one per kind first. */
export function pagesToRead(home: PageSnapshot, sameSite: (u: URL) => boolean, max = 8): string[] {
  const kinds: ReadonlyArray<readonly [string, RegExp]> = [
    ["contact", /contact|get-in-touch|reach-us/i],
    ["booking", /book|booking|appointment|schedule|reserve|reservation/i],
    ["services", /service|what-we-do|treatments|menu|offerings/i],
    ["pricing", /pric|rates|fees|packages|plans|quote|estimate/i],
    ["about", /about|team|our-story|who-we-are/i],
    ["faq", /faq|questions/i],
  ];
  const seen = new Set<string>([home.finalUrl.replace(/#.*$/, "")]);
  const byKind = new Map<string, string[]>();
  for (const link of linksOf(home.html)) {
    if (!link.href || link.href.startsWith("#")) continue;
    let u: URL;
    try {
      u = new URL(link.href, home.finalUrl);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    if (!sameSite(u)) continue;
    if (/\.(?:pdf|jpe?g|png|gif|webp|svg|zip|mp4|mov|docx?|xlsx?)$/i.test(u.pathname)) continue;
    u.hash = "";
    const key = u.toString();
    if (seen.has(key)) continue;
    const text = `${u.pathname} ${link.text}`;
    const kind = kinds.find(([, re]) => re.test(text));
    if (!kind) continue;
    seen.add(key);
    byKind.set(kind[0], [...(byKind.get(kind[0]) ?? []), key]);
  }
  const out: string[] = [];
  for (let round = 0; out.length < max; round++) {
    let added = false;
    for (const [kind] of kinds) {
      const list = byKind.get(kind) ?? [];
      if (list[round] && out.length < max) {
        out.push(list[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

/** robots.txt: the sitemaps it names, and whether the paths for everyone ("*") are closed. */
export function readRobots(text: string): { sitemaps: string[]; disallow: string[] } {
  const sitemaps: string[] = [];
  const disallow: string[] = [];
  let forAll = false;
  for (const raw of text.split(/\r\n|\r|\n/).slice(0, 2000)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "sitemap" && value) sitemaps.push(value);
    else if (field === "user-agent") forAll = value === "*";
    else if (field === "disallow" && forAll && value) disallow.push(value);
  }
  return { sitemaps: sitemaps.slice(0, 10), disallow: disallow.slice(0, 200) };
}

/** May `path` be read under robots.txt's rules for everyone? */
export function robotsAllow(path: string, disallow: readonly string[]): boolean {
  return !disallow.some((rule) => {
    const exact = rule.endsWith("$");
    const body = exact ? rule.slice(0, -1) : rule;
    const re = new RegExp(`^${body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}${exact ? "$" : ""}`);
    return re.test(path);
  });
}
