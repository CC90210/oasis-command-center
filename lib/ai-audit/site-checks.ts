/**
 * lib/ai-audit/site-checks.ts — what a business's own website shows, measured
 * by code from the pages the Command Center fetched (site-fetch.ts).
 *
 * Every check is a plain reading of the HTML: is there a mobile viewport, a
 * click-to-call link, a contact form, an online booking or chat tool, an
 * analytics tag; which platform the site is built on; what structured data
 * and social links it carries; whether it has a sitemap; how large the home
 * page is and how fast it answered (one measurement, from the Command Center).
 * A "yes" names the page and the bit of HTML that shows it, and says no more
 * than that bit shows: a login or newsletter form is not a contact form, and
 * one file from /wp-content/ is a sign of WordPress, not proof of it. A "no"
 * means none of the pages read showed it, never that the business does not
 * have it elsewhere, and the brief says which pages were read. When the pages
 * build themselves in the browser (little text in the HTML), content checks
 * say "unknown" instead of "no": the browser check in phase 3 can read them.
 * What was not found is "unknown" too when part of where it would be was not
 * read: a page cut off at the size limit, a page with more tags of a kind than
 * are read (MAX_TAGS), or the contact or booking page the home page links to,
 * when that page could not be read. A home page that did not load gives no
 * checks at all: another page never stands in for it. A comment is not part
 * of a page, nor is a script's text part of its markup: a commented-out form
 * or phone link, or a form in a script's template, shows nothing (liveViews),
 * while the tools a page loads are still read from its scripts.
 *
 * These results are the brief's Verified facts: our own measurement, dated.
 *
 * LINEAR TIME. The HTML is the client's (or anyone's who controls the site),
 * so nothing here may slow down on a hostile page: tags are found with
 * indexOf and each is read whole, once, in one forward pass, the next search
 * starting where it ends, never with a pattern that can backtrack across the
 * whole page ("<a<a<a..." or an unclosed <script>); a form or a script is read
 * to its closing tag as a browser reads it, and no two overlap; every repeat
 * in a signature has a limit; robots.txt rules are matched with indexOf, never
 * compiled into a pattern, and at most MAX_ROBOTS_RULES of them.
 * tests/ai-audit-brief.test.ts times each against 600 KB of the shapes that
 * once took seconds.
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

/** The kinds of page worth reading after the home page, in the order they are chosen. */
export const PAGE_KINDS = ["contact", "booking", "services", "pricing", "about", "faq"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];
/** A page the home page links to, with the kind it was chosen as (pagesToRead). */
export type LinkedPage = { url: string; kind: PageKind };

/** A named signature. Every repeat in one has a limit ({0,100}, never * or +): an unlimited repeat that is never completed costs the square of the page. */
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
  ["Google Analytics", /googletagmanager\.com\/gtag\/js\?id=G-|google-analytics\.com\/(?:analytics|ga)\.js|gtag\(\s{0,20}['"]config['"]\s{0,20},\s{0,20}['"](?:G|UA)-/i],
  ["Google Tag Manager", /googletagmanager\.com\/gtm\.js|\bGTM-[A-Z0-9]{4,20}\b/],
  ["Meta Pixel", /connect\.facebook\.net\/[^"'\s<>]{0,100}\/fbevents\.js|fbq\(\s{0,20}['"]init/i],
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

/**
 * Each platform's signs, each a different kind of evidence. Two different
 * signs, the generator tag counting as one, say the site is built on it; one
 * alone (a single image from another site's /wp-content/, say) says only that
 * it shows signs of it. Files from cdn.shopify.com and a shop's .myshopify.com
 * address are one sign: a Shopify Buy Button on a site built elsewhere loads
 * both, and only a Shopify store sets Shopify.theme.
 */
const PLATFORM: ReadonlyArray<readonly [name: string, signs: readonly RegExp[]]> = [
  ["WordPress", [/\/wp-content\//i, /\/wp-includes\//i, /\/wp-json\/|api\.w\.org/i]],
  ["Shopify", [/cdn\.shopify\.com|\.myshopify\.com/i, /Shopify\.theme/]],
  ["Wix", [/static\.wixstatic\.com/i, /\bparastorage\.com/i]],
  ["Squarespace", [/static1\.squarespace\.com/i, /squarespace-cdn\.com/i, /<!-- This is Squarespace/i]],
  ["Webflow", [/data-wf-site=/i, /\bwebflow\.js/i, /assets\.website-files\.com/i]],
  ["GoDaddy Website Builder", [/img1\.wsimg\.com/i]],
  ["Duda", [/irp\.cdn-website\.com/i, /\bdudaone\.com/i]],
  ["Weebly", [/\bweebly\.com/i, /editmysite\.com/i]],
  ["HubSpot CMS", [/\bhs-sites\.com/i, /hubspotusercontent/i]],
  ["Framer", [/framerusercontent\.com/i]],
  ["BigCommerce", [/cdn\d{0,3}\.bigcommerce\.com/i]],
  ["Drupal", [/\/sites\/default\/files\//i]],
  ["Next.js", [/\/_next\/static\//i]],
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

/** A form from a form service, named for the service ("a form from HubSpot"). HubSpot's is its link, its frame or the call that draws one, never its script alone (FORM_SCRIPTS). */
const EMBEDDED_FORMS: readonly Sig[] = [
  ["Typeform", /typeform\.com\/to\/|embed\.typeform\.com/i],
  ["Jotform", /jotform\.com|jotfor\.ms/i],
  ["HubSpot", /hbspt\.forms\.create|\bhs-form-frame\b|\bshare(?:-[a-z0-9]{1,8})?\.hsforms\.com\//i],
  ["Google Forms", /docs\.google\.com\/forms|forms\.gle\//i],
  ["Formspree", /formspree\.io/i],
  ["Wufoo", /wufoo\.com/i],
  ["Cognito Forms", /cognitoforms\.com/i],
  ["Tally", /tally\.so\//i],
];
/** A form service's script, loaded with no form of its own in the HTML: a form it draws may be on the page, so a "no" cannot be said. */
const FORM_SCRIPTS: readonly Sig[] = [["HubSpot", /\bjs(?:-[a-z0-9]{1,8})?\.hsforms\.net\//i]];

// ---------------------------------------------------------------------------
// A linear tag scanner
// ---------------------------------------------------------------------------

/** At most this many tags of one kind are read from a page. Past it, what the rest would show is not known (Scan). */
const MAX_TAGS = 3_000;
const MAX_TAGS_WORDS = MAX_TAGS.toLocaleString("en-US");

/**
 * Lower case for A to Z only, so every index into the result is the same index
 * into the original. toLowerCase can change a string's length (a capital I
 * with a dot, U+0130, becomes two characters), which would shift every
 * position read back from it into the page.
 */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

export type Tag = { index: number; end: number; raw: string; attrs: Record<string, string> };

/**
 * Why a scan stopped before the end of a page, in the words that follow the
 * page's name ("has more than 3,000 links, and only the first 3,000 were
 * read"), or null when it read the page to the end. The scanner sets it; a
 * check that did not find what it looked for in a scan stopped short says
 * "unknown", never "no".
 */
export type Scan = { capped: string | null };

const PLURALS: ReadonlyMap<string, string> = new Map([
  ["a", "links"],
  ["meta", "meta tags"],
  ["input", "form fields"],
  ["textarea", "text boxes"],
  ["select", "drop-down lists"],
]);

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;

/**
 * A tag's attributes that have a value, read in one forward pass: no pattern,
 * so a hostile tag (a 4,000-character name, an unclosed quote) costs its
 * length once. Of two attributes with the same name the first counts, as in a
 * browser; an unclosed quote ends the reading.
 */
function attrsOf(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const n = raw.length;
  let i = 1;
  while (i < n && !isSpace(raw.charCodeAt(i)) && raw[i] !== ">" && raw[i] !== "/") i++;
  while (i < n) {
    while (i < n && (isSpace(raw.charCodeAt(i)) || raw[i] === "/")) i++;
    if (i >= n || raw[i] === ">") break;
    const nameStart = i;
    while (i < n && !isSpace(raw.charCodeAt(i)) && raw[i] !== "=" && raw[i] !== ">" && raw[i] !== "/") i++;
    const name = asciiLower(raw.slice(nameStart, i));
    while (i < n && isSpace(raw.charCodeAt(i))) i++;
    if (raw[i] !== "=") continue;
    i++;
    while (i < n && isSpace(raw.charCodeAt(i))) i++;
    let value: string;
    const quote = raw[i];
    if (quote === '"' || quote === "'") {
      const close = raw.indexOf(quote, i + 1);
      if (close === -1) break;
      value = raw.slice(i + 1, close);
      i = close + 1;
    } else {
      const valueStart = i;
      while (i < n && !isSpace(raw.charCodeAt(i)) && raw[i] !== ">") i++;
      value = raw.slice(valueStart, i);
    }
    if (name && name !== "__proto__" && !Object.prototype.hasOwnProperty.call(attrs, name)) attrs[name] = value;
  }
  return attrs;
}

/**
 * The next opening `<name ...>` tag at or after `from`, read whole however
 * long it is (attrsOf costs its length once), or null when there is none, or
 * it is never closed with ">" (a browser drops such a tag). The next search
 * starts where it ends, so the tags of a page never overlap and it is read
 * once.
 */
function nextTag(html: string, lower: string, name: string, from: number): Tag | null {
  const open = `<${name}`;
  for (let pos = from; ; ) {
    const i = lower.indexOf(open, pos);
    if (i === -1) return null;
    pos = i + open.length;
    const next = lower[pos];
    if (next !== undefined && !/[\s>/]/.test(next)) continue;
    const end = lower.indexOf(">", pos);
    if (end === -1) return null;
    const raw = html.slice(i, end + 1);
    return { index: i, end: end + 1, raw, attrs: attrsOf(raw) };
  }
}

/** Each opening `<name ...>` tag of a page, at most MAX_TAGS of them: when there are more, `scan` says so. */
export function tagsOf(html: string, name: string, lower = asciiLower(html), scan?: Scan): Tag[] {
  const out: Tag[] = [];
  for (let t = nextTag(html, lower, name, 0); t; t = nextTag(html, lower, name, t.end)) {
    if (out.length === MAX_TAGS) {
      if (scan) scan.capped ??= `has more than ${MAX_TAGS_WORDS} ${PLURALS.get(name) ?? `<${name}> tags`}, and only the first ${MAX_TAGS_WORDS} were read`;
      break;
    }
    out.push(t);
  }
  return out;
}

/**
 * The text between a tag and its closing tag (at most `cap` characters), or
 * null when it is not closed within that. Only for the words of a link, read
 * to choose the pages worth reading: no check rests on it, so its limit never
 * stands for an absence (a check reads an element whole, with elementsOf).
 */
export function innerOf(html: string, tag: Tag, name: string, lower = asciiLower(html), cap = 40_000): string | null {
  // Looked for only within `cap` characters, so many unclosed tags cost nothing extra.
  const close = lower.slice(tag.end, tag.end + cap + name.length + 2).indexOf(`</${name}`);
  if (close === -1 || close > cap) return null;
  return html.slice(tag.end, tag.end + close);
}

/**
 * Where the content of a `<name>` element ends, from `from` on: at the first
 * `</name` followed by a space, "/" or ">" (so `</formation>` does not close a
 * form), or at the end of the page when none does, as a browser reads an
 * element left open.
 */
function closeAt(lower: string, name: string, from: number): number {
  const close = `</${name}`;
  for (let i = lower.indexOf(close, from); i !== -1; i = lower.indexOf(close, i + close.length)) {
    const next = lower[i + close.length];
    if (next === undefined || /[\s>/]/.test(next)) return i;
  }
  return lower.length;
}

/**
 * Each `<name>` element of a page with what is inside it, read whole as a
 * browser reads one: to the tag that closes it, or to the end of the page; a
 * `<name>` inside one starts nothing (a form inside a form, the text of a
 * script). No two overlap, so a page is read once however large an element is.
 */
function* elementsOf(html: string, lower: string, name: string): Generator<{ tag: Tag; inner: string; innerLower: string }> {
  for (let tag = nextTag(html, lower, name, 0); tag; ) {
    const stop = closeAt(lower, name, tag.end);
    yield { tag, inner: html.slice(tag.end, stop), innerLower: lower.slice(tag.end, stop) };
    tag = nextTag(html, lower, name, stop);
  }
}

/**
 * A page as a browser reads its markup, in two copies the length of the page,
 * so an index into either is the same index into the page: `live`, with every
 * comment blanked out (an IE conditional comment, <!--[if IE]> ... <![endif]-->,
 * is one), and `markup`, with the text of every script and style blanked out
 * as well; each with its lowered twin, from the page's. As in a browser, "<!--"
 * in a script starts no comment and "<script" in a comment starts no script;
 * a comment ends at the first "-->" or "--!>" ("<!-->" and "<!--->" are empty
 * ones), or runs to the end of the page. One forward pass: where each kind of
 * thing next starts is looked up again only once it is passed.
 */
export function liveViews(html: string, lower = asciiLower(html)): { live: string; liveLower: string; markup: string; markupLower: string } {
  // What is blanked out, in order: where, and whether it is a script's or a style's text (blanked in `markup` only).
  const gaps: Array<readonly [from: number, to: number, text: boolean]> = [];
  let pos = 0;
  // Where each next starts: -2 (or undefined) until it is looked up, -1 (or null) when there is none.
  let comment = -2;
  let dashes = -2;
  let bang = -2;
  const raw: { script?: Tag | null; style?: Tag | null } = {};
  for (;;) {
    if (comment !== -1 && comment < pos) comment = lower.indexOf("<!--", pos);
    let block: Tag | null = null;
    let name: "script" | "style" = "script";
    for (const n of ["script", "style"] as const) {
      const seen = raw[n];
      if (seen === undefined || (seen !== null && seen.index < pos)) raw[n] = nextTag(html, lower, n, pos);
      const t = raw[n] ?? null;
      if (t && (!block || t.index < block.index)) {
        block = t;
        name = n;
      }
    }
    if (comment !== -1 && (!block || comment < block.index)) {
      let end: number;
      if (lower[comment + 4] === ">") end = comment + 5;
      else if (lower.startsWith("->", comment + 4)) end = comment + 6;
      else {
        if (dashes !== -1 && dashes < comment + 4) dashes = lower.indexOf("-->", comment + 4);
        if (bang !== -1 && bang < comment + 4) bang = lower.indexOf("--!>", comment + 4);
        const close = dashes === -1 ? bang : bang === -1 ? dashes : Math.min(dashes, bang);
        end = close === -1 ? html.length : close + (close === bang ? 4 : 3);
      }
      gaps.push([comment, end, false]);
      pos = end;
    } else if (block) {
      // The tag is markup; what is in it, to its closing tag (or the end of the page), is the script's or the style's text.
      const stop = closeAt(lower, name, block.end);
      gaps.push([block.end, stop, true]);
      pos = stop;
    } else break;
  }
  const blankOut = (from: string, scripts: boolean) => {
    const out: string[] = [];
    let at = 0;
    for (const [start, stop, text] of gaps) {
      if (text && !scripts) continue;
      out.push(from.slice(at, start), " ".repeat(stop - start));
      at = stop;
    }
    out.push(from.slice(at));
    return out.join("");
  };
  return { live: blankOut(html, false), liveLower: blankOut(lower, false), markup: blankOut(html, true), markupLower: blankOut(lower, true) };
}

type Link = { href: string; text: string; index: number };

/** Every link on a page (at most MAX_TAGS: `scan` says when there were more): its address and the words it shows. */
function linksOf(html: string, lower = asciiLower(html), scan?: Scan): Link[] {
  return tagsOf(html, "a", lower, scan)
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
function withoutBlocks(html: string, lower = asciiLower(html)): string {
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
    .slice(start, Math.min(html.length, index + Math.min(Math.max(length, 0), 200) + 80))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Every signature found on any page, read without its comments (scripts and all): names, in order, with the first place each was seen. */
function findAll(readings: readonly Reading[], sigs: readonly Sig[]): { found: string[]; evidence: SiteCheck["evidence"] } {
  const found: string[] = [];
  let evidence: SiteCheck["evidence"] = null;
  for (const [name, re] of sigs) {
    for (const r of readings) {
      const m = re.exec(r.live);
      if (!m) continue;
      found.push(name);
      if (!evidence) evidence = { url: r.page.finalUrl, excerpt: excerptAt(r.page.html, m.index, m[0].length) };
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

/** Pages with less text than this may be one of NOT_THE_SITE; a page with more is taken as the business's own. */
const NOT_THE_SITE_TEXT = 2_000;
/** A placeholder says so in few words: a page with more text that says "coming soon" is a site with something coming. */
const PLACEHOLDER_TEXT = 500;
/** What gives away a page that is not the business's own, tested on the text a visitor reads or on the HTML, and the most text such a page has (NOT_THE_SITE_TEXT when not given). */
const NOT_THE_SITE: ReadonlyArray<readonly [what: string, re: RegExp, on: "text" | "html", most?: number]> = [
  ["a domain parking page", /\b(?:this|the) domain(?: name)? (?:is|may be) for sale\b|\bbuy this domain\b|\bdomain (?:is |has been )?parked\b|\bparked free\b|\bdomain parking\b/i, "text"],
  ["a domain parking page", /\b(?:sedoparking\.com|parkingcrew\.net|bodis\.com|afternic\.com|hugedomains\.com|dan\.com\/|wsimg\.com\/parking-lander)/i, "html"],
  ["a web host's placeholder page", /\bwelcome to nginx!|\bapache2? [a-z]{0,20} ?default page\b|\bapache http server test page\b|^it works!|^index of \//i, "text"],
  ["a notice that the hosting account is suspended", /\baccount (?:has been )?suspended\b/i, "text"],
  ["a bot check that needs a browser", /^just a moment(?:\.\.\.|\u2026)|\bchecking your browser\b|\battention required! \| cloudflare\b/i, "text"],
  ["a placeholder for a site that is not built yet", /\b(?:coming|launching|opening) soon\b|\bunder construction\b/i, "text", PLACEHOLDER_TEXT],
];

/**
 * A page that answered at the business's address but is not the business's
 * own: a domain parking page, a web host's placeholder, a suspended account,
 * a bot check, a placeholder for a site not built yet; or a page whose
 * content is at another address: a refresh that sends the visitor on, a
 * frameset, or a body that is a frame and next to nothing else (no link,
 * under 200 characters of text). Said only of a page with very little text
 * (under NOT_THE_SITE_TEXT characters, its comments aside) that shows one of
 * these, with the words or the tag that show it; null for any other page.
 */
export function notTheSite(page: PageSnapshot): { what: string; seen: string } | null {
  const { live, markup, markupLower: lower } = liveViews(page.html);
  const text = visibleText(live);
  if (text.length >= NOT_THE_SITE_TEXT) return null;
  for (const [what, re, on, most = NOT_THE_SITE_TEXT] of NOT_THE_SITE) {
    if (text.length >= most) continue;
    const m = re.exec(on === "text" ? text : live);
    if (m) return { what, seen: m[0].slice(0, 80) };
  }
  for (const t of tagsOf(markup, "meta", lower)) {
    const content = t.attrs.content ?? "";
    // "0; url=https://..." sends the visitor on; a bare "300" only reloads the page.
    if ((t.attrs["http-equiv"] ?? "").trim().toLowerCase() === "refresh" && /[;,]\s{0,20}\S/.test(content)) return { what: "a page that sends visitors on to another address", seen: content.slice(0, 80) };
  }
  const frameset = nextTag(markup, lower, "frameset", 0);
  // A body that is only a frame has no link of its own and next to no text; a page with links or words that also shows a map or a booking tool is the site.
  const onlyFrame = text.length < 200 && !nextTag(markup, lower, "a", 0) ? nextTag(markup, lower, "iframe", 0) : null;
  const frame = frameset ? (nextTag(markup, lower, "frame", frameset.end) ?? frameset) : onlyFrame;
  if (frame) return { what: "a page that shows another address in a frame", seen: (frame.attrs.src || frame.raw).slice(0, 80) };
  return null;
}

function metaContent(metas: readonly Tag[], name: string): { content: string; tag: Tag } | null {
  for (const t of metas) {
    if ((t.attrs.name ?? "").toLowerCase() === name && (t.attrs.content ?? "").trim()) return { content: t.attrs.content.trim(), tag: t };
  }
  return null;
}

/**
 * A page as the checks read it: `live` and `markup` (liveViews), each lowered
 * (`liveLower`, `markupLower`: A to Z only, so indexes match), the name the
 * brief gives it, and its links, read once from its markup.
 */
type Reading = { page: PageSnapshot; live: string; liveLower: string; markup: string; markupLower: string; name: string; links: Link[]; linksCapped: string | null };

/** The first link, on any page, whose address passes `test`. */
function firstLink(readings: readonly Reading[], test: (href: string) => boolean): { page: PageSnapshot; href: string; index: number } | null {
  for (const r of readings) {
    const link = r.links.find((l) => test(l.href));
    if (link) return { page: r.page, href: link.href, index: link.index };
  }
  return null;
}

/** Input types a visitor does not type into. */
const NOT_TYPED_IN = new Set(["hidden", "submit", "button", "search", "image", "reset"]);
/** A field named for a message: what a contact form asks for and a login or a newsletter sign-up does not. */
const MESSAGE_FIELD = /message|msg|comment|enquir|inquir|question/i;
/** A field for a phone number: what a quote or call-back form asks for and a newsletter sign-up does not. */
const PHONE_FIELD = /phone|mobile|\btel\b|\bcell/i;
/** A field for a name or an email: what a quote request and a newsletter sign-up both ask for. */
const DETAILS_FIELD = /name|e-?mail/i;
/** What a newsletter sign-up's own tag or button calls it. */
const NEWSLETTER = /subscri|newsletter|mailing[ -]?list/i;
const fieldWords = (f: Tag) => [f.attrs.name, f.attrs.id, f.attrs.placeholder, f.attrs["aria-label"]].filter(Boolean).join(" ");
const inputType = (f: Tag) => (f.attrs.type ?? "").trim().toLowerCase();

/** What a form calls itself: its own tag (its action, id and class) and the words on its buttons. */
function formWords(form: Tag, inner: string, innerLower: string, fields: readonly Tag[]): string {
  const words = [form.raw];
  for (const f of fields) if (["submit", "button", "image"].includes(inputType(f))) words.push(`${f.attrs.value ?? ""} ${f.attrs.alt ?? ""}`);
  for (const { inner: label } of elementsOf(inner, innerLower, "button")) words.push(label.slice(0, 200));
  return words.join(" ");
}

type FormFinding = {
  /** The first contact form seen, on the site itself or from a form service. */
  form: { own: boolean; names: string[]; evidence: SiteCheck["evidence"] } | null;
  /** Why a form seen may be a contact form though it is not known to be one, in a sentence: the first such reason, or null. */
  unsure: string | null;
  /** Why a form's fields were not all read, when they were not. */
  capped: string | null;
};

/**
 * Contact forms: a form with no password field that a visitor writes a
 * message in (a text box, or a field named for a message) or leaves a phone
 * number in (a quote or call-back form), with another field to fill in. A
 * login, a newsletter sign-up and a site search are not contact forms. One
 * that asks only for a name or an email, and does not call itself a sign-up,
 * may be a quote request or may not: whether it is one is not known, and never
 * said to be "no". A form from a form service (Typeform, a HubSpot form) is a
 * form whose fields are not in the page's HTML, and is said to be just that;
 * the service's script alone is not known to draw one.
 */
function contactForms(readings: readonly Reading[]): FormFinding {
  let unsure: string | null = null;
  let capped: string | null = null;
  for (const r of readings) {
    for (const { tag: form, inner, innerLower } of elementsOf(r.markup, r.markupLower, "form")) {
      if (/\bsearch/i.test(form.raw)) continue;
      const scan: Scan = { capped: null };
      const boxes = tagsOf(inner, "textarea", innerLower, scan);
      const fields = [...tagsOf(inner, "input", innerLower, scan), ...tagsOf(inner, "select", innerLower, scan)];
      if (scan.capped) capped ??= `${r.name} ${scan.capped}`;
      const typedIn = fields.filter((f) => !NOT_TYPED_IN.has(inputType(f)));
      if (boxes.length + typedIn.length < 2) continue;
      const password = fields.some((f) => inputType(f) === "password");
      const ownForm = (names: string): FormFinding => ({ form: { own: true, names: [names], evidence: { url: r.page.finalUrl, excerpt: excerptAt(r.page.html, form.index, form.raw.length) } }, unsure, capped });
      if (boxes.length > 0 || fields.some((f) => MESSAGE_FIELD.test(fieldWords(f)))) {
        if (!password) return ownForm("a form with a message field");
        unsure ??= `A form on ${r.name} has a message field but also asks for a password, so whether it is a contact form is not known.`;
        continue;
      }
      // No message field: a quote or call-back form asks for the visitor's details instead. Not a login, nor a sign-up that says it is one.
      if (password || NEWSLETTER.test(formWords(form, inner, innerLower, fields))) continue;
      if (typedIn.some((f) => inputType(f) === "tel" || PHONE_FIELD.test(fieldWords(f)))) return ownForm("a form that asks for a phone number");
      if (typedIn.some((f) => inputType(f) === "email" || DETAILS_FIELD.test(fieldWords(f)))) {
        unsure ??= `A form on ${r.name} asks for a name or an email but has no message or phone field, so whether it is a contact form is not known.`;
      }
    }
  }
  const embedded = findAll(readings, EMBEDDED_FORMS);
  if (embedded.found.length) return { form: { own: false, names: embedded.found, evidence: embedded.evidence }, unsure, capped };
  for (const r of readings) {
    const script = FORM_SCRIPTS.find(([, re]) => re.test(r.live));
    if (script) unsure ??= `The ${script[0]} forms script is loaded on ${r.name}, but no form from it is in the page's HTML, so whether the site has a contact form is not known.`;
  }
  return { form: null, unsure, capped };
}

/** schema.org types named in microdata (itemtype) and in RDFa (typeof, with the schema: prefix, or bare under a schema.org vocab). */
const MICRODATA_TYPE = /\bitemtype\s{0,10}=\s{0,10}["']?\s{0,10}https?:\/\/(?:www\.)?schema\.org\/([A-Za-z]{1,60})/gi;
const RDFA_PREFIXED_TYPE = /\btypeof\s{0,10}=\s{0,10}["']?\s{0,10}schema:([A-Za-z]{1,60})/gi;
const RDFA_VOCAB = /\bvocab\s{0,10}=\s{0,10}["']?\s{0,10}https?:\/\/(?:www\.)?schema\.org/i;
const RDFA_BARE_TYPE = /\btypeof\s{0,10}=\s{0,10}["']\s{0,10}([A-Za-z]{1,60})["'\s]/gi;

/** Structured data for search engines: the schema.org types the pages declare (LocalBusiness and the like), in JSON-LD, microdata or RDFa. */
function structuredTypes(readings: readonly Reading[]): { types: string[]; evidence: SiteCheck["evidence"] } {
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
  for (const r of readings) {
    const p = r.page;
    // Every JSON-LD block, each read whole: scripts never overlap, so the page is read once however large a block is.
    for (const { tag, inner } of elementsOf(r.live, r.liveLower, "script")) {
      if ((tag.attrs.type ?? "").trim().toLowerCase() !== "application/ld+json") continue;
      try {
        visit(JSON.parse(inner), 0);
        evidence ??= { url: p.finalUrl, excerpt: inner.slice(0, 400).replace(/\s+/g, " ").trim().slice(0, 160) };
      } catch {
        // Broken JSON-LD is what the site serves; it counts as none.
      }
    }
    const named = [...r.markup.matchAll(MICRODATA_TYPE), ...r.markup.matchAll(RDFA_PREFIXED_TYPE), ...(RDFA_VOCAB.test(r.markup) ? r.markup.matchAll(RDFA_BARE_TYPE) : [])];
    for (const m of named) {
      types.add(m[1]);
      evidence ??= { url: p.finalUrl, excerpt: excerptAt(p.html, m.index ?? 0, m[0].length) };
    }
  }
  return { types: [...types].slice(0, 12), evidence };
}

/** The platforms the home page shows: built on (two different signs), or only signs of (one). */
function platformsOf(home: PageSnapshot, generator: { content: string; tag: Tag } | null): { built: string[]; signs: string[]; evidence: SiteCheck["evidence"] } {
  const built: string[] = [];
  const signs: string[] = [];
  let evidence: SiteCheck["evidence"] = null;
  for (const name of new Set([...PLATFORM.map(([n]) => n), ...GENERATORS.map(([n]) => n)])) {
    let seen = 0;
    for (const re of PLATFORM.find(([n]) => n === name)?.[1] ?? []) {
      const m = re.exec(home.html);
      if (!m) continue;
      seen += 1;
      evidence ??= { url: home.finalUrl, excerpt: excerptAt(home.html, m.index, m[0].length) };
    }
    if (generator && GENERATORS.find(([n]) => n === name)?.[1].test(generator.content)) {
      seen += 1;
      evidence ??= { url: home.finalUrl, excerpt: generator.tag.raw.slice(0, 200) };
    }
    if (seen >= 2) built.push(name);
    else if (seen === 1) signs.push(name);
  }
  return { built, signs, evidence };
}

function kb(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/**
 * A check that is "yes" when `ok`, else "no", unless a "no" cannot be said:
 * the pages build themselves in the browser (`js`), or `because` says what
 * was not read ("only the first 600 KB of the home page was read"), so what
 * was not found may be in the rest; then it is "unknown".
 */
function yesNo(key: CheckKey, ok: boolean, detailYes: string, detailNo: string, found: string[], evidence: SiteCheck["evidence"], js = false, because: string | null = null): SiteCheck {
  if (!ok && js) return { key, status: "unknown", detail: `${detailNo.replace(/\.$/, "")}, but the pages build themselves in the browser, so this may be wrong.`, found: [], evidence: null };
  if (!ok && because) return { key, status: "unknown", detail: `Not found in what was read, but ${because}, so it may be in the rest.`, found: [], evidence: null };
  return { key, status: ok ? "yes" : "no", detail: ok ? detailYes : detailNo, found, evidence };
}

/** The first reason given, or null. */
const first = (...reasons: Array<string | null>): string | null => reasons.find((r) => r !== null) ?? null;

/** What was found about a sitemap: one that is there (and where), one that is not (and why it is said), or why it is not known. */
export type SitemapFinding = { found: true; url: string | null } | { found: false; url: string | null; detail?: string } | { unknown: string };

/**
 * Every check, from the home page (pages[0], and only pages[0]) and the other
 * pages read. A home page that did not load (no 2xx answer) gives no checks at
 * all: nothing is said about a site whose home page was not read, and another
 * page never stands in for it. `https`: whether the home page was served over
 * HTTPS, whether plain HTTP sends visitors there (null when that was not
 * tried), and the secure request that failed when the site was read over
 * plain HTTP because of it. `sitemap`: null when nothing about it could be
 * read. `unread`: the pages the home page links to that were meant to be read
 * and were not (they failed, or did not answer 2xx); what the contact or
 * booking page would have shown is then unknown, never "no".
 */
export function runSiteChecks(input: {
  pages: readonly PageSnapshot[];
  https: { served: boolean; httpRedirects: boolean | null; secureFailure?: { url: string; excerpt: string } | null };
  sitemap: SitemapFinding | null;
  unread?: readonly LinkedPage[];
}): SiteCheck[] {
  const loaded = (p: PageSnapshot) => p.status >= 200 && p.status < 300;
  const home = input.pages[0];
  if (!home || !loaded(home)) return [];
  const pages = input.pages.filter(loaded);
  const n = pages.length;
  const read = n === 1 ? "the home page" : `${n} pages`;
  const readings: Reading[] = pages.map((page) => {
    const { live, liveLower, markup, markupLower } = liveViews(page.html);
    const name = page === home ? "the home page" : page.finalUrl;
    const scan: Scan = { capped: null };
    const links = linksOf(markup, markupLower, scan);
    return { page, live, liveLower, markup, markupLower, name, links, linksCapped: scan.capped && `${name} ${scan.capped}` };
  });
  // Whether the pages build themselves in the browser is told without their comments.
  const js = readings.every((r) => builtInBrowser({ ...r.page, html: r.live }));
  const homeReading = readings[0];
  const checks: SiteCheck[] = [];

  // Why a "no" cannot be said, when it cannot: part of a page was not read...
  const cutAt = (p: PageSnapshot | undefined) => (p ? `only the first ${kb(p.bytes)} of ${p === home ? "the home page" : p.finalUrl} was read` : null);
  const homeCut = cutAt(home.truncated ? home : undefined);
  const anyCut = cutAt(pages.find((p) => p.truncated));
  // ...a page has more links than are read (the home page's are where the pages to read were chosen from)...
  const linksCapped = first(...readings.map((r) => r.linksCapped));
  // ...or the page the home page links to for it could not be read.
  const notRead = (kind: PageKind): string | null => {
    const u = (input.unread ?? []).find((x) => x.kind === kind);
    return u ? `${u.url}, the ${kind} page the home page links to, could not be read` : null;
  };
  const contactUnread = notRead("contact");

  const secureFailure = input.https.secureFailure ?? null;
  checks.push(
    input.https.served
      ? { key: "https", status: "yes", detail: input.https.httpRedirects === false ? "The site answers on HTTPS, but its plain http:// address does not send visitors there." : "The site answers on a secure HTTPS address.", found: [], evidence: { url: home.finalUrl, excerpt: home.finalUrl } }
      : secureFailure
        ? { key: "https", status: "no", detail: "The site could not be reached on a secure HTTPS address; it was read over plain HTTP.", found: [], evidence: secureFailure }
        : { key: "https", status: "no", detail: "The site's secure HTTPS address sends visitors to plain HTTP, so it was read there.", found: [], evidence: { url: home.finalUrl, excerpt: home.finalUrl } },
  );

  const homeLower = homeReading.markupLower;
  const metaScan: Scan = { capped: null };
  const metas = tagsOf(homeReading.markup, "meta", homeLower, metaScan);
  const metaCapped = metaScan.capped && `the home page ${metaScan.capped}`;
  const viewport = metaContent(metas, "viewport");
  const fits = !!viewport && /width\s{0,20}=\s{0,20}device-width/i.test(viewport.content);
  // A viewport setting without width=device-width is said as it was seen, never as no setting at all.
  const seenViewport = viewport ? viewport.content.slice(0, 200).replace(/\s+/g, " ").trim().slice(0, 80) : "";
  checks.push(
    yesNo(
      "mobile_viewport",
      fits,
      "The home page tells phones to fit it to the screen (a mobile viewport).",
      viewport ? `The home page's viewport setting ("${seenViewport}") does not include width=device-width, so phones may not fit it to the screen.` : "The home page has no mobile viewport setting, so phones may show it zoomed out.",
      [],
      viewport ? { url: home.finalUrl, excerpt: viewport.tag.raw.slice(0, 200) } : null,
      false,
      viewport ? null : first(homeCut, metaCapped),
    ),
  );

  // The title: its first 1,000 characters, wherever it closes (a title is text only, so the start of one is the start of it).
  const titleTag = nextTag(homeReading.markup, homeLower, "title", 0);
  const titleText = titleTag ? stripTags(homeReading.markup.slice(titleTag.end, Math.min(closeAt(homeLower, "title", titleTag.end), titleTag.end + 1_000))).slice(0, 300) : "";
  checks.push(yesNo("title", !!titleText, `The home page title is "${titleText.slice(0, 90)}".`, "The home page has no title for browsers and search results.", [], titleText ? { url: home.finalUrl, excerpt: titleText.slice(0, 160) } : null, false, titleTag ? null : homeCut));

  const description = metaContent(metas, "description");
  checks.push(yesNo("meta_description", !!description, "The home page has a search description.", "The home page has no search description, so search engines write their own snippet.", [], description ? { url: home.finalUrl, excerpt: description.content.slice(0, 160) } : null, false, first(homeCut, metaCapped)));

  const tel = firstLink(readings, (h) => /^tel:/i.test(h));
  checks.push(yesNo("click_to_call", !!tel, "A phone number on the site can be tapped to call.", `None of ${read} has a tap-to-call phone link.`, [], tel ? { url: tel.page.finalUrl, excerpt: excerptAt(tel.page.html, tel.index, 60) } : null, js, first(anyCut, linksCapped, contactUnread)));

  const mail = firstLink(readings, (h) => /^mailto:/i.test(h));
  checks.push(yesNo("email_link", !!mail, "The site has an email link.", `None of ${read} has an email link.`, [], mail ? { url: mail.page.finalUrl, excerpt: excerptAt(mail.page.html, mail.index, 60) } : null, js, first(anyCut, linksCapped, contactUnread)));

  const forms = contactForms(readings);
  checks.push(
    forms.form
      ? {
          key: "contact_form",
          status: "yes",
          detail: forms.form.own ? `The site has a contact form (${forms.form.names.join(", ")}).` : `The site has a form from ${forms.form.names.join(", ")}; what it asks for is not in the page's HTML.`,
          found: forms.form.names,
          evidence: forms.form.evidence,
        }
      : !js && forms.unsure
        ? { key: "contact_form", status: "unknown", detail: forms.unsure, found: [], evidence: null }
        : yesNo("contact_form", false, "", `None of ${read} has a contact form.`, [], null, js, first(anyCut, forms.capped, homeReading.linksCapped, contactUnread)),
  );

  const booking = findAll(readings, BOOKING);
  checks.push(yesNo("online_booking", booking.found.length > 0, `Visitors can book online (${booking.found.join(", ")}).`, `No online booking tool was found on ${read}.`, booking.found, booking.evidence, js, first(anyCut, homeReading.linksCapped, notRead("booking"))));

  const chat = findAll(readings, CHAT);
  checks.push(yesNo("live_chat", chat.found.length > 0, `The site has live chat (${chat.found.join(", ")}).`, `No live chat tool was found on ${read}.`, chat.found, chat.evidence, js, anyCut));

  const analytics = findAll(readings, ANALYTICS);
  checks.push(yesNo("analytics", analytics.found.length > 0, `The site measures its visitors (${analytics.found.join(", ")}).`, `No visitor analytics tag was found on ${read}.`, analytics.found, analytics.evidence, js, anyCut));

  const platform = platformsOf(home, metaContent(metas, "generator"));
  const platformWords = [platform.built.length ? `is built on ${platform.built.join(" and ")}` : "", platform.signs.length ? `shows signs of ${platform.signs.join(" and ")}` : ""].filter(Boolean).join(", and ");
  checks.push(
    platformWords
      ? { key: "platform", status: "yes", detail: `The site ${platformWords}.`, found: [...platform.built, ...platform.signs], evidence: platform.evidence }
      : { key: "platform", status: "unknown", detail: "The platform the site is built on could not be told from its HTML.", found: [], evidence: null },
  );

  const schema = structuredTypes(readings);
  checks.push(yesNo("structured_data", schema.types.length > 0, `The site describes itself to search engines as ${schema.types.join(", ")}.`, `None of ${read} carries structured business data for search engines.`, schema.types, schema.evidence, false, anyCut));

  const social: { found: string[]; evidence: SiteCheck["evidence"] } = { found: [], evidence: null };
  for (const r of readings) {
    for (const link of r.links) {
      const hit = SOCIAL_LINKS.find(([name, re]) => re.test(link.href) && !social.found.includes(name));
      if (!hit) continue;
      social.found.push(hit[0]);
      social.evidence ??= { url: r.page.finalUrl, excerpt: link.href.slice(0, 200) };
    }
  }
  checks.push(yesNo("social_links", social.found.length > 0, `The site links to ${social.found.join(", ")}.`, `None of ${read} links to a social profile.`, social.found, social.evidence, js, first(anyCut, linksCapped)));

  const sm = input.sitemap;
  checks.push(
    sm === null
      ? { key: "sitemap", status: "unknown", detail: "Neither robots.txt nor /sitemap.xml could be read.", found: [], evidence: null }
      : "unknown" in sm
        ? { key: "sitemap", status: "unknown", detail: sm.unknown, found: [], evidence: null }
        : sm.found
          ? { key: "sitemap", status: "yes", detail: "The site publishes a sitemap for search engines.", found: [], evidence: sm.url ? { url: sm.url, excerpt: sm.url } : null }
          : { key: "sitemap", status: "no", detail: sm.detail ?? "The site publishes no sitemap at /sitemap.xml or in robots.txt.", found: [], evidence: sm.url ? { url: sm.url, excerpt: sm.url } : null },
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

/** Links worth reading after the home page: contact, booking, services, pricing, about, FAQ. At most `max`, one per kind first, each with the kind it was chosen as. */
export function pagesToRead(home: PageSnapshot, sameSite: (u: URL) => boolean, max = 8): LinkedPage[] {
  const kinds: ReadonlyArray<readonly [PageKind, RegExp]> = [
    ["contact", /contact|get-in-touch|reach-us/i],
    ["booking", /book|booking|appointment|schedule|reserve|reservation/i],
    ["services", /service|what-we-do|treatments|menu|offerings/i],
    ["pricing", /pric|rates|fees|packages|plans|quote|estimate/i],
    ["about", /about|team|our-story|who-we-are/i],
    ["faq", /faq|questions/i],
  ];
  const seen = new Set<string>([home.finalUrl.replace(/#.*$/, "")]);
  const byKind = new Map<PageKind, string[]>();
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
    // An address this long is not a page worth reading; it would be stored with the brief and matched against robots.txt.
    if (key.length > MAX_URL_CHARS) continue;
    if (seen.has(key)) continue;
    const text = `${u.pathname} ${link.text}`;
    const kind = kinds.find(([, re]) => re.test(text));
    if (!kind) continue;
    seen.add(key);
    byKind.set(kind[0], [...(byKind.get(kind[0]) ?? []), key]);
  }
  const out: LinkedPage[] = [];
  for (let round = 0; out.length < max; round++) {
    let added = false;
    for (const [kind] of kinds) {
      const list = byKind.get(kind) ?? [];
      if (list[round] && out.length < max) {
        out.push({ url: list[round], kind });
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

/** The longest address the brief reads or stores (a page, a sitemap). */
export const MAX_URL_CHARS = 500;
/** The product token robots.txt groups are matched against (RFC 9309): the first word of site-fetch.ts's user agent. */
export const ROBOTS_AGENT = "OASIS-AI-Audit";
/** At most this many rules are followed for our agent. A robots.txt with more closes the whole site to us: a rule past the limit could close the page asked for. */
export const MAX_ROBOTS_RULES = 2_000;
/** A rule longer than this is cut to it (a Disallow cut short closes more, never less); its length still decides which rule wins. */
const MAX_RULE_CHARS = 512;
/** At most this many "*" in a rule: past them a Disallow is cut short (it closes more), an Allow is dropped (it opens nothing). */
const MAX_RULE_STARS = 20;

/** The rules for our agent, each in the spelling robotsNormal gives it; `tooMany` when there were more than MAX_ROBOTS_RULES, and then nothing may be read. */
export type RobotsRules = { allow: string[]; disallow: string[]; tooMany: boolean };

const isHexDigit = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
/** RFC 3986's unreserved characters: A-Z, a-z, 0-9, "-", ".", "_", "~". */
const isUnreserved = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 95 || c === 126;
/** Printable ASCII the URL parser still encodes in a path or its query: '"', "'" (in a query), "<", ">", "`", "{", "}". */
const ENCODED_IN_PATH = new Set([34, 39, 60, 62, 96, 123, 125]);
const HEX = "0123456789ABCDEF";
const pct = (b: number) => `%${HEX[b >> 4]}${HEX[b & 15]}`;
const UTF8 = new TextEncoder();

/**
 * A path, or a robots.txt rule, in the one spelling RFC 9309 (section 2.2.2)
 * compares them in: a character outside ASCII percent-encoded as UTF-8; a
 * percent-encoded unreserved character decoded ("%70rivate" is "private");
 * every other percent-encoding kept, its hex in capitals; and what the URL
 * parser encodes in a path (a control character, a space, '"', "<", ">", "`",
 * "{", "}") or in a query ("'") encoded as it encodes it, wherever it is, so a
 * rule spelled with "'" matches the "%27" a query is asked with. Case is kept:
 * a path is matched case-sensitively. One forward pass.
 */
export function robotsNormal(s: string): string {
  let out = "";
  let kept = 0;
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (c > 32 && c < 127 && c !== 37 && !ENCODED_IN_PATH.has(c)) {
      i++;
      continue;
    }
    out += s.slice(kept, i);
    if (c === 37 && isHexDigit(s.charCodeAt(i + 1)) && isHexDigit(s.charCodeAt(i + 2))) {
      const b = parseInt(s.slice(i + 1, i + 3), 16);
      out += isUnreserved(b) ? String.fromCharCode(b) : pct(b);
      i += 3;
    } else if (c === 37) {
      out += "%";
      i += 1;
    } else if (c >= 128) {
      let j = i + 1;
      while (j < s.length && s.charCodeAt(j) >= 128) j++;
      for (const b of UTF8.encode(s.slice(i, j))) out += pct(b);
      i = j;
    } else {
      out += pct(c);
      i += 1;
    }
    kept = i;
  }
  return out + s.slice(kept);
}

function agentToken(value: string): string {
  if (value.startsWith("*")) return "*";
  return (/^[A-Za-z_-]+/.exec(value)?.[0] ?? "").toLowerCase();
}

/**
 * robots.txt as RFC 9309 reads it: the sitemaps it names, and the rules of the
 * group for our agent (ROBOTS_AGENT), or of the group for everyone ("*") when
 * no group names us. The whole file is read: site-fetch.ts reads at most
 * 600,000 bytes of it, and the standard asks for at least 500 KiB.
 * Consecutive user-agent lines share one group; groups for the same agent are
 * combined; each rule is kept in robotsNormal's spelling, and past
 * MAX_ROBOTS_RULES for our agent, `tooMany` says nothing may be read. A
 * sitemap address longer than MAX_URL_CHARS is skipped: it is not one, and it
 * would be stored with the brief. `cut`: the file was cut off at the size
 * limit, so its last line may be part of one, and it is read only when it is
 * a Disallow (cut short, a Disallow closes more, never less).
 */
export function readRobots(text: string, agent = ROBOTS_AGENT, cut = false): { sitemaps: string[] } & RobotsRules {
  const sitemaps: string[] = [];
  type Group = { agents: string[]; allow: string[]; disallow: string[]; rules: number };
  const groups: Group[] = [];
  let group: Group | null = null;
  let agentLines = false;
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    // [^\r\n], never ".": a "." stops at U+2028 and U+2029, which kept such a comment and dropped its rule.
    const line = lines[i].replace(/#[^\r\n]*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*([^\r\n]*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    let value = m[2].trim();
    if (cut && i === lines.length - 1) {
      if (field !== "disallow") continue;
      // A character cut in half at the limit is decoded as U+FFFD: what came before it is the rule.
      let end = value.length;
      while (end > 0 && value.charCodeAt(end - 1) === 0xfffd) end--;
      value = value.slice(0, end);
    }
    if (field === "sitemap") {
      if (value && value.length <= MAX_URL_CHARS && sitemaps.length < 10) sitemaps.push(value);
    } else if (field === "user-agent") {
      if (!group || !agentLines) groups.push((group = { agents: [], allow: [], disallow: [], rules: 0 }));
      group.agents.push(agentToken(value));
      agentLines = true;
    } else if (field === "allow" || field === "disallow") {
      agentLines = false;
      // A rule before any user-agent line belongs to no group; an empty Disallow closes nothing.
      if (group && value) {
        group.rules += 1;
        // Counted past the limit but not kept: the count alone closes the site (below).
        if (group.rules <= MAX_ROBOTS_RULES) group[field].push(robotsNormal(value));
      }
    }
  }
  const mine = groups.filter((g) => g.agents.includes(agent.toLowerCase()));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  const tooMany = chosen.reduce((sum, g) => sum + g.rules, 0) > MAX_ROBOTS_RULES;
  return { sitemaps, allow: tooMany ? [] : chosen.flatMap((g) => g.allow), disallow: tooMany ? [] : chosen.flatMap((g) => g.disallow), tooMany };
}

/**
 * Does a robots.txt rule match `path` (with its query)? "*" matches any run
 * of characters and a final "$" anchors the end (RFC 9309). No pattern is
 * compiled from the rule: each piece between the stars is found once, left to
 * right, with indexOf, and the earliest place for each is the right one (a
 * later place only leaves less room for the rest), so a rule of many stars
 * costs about the length of the path, not a power of it.
 */
export function robotsMatch(path: string, rule: string): boolean {
  const end = rule.endsWith("$");
  const pieces = (end ? rule.slice(0, -1) : rule).split("*");
  const first = pieces[0];
  if (!path.startsWith(first)) return false;
  if (pieces.length === 1) return !end || path.length === first.length;
  let at = first.length;
  for (let i = 1; i < pieces.length - 1; i++) {
    const found = path.indexOf(pieces[i], at);
    if (found === -1) return false;
    at = found + pieces[i].length;
  }
  const last = pieces[pieces.length - 1];
  return end ? path.length - last.length >= at && path.endsWith(last) : path.indexOf(last, at) !== -1;
}

/** A rule within the limits: cut short, or null when it cannot be kept without opening more than it says. */
function boundedRule(rule: string, allow: boolean): string | null {
  let stars = 0;
  for (let i = 0; i < rule.length && i < MAX_RULE_CHARS; i++) {
    if (rule[i] !== "*" || ++stars <= MAX_RULE_STARS) continue;
    return allow ? null : rule.slice(0, i + 1);
  }
  if (rule.length <= MAX_RULE_CHARS) return rule;
  return allow ? null : rule.slice(0, MAX_RULE_CHARS);
}

/**
 * May `path` (the path and its query, "/contact?ref=1") be read under these
 * rules? The path is put in robotsNormal's spelling, as the rules are. The
 * rule that matches the most characters decides; when an Allow and a Disallow
 * tie, the Allow wins; when none matches, it may (RFC 9309). A path longer
 * than 2,048 characters is not matched at all: it counts as closed, and so
 * does every path when there were too many rules to follow.
 */
export function robotsAllow(path: string, rules: RobotsRules): boolean {
  if (rules.tooMany || path.length > 2_048) return false;
  const p = robotsNormal(path);
  if (p.length > 2_048) return false;
  let best = -1;
  let allowed = true;
  for (const rule of rules.disallow) {
    const r = boundedRule(rule, false);
    if (r && rule.length > best && robotsMatch(p, r)) {
      best = rule.length;
      allowed = false;
    }
  }
  for (const rule of rules.allow) {
    const r = boundedRule(rule, true);
    if (r && rule.length >= best && robotsMatch(p, r)) {
      best = rule.length;
      allowed = true;
    }
  }
  return allowed;
}
