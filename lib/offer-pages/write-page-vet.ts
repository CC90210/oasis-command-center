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
 *
 * Server only: claims.ts hashes sentences with node:crypto, so this file must
 * never be imported by a component (write-page.ts and write-page-client.ts
 * are the browser-safe halves). ASCII only (tests/worker-source-one-byte).
 */
import { claimReasons } from "./claims";
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
  // A figure, with its unit when it has one: the owner's "14 templates" does
  // not let "live in 14 days" through, while a bare "24/7" matches as numbers.
  { re: /\d+(?:[.,]\d+)*(?:\s*(?:%|(?:percent|x|times|minutes?|hours?|days?|weeks?|months?|years?)(?![A-Za-z])))?/gi },
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
 * The kinds of claim a sentence makes, as the publish linter names them, with
 * the matched words dropped ("a promised result", not 'a promised result
 * ("more leads")'). The linter's single claim words (`the word "booked"`) are
 * left to CLAIM_PATTERNS, which checks the ones that promise something phrase
 * by phrase: "booked" alone is how a booking page talks, not a claim to vet.
 */
function claimKinds(text: string): Set<string> {
  return new Set(
    claimReasons(text)
      .map((reason) => reason.replace(/\s*\(.*$/, ""))
      .filter((kind) => !kind.startsWith("the word")),
  );
}

/**
 * True when `text` states something `source` (everything the owner typed:
 * names, description, audience) does not: a CLAIM_PATTERNS match the source
 * does not state as whole words (sourceStates), or a kind of claim the
 * publish linter sees in it that it never sees in the source.
 */
export function inventsFacts(text: string, source: string): boolean {
  if (!text) return false;
  if (CLAIM_PATTERNS.some(({ re, stem }) => (text.match(re) ?? []).some((m) => !sourceStates(source, m, stem === true)))) {
    return true;
  }
  const owned = claimKinds(source);
  return [...claimKinds(text)].some((kind) => !owned.has(kind));
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
