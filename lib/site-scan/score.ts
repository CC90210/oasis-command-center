/**
 * lib/site-scan/score.ts — the OASIS score: 0 (nothing works for a visitor) to 100, from the
 * checks, PageSpeed and signals alone. Deterministic, explained per pillar, and every missing
 * point is a candidate fix that names the OASIS build that earns it back.
 *
 * The weights are the order in which a local service business loses money online: a visitor who
 * cannot act (conversion) costs more than a slow page, which costs more than a thin profile.
 */
import type { ScanFacts, ScanFix, ScanScore, ScorePillar } from "@/lib/site-scan/types";
import { SCORE_SCHEMA } from "@/lib/site-scan/types";

type CheckMap = Record<string, "yes" | "no" | "unknown">;

type Candidate = ScanFix & { pillar: ScorePillar["key"]; points: number };

const WEIGHTS: Record<ScorePillar["key"], number> = { conversion: 30, speed: 20, trust: 20, findability: 20, reach: 10 };
const LABELS: Record<ScorePillar["key"], string> = {
  conversion: "Can a visitor act?",
  speed: "Does it load on a phone?",
  trust: "Does it look real and current?",
  findability: "Can Google read it?",
  reach: "Does it reach back out?",
};

function checkMap(facts: ScanFacts): CheckMap {
  const m: CheckMap = {};
  for (const c of facts.checks) m[c.key] = c.status;
  return m;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Under this share of a pillar's points readable, the pillar is not scored: a guess is not a measurement. */
export const MIN_READABLE_POINTS = 25;
/** Under this share of the total's weight scored, the site gets no total. */
export const MIN_SCORED_WEIGHT = 50;

/** A pillar is a sum of points; each missing item is a candidate fix with its own points. */
function pillar(
  key: ScorePillar["key"],
  items: Array<{ earned: boolean | null; points: number; fix?: Omit<ScanFix, "impact"> & { detail?: string } }>,
  detailWhenFull: string,
): { pillar: ScorePillar; candidates: Candidate[] } {
  let score = 0;
  let unknownPoints = 0;
  const missing: Array<{ points: number; fix: Omit<ScanFix, "impact"> }> = [];
  for (const it of items) {
    if (it.earned === true) score += it.points;
    else if (it.earned === null) unknownPoints += it.points;
    else if (it.fix) missing.push({ points: it.points, fix: it.fix });
  }
  // Unknowns neither earn nor lose: the pillar is scored over what could be read, and a fix is
  // worth what it moves on that same scale (points / readable of the pillar, times its weight).
  const readable = 100 - unknownPoints;
  if (readable < MIN_READABLE_POINTS) {
    return { pillar: { key, label: LABELS[key], score: null, weight: WEIGHTS[key], detail: "Not enough of this could be read from outside to score it." }, candidates: [] };
  }
  // `impact` here is the fix's weighted gain over 100 weight; scoreFacts rescales it to the scored
  // weight once that is known, the same denominator the total uses.
  const candidates: Candidate[] = missing.map((m) => ({ ...m.fix, pillar: key, points: m.points, impact: (m.points * WEIGHTS[key]) / readable }));
  const detail = missing.length ? `Missing: ${missing.map((m) => m.fix.title).join("; ")}.` : unknownPoints >= 50 ? "Mostly unreadable from here." : detailWhenFull;
  return { pillar: { key, label: LABELS[key], score: clamp((score / readable) * 100), weight: WEIGHTS[key], detail }, candidates };
}

export function scoreFacts(facts: ScanFacts): ScanScore {
  const c = checkMap(facts);
  // Signals from a page with no readable text (a site that draws itself in the browser: a 586 KB
  // shell, zero words) are not evidence that a call link, a form or a city is missing.
  const s = facts.signals && facts.signals.word_count > 0 ? facts.signals : null;
  const ps = facts.pagespeed && "scores" in facts.pagespeed ? facts.pagespeed : null;
  const perf = ps?.scores.performance ?? null;
  const seo = ps?.scores.seo ?? null;
  const tri = (k: string) => (c[k] === "yes" ? true : c[k] === "no" ? false : null);
  const yearNow = new Date(facts.read_at).getUTCFullYear();

  const conversion = pillar(
    "conversion",
    [
      { earned: tri("click_to_call"), points: 25, fix: { key: "click_to_call", title: "Tap-to-call phone link", why: "On a phone, a number that is not a link is a number nobody dials.", automation: "missed_call_textback" } },
      { earned: tri("contact_form"), points: 20, fix: { key: "contact_form", title: "A contact form that answers back", why: "Without a form, after-hours visitors have no way to leave a request.", automation: "lead_form_autoreply" } },
      { earned: tri("online_booking"), points: 30, fix: { key: "online_booking", title: "Online booking", why: "Visitors who can book without calling book more often, and at night.", automation: "booking_and_reminders" } },
      { earned: s ? s.cta_phrases.length > 0 : null, points: 15, fix: { key: "cta", title: "A clear call to action", why: "No page tells the visitor what to do next.", automation: "conversion_page" } },
      // Read pages with no chat tool are evidence of none; with no pages read, only the check can say.
      { earned: tri("live_chat") === true || (s ? s.chat_tools.length > 0 : false) ? true : s ? false : tri("live_chat"), points: 10, fix: { key: "chat", title: "Chat or text-back", why: "A question that waits for business hours is usually asked elsewhere.", automation: "missed_call_textback" } },
    ],
    "Every way to act is in place.",
  );

  const speed = pillar(
    "speed",
    [
      perf !== null
        ? { earned: perf >= 70, points: 60, fix: { key: "mobile_speed", title: `Mobile speed (PageSpeed ${perf}/100)`, why: "Google measures the phone experience first; below 70 the page loses visitors before it draws.", automation: "site_rebuild" } }
        : { earned: facts.site.response_ms !== null ? facts.site.response_ms < 1_500 : null, points: 60, fix: { key: "response_time", title: `Slow first response (${facts.site.response_ms ?? "?"} ms)`, why: "The server took over 1.5 s before the page even began.", automation: "site_rebuild" } },
      { earned: tri("html_size"), points: 20, fix: { key: "html_size", title: "Heavy home page", why: "A large page is slow on mobile data.", automation: "site_rebuild" } },
      { earned: tri("response_time"), points: 20, fix: { key: "response_time_check", title: "Server response time", why: "Hosting adds delay before anything loads.", automation: "site_rebuild" } },
    ],
    perf !== null ? "Fast enough on a phone." : "The server answers quickly. Google's phone test was not available for this scan, so only the server side is measured.",
  );

  const trust = pillar(
    "trust",
    [
      { earned: tri("https"), points: 25, fix: { key: "https", title: "Secure HTTPS address", why: "Browsers warn visitors on an insecure page.", automation: "site_rebuild" } },
      { earned: tri("structured_data"), points: 20, fix: { key: "structured_data", title: "Structured business data", why: "Schema.org tells Google your name, hours and area; without it the knowledge panel guesses.", automation: "local_seo_setup" } },
      { earned: s ? s.copyright_year !== null && yearNow - s.copyright_year <= 1 : null, points: 15, fix: { key: "copyright", title: "Footer year is stale", why: "A footer years behind reads as an abandoned business.", automation: "site_rebuild" } },
      { earned: tri("social_links"), points: 15, fix: { key: "social_links", title: "Linked social profiles", why: "Visitors check that the business is alive elsewhere.", automation: "content_system" } },
      { earned: tri("analytics"), points: 15, fix: { key: "analytics", title: "Visitor analytics", why: "Without measurement, no change can be proved to work.", automation: "analytics_setup" } },
      { earned: s ? s.phones.length > 0 || s.emails.length > 0 : null, points: 10, fix: { key: "contact_visible", title: "Visible contact details", why: "No phone or email could be read on any page.", automation: "conversion_page" } },
    ],
    "Reads as a real, current business.",
  );

  const findability = pillar(
    "findability",
    [
      seo !== null
        ? { earned: seo >= 80, points: 40, fix: { key: "seo_basics", title: `Search basics (PageSpeed SEO ${seo}/100)`, why: "Titles, descriptions and crawlability are what Google reads first.", automation: "local_seo_setup" } }
        : { earned: tri("title") === false || tri("meta_description") === false ? false : tri("title") === true && tri("meta_description") === true ? true : null, points: 40, fix: { key: "seo_basics", title: "Page title and search description", why: "The two lines Google shows are missing or empty.", automation: "local_seo_setup" } },
      { earned: tri("sitemap"), points: 20, fix: { key: "sitemap", title: "Sitemap", why: "A sitemap tells Google which pages exist.", automation: "local_seo_setup" } },
      { earned: s ? s.h1.length > 0 : null, points: 15, fix: { key: "h1", title: "A headline Google can read", why: "No H1 heading names what the page is about.", automation: "local_seo_setup" } },
      { earned: s && s.images_total > 0 ? s.images_missing_alt / s.images_total <= 0.3 : s ? true : null, points: 15, fix: { key: "alt_text", title: "Image descriptions", why: "Most images have no alt text, so search and screen readers see nothing.", automation: "local_seo_setup" } },
      { earned: tri("mobile_viewport"), points: 10, fix: { key: "mobile_viewport", title: "Set up for phones", why: "The page is not declared mobile-friendly.", automation: "site_rebuild" } },
    ],
    "Google can read and rank it.",
  );

  const reach = pillar(
    "reach",
    [
      { earned: s ? Object.keys(s.socials).length >= 2 : null, points: 30, fix: { key: "social_presence", title: "Two or more active channels", why: "One channel is one point of failure for being found.", automation: "content_system" } },
      { earned: s ? s.blog.found : null, points: 25, fix: { key: "content", title: "Fresh content", why: "No blog or news page: nothing new for search or for returning visitors.", automation: "content_system" } },
      { earned: tri("email_link"), points: 20, fix: { key: "email_link", title: "Email link", why: "No mailto link for the visitor who would rather write.", automation: "lead_form_autoreply" } },
      { earned: s ? s.localities.length > 0 : null, points: 25, fix: { key: "locality", title: "Service area named", why: "No city or region is named, so local search cannot place you.", automation: "local_seo_setup" } },
    ],
    "Reaches the people who are already looking.",
  );

  const groups = [conversion, speed, trust, findability, reach];
  const pillars = groups.map((g) => g.pillar);
  // The total is over the pillars that could be scored, re-weighted to 100. An unread site, a site
  // whose pages carried no readable text, or one where under half the weight could be scored, has
  // no total: "0" would claim everything is broken, and "92" from speed and HTTPS alone would
  // claim a visitor can act on a page nobody could read.
  const scored = pillars.filter((p): p is ScorePillar & { score: number } => p.score !== null);
  const scoredWeight = scored.reduce((a, p) => a + p.weight, 0);
  const total = facts.site.unread || !s || scoredWeight < MIN_SCORED_WEIGHT ? null : clamp(scored.reduce((acc, p) => acc + p.score * p.weight, 0) / scoredWeight);
  // With no total, a "+N points" has nothing to add to, so no fix is priced (or listed).
  const fixes = (total === null ? [] : groups.flatMap((g) => g.candidates))
    .map((f) => ({ ...f, impact: Math.round((f.impact * 100) / scoredWeight) }))
    .sort((a, b) => b.impact - a.impact || a.title.localeCompare(b.title))
    .filter((f, i, arr) => arr.findIndex((x) => x.key === f.key) === i)
    .slice(0, 3)
    .map(({ key, title, why, automation, impact }) => ({ key, title, why, automation, impact }));

  return { schema: SCORE_SCHEMA, total, pillars, fixes };
}
