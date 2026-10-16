/**
 * "Write my page": the never-invent rule, in code (server only).
 *
 * The prompt (write-page.ts) tells the model never to state a fact the owner
 * did not give, but a prompt is a request. So the route vets the model's copy
 * (vetWrittenCopy) before anything saves it or sends it to the editor: a
 * sentence that states something the owner's own words do not is left out.
 * Two checks, both against everything the owner typed (names, description,
 * audience):
 *
 * - CLAIM_PATTERNS, phrase by phrase: every figure (with its unit), money
 *   amount, spelled-out count, time frame and claim word the sentence states
 *   must appear in the owner's words, as whole words.
 * - The publish linter's own claim kinds (claims.ts claimReasons), kind by
 *   kind: a sentence making a kind of claim the owner's words never make (a
 *   superlative, a promised result, money...) is left out. So every claim
 *   kind the linter learns is grounded here too, with no second list to keep.
 * - Names (namesIn): a brand, product, integration or certification the
 *   sentence names must be named in the owner's words ("Integrates with
 *   Salesforce", "HIPAA compliant").
 *
 * What it cannot catch: an ordinary sentence describing something the offer
 * does not do, in plain words with no figure, claim or name. Nothing keyword
 * based can; that is why the page stays a draft the owner reads through, and
 * the screens say so, before Publish.
 *
 * Server only: claims.ts hashes sentences with node:crypto, so this file must
 * never be imported by a component (write-page.ts and write-page-client.ts
 * are the browser-safe halves). ASCII only (tests/worker-source-one-byte).
 */
import { claimReasons, sentencesOf } from "./claims";
import { cleanCopy, type WrittenCopy } from "./write-page";

type Head = Pick<WrittenCopy["book"], "title" | "lede">;
type Card = WrittenCopy["obstacles"]["items"][number];

/**
 * Each match must appear, as written and as whole words, in the owner's words.
 * Matching the phrase, not the family, means "two weeks" in the description
 * does not let "one week" through. A `stem` match ("guarantee" in
 * "guaranteed") may run on into a longer word in the source, so the owner's
 * "guaranteed" covers the model's "guarantee".
 */
const CLAIM_PATTERNS: ReadonlyArray<{ re: RegExp; stem?: true }> = [
  // A figure, with what it counts: the owner's "14 templates" lets neither
  // "live in 14 days" nor "trusted by 14 clinics" through. "24/7" and the
  // like are one token, matched as written.
  { re: /\d+\/\d+|\d+(?:[.,]\d+)*(?:\s*(?:%|[A-Za-z]+))?/gi },
  { re: /[$%]/g },
  // A money amount is one claim: the owner's "99 clients" and "$50" do not let "$99" through.
  { re: /\$\s?\d+(?:[.,]\d+)*/g },
  { re: /\d+(?:[.,]\d+)*\s?(?:dollars?|bucks|cad|usd|eur|euros?|gbp|pounds?)\b/gi },
  { re: /\bper ?cent\b/gi },
  { re: /\bbest\b/gi },
  { re: /\b(?:industry[- ])?leading\b/gi },
  { re: /\baward/gi, stem: true },
  { re: /\btop[- ]rated\b/gi },
  { re: /\bworld[- ]class\b/gi },
  { re: /\bnumber one\b|#\s?1\b|\bno\.\s?1\b/gi },
  { re: /\bguarantee/gi, stem: true },
  { re: /\bproven\b/gi },
  { re: /\bunmatched\b|\bunbeatable\b|\bunrivall?ed\b/gi },
  { re: /\b(?:fastest|cheapest|largest|biggest|most trusted)\b/gi },
  { re: /\brisk[- ]free\b|\bmoney[- ]back\b/gi },
  { re: /\btestimonial/gi, stem: true },
  // Money a client is promised (the linter's own claim words, phrase by phrase).
  { re: /\b(?:roi|profits?|profitable|savings?|refunds?|refunded)\b/gi },
  // Spelled-out quantities and multipliers.
  { re: /\b(?:dozens?|hundreds?|thousands?|millions?|billions?)\b/gi },
  { re: /\b(?:double|triple|twice|tenfold|halve)[sd]?\b/gi },
  // A spelled-out count of something: "three clinics", "five steps". ("One"
  // is left out: "one place", "one call" are prose, not counts.)
  { re: /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+[a-z]+/gi },
  // Time frames: "one week", "a few days", "within days", "in minutes".
  { re: /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety|a|an|a few|a couple of|several)\s+(?:minute|hour|day|week|month|year)s?\b/gi },
  { re: /\b(?:within|in under|in less than|under|less than|in just|in only|in)\s+(?:minutes|hours|days|weeks|months)\b/gi },
  { re: /\b(?:overnight|same[- ]day|next[- ]day)\b/gi },
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

/**
 * The claims the publish linter sees, sentence by sentence (claimReasons reads
 * one sentence: its first match). A promised result keeps its phrase
 * ('a promised result ("more revenue")'), so the owner's "more bookings" does
 * not let "more revenue" through; every other claim is compared by kind. The
 * linter's single claim words (`the word "booked"`) are left to
 * CLAIM_PATTERNS, which checks the ones that promise something phrase by
 * phrase: "booked" alone is how a booking page talks, not a claim to vet.
 */
function claimKinds(text: string): Set<string> {
  return new Set(
    sentencesOf(text)
      .flatMap((sentence) => claimReasons(sentence))
      .filter((reason) => !reason.startsWith("the word"))
      .map((reason) => (reason.startsWith("a promised result") ? reason : reason.replace(/\s*\(.*$/, ""))),
  );
}

/** Acronyms that name a kind of thing, not a product, standard or certification. */
const GENERIC_ACRONYMS = new Set(["AI", "CRM", "SMS", "FAQ", "DM", "SEO", "API", "URL", "PDF", "CEO", "B2B", "B2C", "IT", "HR", "VIP", "OK", "TV", "PM", "AM", "UI", "UX", "SOP", "KPI", "CTA", "DIY"]);

/**
 * The names a sentence states (brands, products, integrations, standards):
 * a capitalised word that does not start the sentence ("Integrates with
 * Salesforce"), or an acronym that is not a generic one ("HIPAA"). A heading
 * in Title Case capitalises every word, so only its acronyms are names.
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
    } else if (!startsSentence && !titleCase && word.length > 1) {
      // (A single letter is "I" or a label like "Plan A", never a name.)
      names.push(word);
    }
  }
  return names;
}

/**
 * True when `text` states something `source` (everything the owner typed:
 * names, description, audience) does not:
 * - a CLAIM_PATTERNS match the source does not state as whole words
 *   (sourceStates);
 * - a kind of claim the publish linter sees in it that it never sees in the
 *   source;
 * - or a name (namesIn) the source never mentions. An integration, brand or
 *   certification the owner did not name is exactly the invention a buyer
 *   would hold them to.
 */
export function inventsFacts(text: string, source: string): boolean {
  if (!text) return false;
  if (CLAIM_PATTERNS.some(({ re, stem }) => (text.match(re) ?? []).some((m) => !sourceStates(source, m, stem === true)))) {
    return true;
  }
  const owned = claimKinds(source);
  if ([...claimKinds(text)].some((kind) => !owned.has(kind))) return true;
  return namesIn(text).some((name) => !sourceStates(source, name, false));
}

/**
 * The model's copy with every sentence cleaned, and every one that invents a
 * fact (inventsFacts against `source`) emptied and counted in `withheld`. The
 * route runs this before the copy is saved or sent to the editor, so nothing
 * downstream sees an invented fact.
 */
export function vetWrittenCopy(written: WrittenCopy, source: string): { copy: WrittenCopy; withheld: number } {
  let withheld = 0;
  const vet = (value: string | undefined): string => {
    const text = cleanCopy(value, Number.MAX_SAFE_INTEGER);
    if (text && inventsFacts(text, source)) {
      withheld += 1;
      return "";
    }
    return text;
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
