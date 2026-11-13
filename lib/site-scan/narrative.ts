/**
 * lib/site-scan/narrative.ts — the Worker's own words for a scan, from facts alone.
 *
 * This is the floor: it renders the moment Tier 0 finishes, so a visitor never waits on the
 * runner to read anything. The runner's template narrative (scripts/site_scan/narrative.py)
 * replaces it with the segments, competitors and prospects it found; a model polish (Tier 2)
 * may rewrite it once more. Every sentence here is built from a stored fact, nothing else.
 */
import type { ScanFacts, ScanNarrative, ScanScore } from "@/lib/site-scan/types";
import { NARRATIVE_SCHEMA } from "@/lib/site-scan/types";

const AUTOMATION_WORDS: Record<string, string> = {
  missed_call_textback: "missed-call text-back",
  lead_form_autoreply: "a form that replies in under a minute",
  booking_and_reminders: "online booking with reminders",
  conversion_page: "a conversion page built around one action",
  site_rebuild: "a fast rebuild of the site",
  local_seo_setup: "a local search setup",
  content_system: "a content system that posts for you",
  analytics_setup: "measurement that shows what works",
};

export function automationWords(key: string): string {
  return AUTOMATION_WORDS[key] ?? key.replace(/_/g, " ");
}

function list(items: string[], max = 4): string {
  const xs = items.slice(0, max);
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/**
 * Where the business is, as a reader says it: "in Hamilton, ON", "in Laval and Montreal". A region
 * code ("ON", "QC", schema.org addressRegion) qualifies its town; it is never listed as a second
 * town ("in Hamilton and ON", seen live 2026-11-12).
 */
export function placePhrase(localities: string[]): string {
  const code = /^[A-Z]{2,3}$/;
  const towns = localities.filter((l) => !code.test(l));
  const region = localities.find((l) => code.test(l));
  if (towns.length === 1) return ` in ${towns[0]}${region ? `, ${region}` : ""}`;
  if (towns.length) return ` in ${list(towns, 2)}`;
  return region ? ` in ${region}` : "";
}

export function baseNarrative(facts: ScanFacts, score: ScanScore): ScanNarrative {
  const s = facts.signals;
  const name = s?.business_name ?? facts.domain;
  const where = s ? placePhrase(s.localities) : "";
  const services = s?.services.length ? ` The site names ${list(s.services, 4)}.` : "";
  // A tagline that ends its own sentence keeps its stop inside the quote: never "years.".
  const tagline = s?.tagline ? ` Its own words: "${s.tagline}"${/[.!?]$/.test(s.tagline) ? "" : "."}` : "";
  const whatYouSell =
    facts.site.unread
      ? `${facts.domain} could not be read (${facts.site.unread.replace(/_/g, " ")}), so this report covers what could be measured from outside.`
      : `${name} presents itself${where} as: ${s?.title ?? facts.domain}.${tagline}${services}`;

  const pricing = s?.pricing_mentioned ? "Prices are shown, which shortens the decision." : "No prices are shown, so every enquiry starts with a cost question.";
  const whoBuys = s
    ? `Visitors arrive on ${facts.site.pages_read} readable page${facts.site.pages_read === 1 ? "" : "s"}, mostly about ${list(s.keywords.slice(0, 5).map((k) => k.term), 5) || "the business"}. ${pricing}`
    : "Who buys from this site could not be read from its pages.";

  const low = score.pillars.filter((p) => p.score !== null).sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0] ?? null;
  const builds = [...new Set(score.fixes.map((f) => automationWords(f.automation)))];
  const fixesLine = score.fixes.length
    ? ` Fixing the ${score.fixes.length === 1 ? "item" : `${score.fixes.length} items`} below is worth about ${score.fixes.reduce((a, f) => a + f.impact, 0)} points${builds.length ? `, through ${list(builds, 3)}` : ""}.`
    : "";
  const fixesIntro =
    score.total === null || !low
      ? "Too little of the site could be read from outside to score it, so no OASIS score is given and no fix is priced."
      : `The score is ${score.total}/100. The weakest area is "${low.label}" at ${low.score}.${fixesLine}`;

  return {
    schema: NARRATIVE_SCHEMA,
    source: "template",
    what_you_sell: whatYouSell,
    who_buys: whoBuys,
    competitors_note: null,
    fixes_intro: fixesIntro,
    email: null,
  };
}
