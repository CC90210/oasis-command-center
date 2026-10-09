/**
 * lib/tools/worker/score-hook.ts - "Score a hook": a TypeScript port of the
 * marketing team's deterministic hook scorer, TEXT MODE ONLY.
 *
 * Source: CMO-Agent scripts/hook_scorer.py (SCORER_VERSION 1.0.0, weights file
 * version 0 = DEFAULT_WEIGHTS) and the opener patterns it imports from
 * scripts/slice_longform_video.py. Line numbers below are those files at
 * 484c223. No model, no AI account, no network: the same text always scores the
 * same, in a few milliseconds.
 *
 * Parity: tests/fixtures/tools/hook-scorer-parity.json was recorded from the
 * Python CLI (`hook_scorer.py score --text ... [--caption ...] --json`, no
 * --persist) and tests/tools-worker.test.ts holds this port to it.
 *
 * NOT PORTED, on purpose:
 *   - foreign_handle (:371-376, :410-411): needs the marketing team's
 *     BRANDS.json, OASIS-only data; a hook with another brand's @handle is not
 *     hard-failed here;
 *   - video and carousel modes, transcripts, recent-hooks monotony, give_ask,
 *     calibration and the three-reader judge: text mode never reaches them
 *     (their features are "not applicable" there and never enter the score);
 *   - the labels other than hook_type (kallaway, STEPPS, awareness, cta_type):
 *     nothing on the card shows them.
 *
 * REGEX FLAVOUR. Python's \b and \w are Unicode-aware and JavaScript's are
 * ASCII, so the two agree exactly on ASCII text (the fixture) and can differ
 * at a word boundary next to an accented letter. Python's round() rounds the
 * exact binary value half-to-even: pyRound below does the same, so a score on a
 * threshold rounds the way the Python does.
 */

export const SCORER_LABEL = "hook_scorer 1.0.0 text-mode port";

// --- weights (hook_scorer.py:74-80; data/performance/hook_weights.json version 0) ---------
const WEIGHTS: Record<string, number> = {
  callout: 2.0,
  specificity: 1.5,
  news_values: 1.5,
  contrast: 1.5,
  for_you: 1.0,
  plain_language: 1.0,
  hook_length: 1.0,
  acronyms_defined: 0.5,
  retain_structure: 0.5,
  retain_delivery: 0.5,
  give_ask: 0.5,
  end_on_payoff: 0.5,
  cut_rate: 0.25,
  dead_air: 0.25,
  hook_type_monotony: -1.0,
  pattern_score: 0.25,
};

// --- regex table (hook_scorer.py:84-189) ---------------------------------------------------
const PREAMBLE_RE =
  /^(hey|hi|hello|what'?s up|welcome( back)?|so,? today|today (i|we)|in this video|my name is|before we (start|begin)|don'?t forget to)\b/i;
const AUDIENCE_NOUNS = [
  "owners?", "founders?", "coaches", "coach", "agencies", "agency", "creators?", "marketers?",
  "entrepreneurs?", "dentists?", "clinics?", "contractors?", "realtors?", "agents?",
  "freelancers?", "consultants?", "operators?", "managers?", "professionals?",
  "solopreneurs?", "plumbers?", "lawyers?", "accountants?", "landlords?", "restaurants?",
  "salons?", "gyms?", "trades", "tradespeople", "ceos?", "small business(es)?",
  "business owners?", "clients?", "customers?", "teams?", "employees?", "bosses", "boss",
];
const AUDIENCE_RE = new RegExp(`\\b(${AUDIENCE_NOUNS.join("|")})\\b`, "i");
const CALLOUT_RE = /\bif you('re| are| have| make| run| own)?\b/i;
const SPECIFICITY_RE =
  /(\d|\$|%|\bx\d|\d+x\b|\b(today|tonight|yesterday|tomorrow|this (week|month|year)|last (week|month|year)|in \d+ (days?|weeks?|months?|years?|minutes?|hours?)|\d+ (days?|weeks?|months?|years?|minutes?|hours?|seconds?))\b)/i;
const NEWS_VALUES = ["recency", "relevancy", "celebrity", "proximity", "conflict", "unusual", "ongoing"] as const;
const NEWS_RE: Record<string, RegExp | null> = {
  recency: /\b(today|yesterday|just|this (week|month|year)|new|20\d\d|breaking|right now|tonight)\b/i,
  relevancy: null, // audience label or "if you" (AUDIENCE_RE / CALLOUT_RE)
  celebrity: null, // a named person or company: the proper-noun heuristic below
  proximity:
    /\b(near you|in (your|my) (city|town|area|street|office|shop|clinic)|local|down the (road|street)|next door|collingwood|ontario|toronto|canada)\b/i,
  conflict: /\b(vs\.?|versus|wrong|lie|lies|mistake|myth|fight|stop|never|against|quit|kill|broken|problem)\b/i,
  unusual:
    /\b(weird|strange|nobody|no one|secret|banned|crazy|only|first ever|most|biggest|worst|best|hardest|#1|number one|nothing|every|everyone)\b/i,
  ongoing: /\b(still|part \d+|update|day \d+|week \d+|continues?|again|every (day|week|morning|month))\b/i,
};
const PROPER_NOUN_RE = /(?<![.!?]\s)(?<!^)\b[A-Z][a-z]{2,}\b/g;
const CONTRAST_RE = /\b(but|however|instead|actually|except|yet|although|vs\.?|versus|stop|wrong|myth|lie|nobody|everyone thinks)\b/i;
const YOU_RE = /\b(you|your|yours|yourself)\b/gi;
const ME_RE = /\b(i|me|my|mine|we|our|ours|us)\b/gi;
const ACRONYM_RE = /\b[A-Z]{2,5}s?\b/g;
const ACRONYM_KNOWN = new Set(["AI", "DM", "DMS", "OK", "OASIS", "CEO", "USA", "UK", "TV", "PS", "FAQ", "VS"]);
const HASHTAG_RE = /(?<!\w)#\w+/g;
const PROMISE_N_RE =
  /\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(ways|reasons|things|steps|mistakes|signs|rules|tips|lessons|questions|habits|tools|systems|calls|hours|minutes|days)\b/i;

// hook type classifiers (:142-153)
const T_CONDITIONAL = /^\s*(if|unless)\b/i;
const T_COMMAND = /^\s*(stop|start|do|don'?t|never|always|try|watch|listen|use|quit|make|get)\b/i;
const T_LIST = /^\s*(\d+|two|three|four|five|six|seven|eight|nine|ten)\b/i;
const T_NARRATIVE = /^\s*(i|we|my|when i|last (year|week|month)|yesterday|in 20\d\d|\d+ years ago)\b/i;
const T_LABEL = new RegExp(`^\\s*(?:[\\w'-]+\\s+){0,3}?(?:${AUDIENCE_NOUNS.join("|")})\\s*[,:]`, "i");

// opener patterns (slice_longform_video.py:84-95), and the number test (:102)
const HOOK_PATTERNS: Array<[RegExp, number]> = [
  [/^\s*(here'?s|this is)\s+(why|how|what|the)\b/i, 3.0], // result-forward
  [/^\s*(stop|never|don'?t|quit)\b/i, 3.0], // mistake/loss
  [/^\s*(most|everyone|nobody|no one)\b/i, 2.5], // bold-contradiction
  [/^\s*(the (biggest|number one|#1|hardest|worst))\b/i, 2.5], // superlative-callout
  [/^\s*(if you|when you|you'?re)\b/i, 2.5], // avatar-callout
  [/^\s*(what nobody|what no one|nobody tells)\b/i, 3.0], // curiosity-gap
  [/^\s*(i (used to|spent|tried|thought|remember))\b/i, 2.0], // mid-action-open
  [/\?\s*$/, 1.5], // question
  [/^\s*(so|and|but|because|which|also|then|anyway)\b/i, -3.0], // continuation
  [/^\s*(that'?s why|like i said|as i mentioned|again,)\b/i, -4.0], // back-reference
];
const NUMBER_RE = /\b\d[\d,.]*\b/;

// --- helpers --------------------------------------------------------------------------------

/**
 * Python's round(x, n): the exact binary value of x, rounded half-to-even at n
 * decimals. Math.round(x * 10^n) is not that: the multiply can move a value
 * across the half, and it rounds ties up.
 */
export function pyRound(x: number, n: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const neg = x < 0;
  const exact = Math.abs(x).toFixed(Math.min(100, n + 30));
  const [intPart, frac = ""] = exact.split(".");
  const kept = frac.slice(0, n);
  const rest = frac.slice(n);
  let up: boolean;
  if (rest[0] > "5") up = true;
  else if (rest[0] < "5") up = false;
  else if (/[1-9]/.test(rest.slice(1))) up = true;
  else {
    const last = n > 0 ? Number(kept[n - 1]) : Number(intPart[intPart.length - 1]);
    up = last % 2 === 1;
  }
  let digits = BigInt(intPart + kept);
  if (up) digits += BigInt(1);
  const s = digits.toString().padStart(n + 1, "0");
  const value = Number(n > 0 ? `${s.slice(0, s.length - n)}.${s.slice(s.length - n)}` : s);
  return neg ? -value : value;
}

/** Python str.split() with no argument: whitespace runs, no empty strings. */
const splitWords = (t: string) => t.split(/\s+/).filter(Boolean);

/** :228-233 */
export function sentences(text: string): string[] {
  const t = (text || "").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return [];
  return t
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** :236-237 */
export function words(text: string): string[] {
  return (text || "").match(/[A-Za-z0-9'$%]+/g) ?? [];
}

/** :240-249 */
export function syllables(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  w = w.replace(/^y/, "");
  const groups = w.match(/[aeiouy]{1,2}/g) ?? [];
  return Math.max(1, groups.length);
}

/** :252-262 - (grade, mean words per sentence), both rounded as the Python rounds them. */
export function fleschKincaid(text: string): [number, number] {
  const sents = sentences(text);
  const list = sents.length ? sents : [text || ""];
  const ws = list.flatMap((s) => words(s));
  if (!ws.length) return [0, 0];
  const syl = ws.reduce((n, w) => n + syllables(w), 0);
  const wps = ws.length / Math.max(1, list.length);
  const grade = 0.39 * wps + 11.8 * (syl / ws.length) - 15.59;
  return [pyRound(grade, 2), pyRound(wps, 2)];
}

/** :265-266 */
const firstWords = (text: string, n: number) => words(text).slice(0, n).join(" ");

/** :272-293 - opener-shaped types win over terminal punctuation. */
export function classifyHookType(hook: string): string {
  const h = (hook || "").trim().replace(/\n/g, " ");
  if (!h) return "statement";
  const head = splitWords(h).slice(0, 5).join(" ");
  if (T_CONDITIONAL.test(h)) return "conditional";
  if (T_LABEL.test(head)) return "label";
  if (T_COMMAND.test(h)) return "command";
  if (T_LIST.test(h)) return "list";
  if (T_NARRATIVE.test(h)) return "narrative";
  if (h.trimEnd().endsWith("?")) return "question";
  if (h.trimEnd().endsWith("!")) return "exclamation";
  return "statement";
}

/** :296-314 - which of the seven news values the hook carries. */
export function newsValues(hook: string): string[] {
  const h = (hook || "").replace(/\n/g, " ");
  const out: string[] = [];
  for (const name of NEWS_VALUES) {
    let hit: boolean;
    if (name === "relevancy") hit = AUDIENCE_RE.test(h) || CALLOUT_RE.test(h);
    else if (name === "celebrity") {
      // A capitalised word that is not sentence-initial and not an acronym.
      hit = [...h.matchAll(PROPER_NOUN_RE)].some((m) => {
        const start = m.index ?? 0;
        const before = h.slice(Math.max(0, start - 2), start).replace(/^ +| +$/g, "");
        return m[0].toUpperCase() !== m[0] && start > 0 && ![".", "!", "?", ""].includes(before);
      });
    } else hit = (NEWS_RE[name] as RegExp).test(h);
    if (hit) out.push(name);
  }
  return out;
}

/** :325-334 */
export function retainStructure(text: string): string {
  const t = (text || "").replace(/\n/g, " ");
  if (PROMISE_N_RE.test(t) || /^\s*\d+[.)]\s/m.test(t)) return "list";
  if (/\b(step \d|first,|then,|next,|finally|how to|step one|step by step)\b/i.test(t)) return "steps";
  if (/\b(i|we|my)\b.*\b(was|were|had|went|spent|tried|remember|ago)\b/i.test(t)) return "story";
  return "none";
}

/** slice_longform_video.py:172-189 - the opener's own score. */
export function patternScore(text: string): number {
  let score = 0;
  for (const [re, weight] of HOOK_PATTERNS) if (re.test(text)) score += weight;
  const n = splitWords(text).length;
  if (n >= 4 && n <= 18) score += 1.0;
  else if (n < 4) score -= 1.5;
  if (NUMBER_RE.test(text)) score += 1.0;
  return score;
}

const count = (re: RegExp, text: string) => (text.match(re) ?? []).length;

/** The feature table, text mode (:379-510): 1 satisfied, 0 not, null not applicable. */
function textFeatures(hookIn: string, caption: string) {
  const hook = (hookIn || "").trim();
  const flat = hook.replace(/\n/g, " ");
  const hard: string[] = [];
  const feat: Array<[string, number | null]> = [];
  const sents = sentences(flat);
  const firstTwo = sents.length ? sents.slice(0, 2).join(" ") : flat;
  const firstThree = sents.length ? sents.slice(0, 3).join(" ") : flat;
  const nWords = words(flat).length;

  // hard-fails (:400-411; video-only rules and foreign_handle not ported)
  if (PREAMBLE_RE.test(firstWords(flat, 12))) hard.push("preamble");
  if (count(HASHTAG_RE, caption || "") > 5) hard.push("hashtags");

  // warn / label features (:414-487), in the Python's insertion order
  feat.push(["callout", Number(CALLOUT_RE.test(firstWords(flat, 8)) || AUDIENCE_RE.test(firstWords(flat, 5)))]);
  feat.push(["specificity", Number(SPECIFICITY_RE.test(sents.length ? sents[0] : flat))]);
  feat.push(["news_values", Number(newsValues(flat).length >= 2)]);
  feat.push(["contrast", Number(CONTRAST_RE.test(firstTwo))]);
  feat.push(["for_you", Number(count(YOU_RE, firstThree) >= count(ME_RE, firstThree))]);
  const [grade, wps] = fleschKincaid(flat);
  feat.push(["plain_language", Number(grade <= 5.0 && wps <= 15.0)]);
  feat.push(["hook_length", Number(nWords <= 14)]);
  const textAll = [flat, caption].filter(Boolean).join(" ");
  const alpha = words(textAll).filter((w) => /[A-Za-z]/.test(w));
  const capsShare = alpha.length ? alpha.filter((w) => w.toUpperCase() === w).length / alpha.length : 0;
  const undefinedAcronyms: string[] = [];
  // Heavy-caps display copy: every short word would read as an acronym (:434-437).
  if (capsShare <= 0.5) {
    for (const m of textAll.matchAll(ACRONYM_RE)) {
      const acr = m[0];
      if (ACRONYM_KNOWN.has(acr.replace(/s+$/, "")) || ACRONYM_KNOWN.has(acr)) continue;
      const end = (m.index ?? 0) + acr.length;
      const window = textAll.slice(end, end + 160);
      if (!/\(|stands for|means|=|\bis short for\b|:\s/.test(window.slice(0, 120))) undefinedAcronyms.push(acr);
    }
  }
  feat.push(["acronyms_defined", Number(undefinedAcronyms.length === 0)]);
  feat.push(["retain_structure", Number(retainStructure(flat) !== "none")]);
  // Not applicable in text mode: nothing delivered, no recent posts, no video.
  for (const name of ["retain_delivery", "give_ask", "hook_type_monotony", "end_on_payoff", "cut_rate", "dead_air"]) {
    feat.push([name, null]);
  }
  feat.push(["pattern_score", patternScore(flat)]);
  return { hard, feat, hookType: classifyHookType(hook) };
}

/** :516-530 - the weighted sum and its maximum; pattern_score's maximum is weight x 5. */
function applyWeights(feat: Array<[string, number | null]>): [number, number] {
  let total = 0;
  let maximum = 0;
  for (const [name, value] of feat) {
    if (value === null || !(name in WEIGHTS)) continue;
    const w = WEIGHTS[name];
    if (name === "pattern_score") {
      total += w * value;
      maximum += w * 5.0;
      continue;
    }
    total += w * value;
    if (w > 0) maximum += w;
  }
  return [pyRound(total, 3), pyRound(maximum, 3)];
}

const WARN_ORDER = [
  "callout", "specificity", "news_values", "contrast", "for_you", "plain_language", "hook_length",
  "acronyms_defined", "retain_structure", "retain_delivery", "give_ask", "end_on_payoff", "cut_rate", "dead_air",
];

/** :533-545, the sentences verbatim. */
function suggestionsFor(f: Map<string, number | null>): string[] {
  const out: string[] = [];
  if (f.get("callout") === 0) out.push('name the reader in the first 8 words ("if you run a ..." or the audience noun)');
  if (f.get("specificity") === 0) out.push("put one exact number, $ or timeframe in the first sentence");
  if (f.get("contrast") === 0) out.push("give the first two sentences a turn (but / instead / stop / wrong)");
  if (f.get("news_values") === 0) out.push("borrow a second news value (recency, conflict, unusual, ongoing ...)");
  if (f.get("for_you") === 0) out.push("more you/your than I/we in the opening three sentences");
  return out.slice(0, 3);
}

export type HookScore = {
  score: number;
  max_score: number;
  score_pct: number;
  passed: boolean;
  hard_fails: string[];
  warns: string[];
  hook_type: string;
  suggestions: string[];
  scorer: string;
};

/** hook_scorer.score(text, caption=...) in text mode (:548-621), the fields the card shows. */
export function scoreHook(hook: string, caption = ""): HookScore {
  const { hard, feat, hookType } = textFeatures(hook, caption);
  const [total, maximum] = applyWeights(feat);
  const byName = new Map(feat);
  const warns = WARN_ORDER.filter((n) => byName.get(n) === 0);
  if (byName.get("hook_type_monotony") === 1) warns.push("hook_type_monotony");
  const passed = hard.length === 0;
  return {
    score: passed ? total : 0,
    max_score: maximum,
    score_pct: !passed || maximum <= 0 ? 0 : pyRound(Math.max(0, Math.min(1, total / maximum)) * 100, 1),
    passed,
    hard_fails: hard,
    warns,
    hook_type: hookType,
    suggestions: suggestionsFor(byName),
    scorer: SCORER_LABEL,
  };
}

export type ScoreHookInput = { hook: string; caption: string };

/** The executor: never fails (a hook that cannot score is refused by the validator first). */
export async function runScoreHook(input: ScoreHookInput): Promise<{ ok: true; result: HookScore }> {
  return { ok: true, result: scoreHook(input.hook, input.caption) };
}
