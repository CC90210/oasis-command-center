/**
 * "Write my page": the never-invent rule, in code (server only).
 *
 * The prompt (write-page.ts) tells the model never to state a fact the owner
 * did not give, but a prompt is a request. So the route vets the model's copy
 * (vetWrittenCopy) before anything saves it or sends it to the editor: a
 * sentence that states something the owner's own words do not is left out.
 * Three checks, all against everything the owner typed (names, description,
 * audience), each phrase compared as whole words:
 *
 * - The publish linter's own claim phrases (claims.ts claimPhrases): every
 *   money amount, percentage, multiplier, number, promised result,
 *   superlative, "who else uses it", time frame and instant promise the
 *   sentence states must be stated by the owner too. ONE list: when the
 *   linter learns a claim, it is grounded here as well.
 * - EXTRA_PATTERNS, for what the linter does not flag on its own or flags too
 *   broadly to ground: a figure bound to what it counts, spelled-out counts of
 *   anything, bare "best" and "leading", the claim words (guarantee, proven,
 *   ROI...), integrations and compliance, and a zero price.
 * - Names (namesIn): a brand, product, integration or certification the
 *   sentence names must be named in the owner's words ("Integrates with
 *   Salesforce", "HIPAA compliant").
 *
 * What it cannot catch, by design:
 * - an ordinary sentence describing something the offer does not do, in plain
 *   words with no figure, claim or name;
 * - a brand spelled like an ordinary word at the very start of a sentence
 *   with no integration verb ("Stripe handles every payment"): without a
 *   dictionary, its capital looks like any first word's. Integration words
 *   (integrates, syncs, works with...) are caught wherever the name stands.
 * Nothing keyword based can close these; that is why the page stays a draft
 * the owner reads through, and the screens say so, before Publish.
 *
 * Server only: claims.ts hashes sentences with node:crypto, so this file must
 * never be imported by a component (write-page.ts and write-page-client.ts
 * are the browser-safe halves). ASCII only (tests/worker-source-one-byte).
 */
import { claimPhrases, sentencesOf } from "./claims";
import { cleanCopy, type WrittenCopy } from "./write-page";

type Head = Pick<WrittenCopy["book"], "title" | "lede">;
type Card = WrittenCopy["obstacles"]["items"][number];

/**
 * What the publish linter does not ground on its own. Each match must appear,
 * as written and as whole words, in the owner's words; a `stem` match
 * ("guarantee" in "guaranteed") may run on into a longer word in the source,
 * so the owner's "guaranteed" covers the model's "guarantee".
 */
const EXTRA_PATTERNS: ReadonlyArray<{ re: RegExp; stem?: true }> = [
  // A figure, with what it counts (and a describing word before that: "14
  // happy clinics"): the owner's "14 templates" lets neither "live in 14
  // days" nor "trusted by 14 clinics" through. (The linter's number phrase
  // is the figure alone.) "24/7" and the like are one token; a hyphen joins
  // too ("a 14-day setup" is compared as "14-day").
  {
    re: /\d+\/\d+|\d+(?:[.,]\d+)*(?:[\s-]*(?:%|(?:(?:happy|new|more|active|loyal|satisfied|paying|real|qualified|local|small|extra|repeat|returning|verified|five-star)[\s-]+)?[A-Za-z]+))?/gi,
  },
  // A spelled-out count of anything ("three clinics", "five steps"); the
  // linter counts only what a client could hold us to. ("One" is left out:
  // "one place", "one call" are prose, not counts.)
  { re: /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+[a-z]+/gi },
  // Time frames in more shapes than the linter's ("one week", "a few days", "in minutes").
  { re: /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|ninety|a|an|a few|a couple of|several)\s+(?:minute|hour|day|week|month|year)s?\b/gi },
  { re: /\b(?:within|in under|in less than|under|less than|in just|in only|in)\s+(?:minutes|hours|days|weeks|months)\b/gi },
  // Superlatives the linter reads only with "the" or "our" ("the best"): bare ones too.
  { re: /\bbest\b/gi },
  { re: /\b(?:industry[- ])?leading\b/gi },
  { re: /\bunrivall?ed\b|\bno\.\s?1\b/gi },
  // The claim words. The linter flags them, but as words to tick, not phrases
  // to ground ("booked" is how a booking page talks): these are the ones that
  // promise something, and stems where the owner's word may run on.
  { re: /\baward/gi, stem: true },
  { re: /\bguarantee/gi, stem: true },
  { re: /\btestimonial/gi, stem: true },
  { re: /\bproven\b/gi },
  { re: /\brisk[- ]free\b|\bmoney[- ]back\b/gi },
  { re: /\b(?:roi|profits?|profitable|savings?|refunds?|refunded)\b/gi },
  // What the offer connects to, and what it is certified for: an integration
  // or a compliance the owner did not state is a capability a buyer holds
  // them to, whether or not a product is named ("Salesforce syncs every
  // booking" starts with its name, where a capital proves nothing).
  { re: /\bintegrat/gi, stem: true },
  { re: /\bsync/gi, stem: true },
  { re: /\bplugs? (?:into|in)\b|\bworks with\b|\bpowered by\b|\bbuilt on\b/gi },
  { re: /\bcompliant\b|\bcompliance\b|\bcertified\b|\bcertification/gi },
  // A zero price is a price ("Book a free consultation"). Narrow on purpose:
  // "free up your time" and "hands-free" are not offers.
  {
    re: /\bfree\s+(?:consultations?|consults?|calls?|audits?|trials?|set-?ups?|demos?|assessments?|reviews?|sessions?|quotes?|estimates?|strategy|plans?|months?|weeks?|onboarding)\b|\bfor free\b|\bfree of charge\b|\bno[- ]cost\b|\bcomplimentary\b|\bat no (?:charge|cost)\b/gi,
  },
];

/** True when `source` holds `phrase` as whole words (a stem may run on into a longer word). */
function sourceStates(source: string, phrase: string, stem: boolean): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word edges only where the phrase itself starts or ends with a letter or
  // digit: "leading" is not found in "misleading", while "$" or "40%" are
  // found where they stand.
  const before = /^[a-z0-9]/i.test(phrase) ? "(?<![a-z0-9])" : "";
  const after = !stem && /[a-z0-9]$/i.test(phrase) ? "(?![a-z0-9])" : "";
  return new RegExp(before + escaped + after, "i").test(source);
}

/** Acronyms that name a kind of thing, not a product, standard or certification. */
const GENERIC_ACRONYMS = new Set(["AI", "CRM", "SMS", "FAQ", "DM", "SEO", "API", "URL", "PDF", "CEO", "B2B", "B2C", "IT", "HR", "VIP", "OK", "TV", "PM", "AM", "UI", "UX", "SOP", "KPI", "CTA", "DIY"]);

/**
 * The names a sentence states (brands, products, integrations, standards):
 * a capitalised word that does not start the sentence ("Integrates with
 * Salesforce"), a product's own spelling anywhere ("HubSpot", "Office365"),
 * or an acronym that is not a generic one ("HIPAA"). A heading in Title Case
 * capitalises every word, so there only those last two count.
 */
function namesIn(text: string): string[] {
  const words = text.match(/[A-Za-z][A-Za-z0-9'&.-]*/g) ?? [];
  const long = words.filter((w) => w.length > 3);
  const titleCase = long.length > 1 && long.filter((w) => /^[A-Z]/.test(w)).length / long.length >= 0.6;
  const names: string[] = [];
  // No "." inside a word: "No. It is" must leave the full stop for "It" to start a sentence.
  for (const m of text.matchAll(/(^|[.!?:]\s+|\s)([A-Z][A-Za-z0-9'&-]*)/g)) {
    // "AI-powered" names "AI"; "Salesforce-ready" names "Salesforce".
    const word = m[2].split("-")[0].replace(/'+$/, "");
    const startsSentence = m.index === 0 || /[.!?:]\s+$/.test(m[1]);
    if (/^[A-Z0-9&]{2,}s?$/.test(word)) {
      // Plural acronyms ("APIs", "SOPs", "DMs") name the same kind of thing.
      if (!GENERIC_ACRONYMS.has(word.replace(/s$/, ""))) names.push(word);
    } else if (/[a-z][A-Z]|[A-Za-z][0-9]/.test(word)) {
      // A product's own spelling ("HubSpot", "QuickBooks", "Office365") is a
      // name wherever it stands, at a sentence's start or in a heading too.
      names.push(word);
    } else if (!startsSentence && !titleCase && word.length > 1) {
      // (A single letter is "I" or a label like "Plan A", never a name.)
      names.push(word);
    }
  }
  return names;
}

/**
 * True when `text` states something `source` (everything the owner typed:
 * names, description, audience) does not: a claim phrase the publish linter
 * finds in it (claimPhrases; its single claim words are left to
 * EXTRA_PATTERNS), an EXTRA_PATTERNS match, or a name (namesIn) that the
 * source does not state as whole words (sourceStates).
 */
export function inventsFacts(text: string, source: string): boolean {
  if (!text) return false;
  if (claimPhrases(text).some(({ kind, phrase }) => kind !== "word" && !sourceStates(source, phrase, false))) return true;
  if (EXTRA_PATTERNS.some(({ re, stem }) => (text.match(re) ?? []).some((m) => !sourceStates(source, m, stem === true)))) {
    return true;
  }
  return namesIn(text).some((name) => !sourceStates(source, name, false));
}

/**
 * The model's copy with every sentence cleaned, and every one that invents a
 * fact (inventsFacts against `source`) left out and counted in `withheld`.
 * The route runs this before the copy is saved or sent to the editor, so
 * nothing downstream sees an invented fact.
 */
export function vetWrittenCopy(written: WrittenCopy, source: string): { copy: WrittenCopy; withheld: number } {
  let withheld = 0;
  // Sentence by sentence: a card body or subheadline keeps its grounded
  // sentences when one beside them invents something.
  const vet = (value: string | undefined): string => {
    const text = cleanCopy(value, Number.MAX_SAFE_INTEGER);
    if (!text) return text;
    const kept = sentencesOf(text).filter((sentence) => {
      if (!inventsFacts(sentence, source)) return true;
      withheld += 1;
      return false;
    });
    return kept.join(" ");
  };
  const head = (h: Head): Head => ({ title: vet(h.title), lede: vet(h.lede) });
  const cards = (items: Card[]): Card[] => items.map((it) => ({ title: vet(it.title), body: vet(it.body) }));
  const copy: WrittenCopy = {
    hero: {
      eyebrow: vet(written.hero.eyebrow),
      headline: vet(written.hero.headline),
      subheadline: vet(written.hero.subheadline),
      cta_label: vet(written.hero.cta_label),
    },
    obstacles: { ...head(written.obstacles), items: cards(written.obstacles.items) },
    what_you_get: { ...head(written.what_you_get), items: cards(written.what_you_get.items) },
    work: { ...head(written.work), items: cards(written.work.items) },
    faq: { ...head(written.faq), items: written.faq.items.map((it) => ({ q: vet(it.q), a: vet(it.a) })) },
    book: head(written.book),
    seo: { title: vet(written.seo.title), description: vet(written.seo.description) },
  };
  return { copy, withheld };
}
