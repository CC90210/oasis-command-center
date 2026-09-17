/**
 * What makes a drill question a good question, enforced rather than trusted.
 *
 * WHY THIS FILE EXISTS. The first Training release shipped 34 items that were
 * technically correct and useless. Adon's words: "way too vague and very
 * uneducational." He was right, and the reason is nameable: about half the
 * stems could not be answered without reading the options first. "Which costs
 * you less?" is not a question, it is a label on a list.
 *
 * Every rule below is from the item-writing literature, not from taste, so that
 * a disagreement about a question is settled by the rule rather than by whoever
 * feels more strongly. The four most-researched guidelines (option count,
 * negated stems, all/none-of-the-above, and the cover test) are all here.
 *
 *   Rodriguez 2005, meta-analysis of 80 years: three options are optimal.
 *   Haladyna, Downing & Rodriguez 2002: the 31-guideline taxonomy.
 *   Tarrant 2009: only 13.8% of 4-option items had all three distractors
 *     functioning, so most 4-option items are 2-option items in disguise.
 *   Little, Bjork, Bjork & Angello 2012: competitive distractors are where the
 *     learning happens, which is why A7 demands each one be a real rep error.
 *   Roediger & Marsh 2005 / Butler & Roediger 2008: multiple choice WITHOUT
 *     feedback installs the distractors as false knowledge. Feedback reverses
 *     it. That is why A8 makes per-distractor explanation mandatory rather
 *     than encouraged.
 *
 * PURE ON PURPOSE. No imports, exactly like `lib/web-leads/objections/copy-rules.ts`.
 * The trainer runs this in the browser, and the last time a rule module reached
 * for a server helper it dragged `supabase-server` into the client bundle and
 * broke the build. Keep it that way.
 *
 * WHAT THIS CANNOT DO. It cannot tell whether a question is WORTH asking, only
 * whether it is well formed. A perfectly linted question about something no rep
 * needs is still a waste of their morning. That judgment stays human.
 */

// --- shapes ----------------------------------------------------------------

/** A wrong option, and the mistake it represents. */
export type DrillDistractor = {
  text: string;
  /** Shown when the rep picks it. Why THIS one is wrong, not why the right one
   *  is right; those are different sentences and only the first one teaches. */
  whyWrong: string;
  /** The real rep error this option embodies, in a few words. Authoring a
   *  distractor forces naming the mistake it comes from; a distractor nobody
   *  can name a mistake for is one nobody would pick. */
  realError: string;
};

/** The minimum shape the lint needs. The full item type extends this. */
export type LintableItem = {
  id: string;
  stem: string;
  answer: string;
  whyRight: string;
  distractors: readonly DrillDistractor[];
  /** Set only for compliance items whose whole objective is "what not to do".
   *  It exempts the item from A3 and A6 and nothing else. */
  negationIsThePoint?: boolean;
};

// --- thresholds ------------------------------------------------------------

/** Three options, per Rodriguez 2005. Four is tolerated where a fourth genuine
 *  rep error exists; five is refused, because by then at least two are filler. */
export const PREFERRED_OPTION_COUNT = 3;
export const MAX_OPTION_COUNT = 4;

/** The cover test has no clean automated form, so these are its proxies. A
 *  stem this short has never in practice carried enough context to stand on
 *  its own; "Which costs you less?" is four words. */
export const MIN_STEM_WORDS = 8;
export const MIN_STEM_CHARS = 40;

/** A length clue: the key is conspicuously the longest option. Writers
 *  over-qualify the answer they know is right and under-write the others. */
export const LENGTH_CLUE_RATIO = 1.5;

// --- patterns --------------------------------------------------------------

/**
 * Stems that ask which option is WRONG.
 *
 * Deliberately narrow. A blanket /\bnot\b/ would fire on "They ask for
 * something you are not sure we sell", which is a scenario, not a negated stem.
 * What actually hurts is asking the reader to invert: high performers answer as
 * though the stem were positive and get it wrong, and bolding the NOT does not
 * fix it (Chiavaroli 2017). So these match the INVERSION, not the word.
 */
const NEGATED_STEM = [
  /\bwhich\b[^?]{0,40}\bnot\b/i,
  /\bwhich\b[^?]{0,40}\bnever\b/i,
  /\bwhich\b[^?]{0,40}\bavoid\b/i,
  /\bwhich\b[^?]{0,40}\bworst\b/i,
  /\bexcept\b/i,
  /\bleast likely\b/i,
  /\b(is|are) false\b/i,
  /\bshould you not\b/i,
  /\bNOT\b/, // capitalised on purpose: the author knew it was a trap
];

/** Options that are answerable from partial knowledge alone. */
const COMPOUND_OPTION = [
  /\ball of the above\b/i,
  /\bnone of the above\b/i,
  /\bboth [a-d] and [a-d]\b/i,
  /\ba and b\b/i,
  /\beither of the above\b/i,
];

/** Absolutes are a test-taking cue ONLY when they discriminate between
 *  options, which is why the rule below counts them rather than banning them.
 *  Our compliance content legitimately says "never". */
const ABSOLUTE = /\b(always|never|all|none|every|only|must)\b/i;

/**
 * Comparatives with nothing to compare against. This is the single shape that
 * produced the worst of the shipped questions: "Which costs you less?" and
 * "Which problem is the better place to start?" are both unanswerable until the
 * options are visible, which is exactly the failure the cover test names.
 *
 * TWO PROXIES, because neither alone is enough. A stem passes if it either
 * NAMES the comparison ("A or B", "better than", "beat the other") or is long
 * enough to have laid the alternatives out in a preceding clause. The length
 * gate is the coarse backstop: the plain word check alone rejected a perfectly
 * good 24-word stem that described both options in its first sentence.
 */
const BARE_COMPARATIVE = /\b(better|worse|cheaper|faster|more|less|easier|harder)\b/i;
const HAS_REFERENT =
  /\b(than|between|versus|vs\.?|compared|instead of|rather than|other|alternative|or)\b|:/i;
/** Above this, a stem has room to establish its own comparison. */
const COMPARATIVE_CONTEXT_WORDS = 16;

const STOPWORD = new Set([
  "about", "after", "again", "before", "being", "below", "could", "doing", "does",
  "during", "their", "there", "these", "thing", "think", "those", "through", "under",
  "until", "where", "which", "while", "would", "yours", "should", "because", "against",
]);

// --- the lint --------------------------------------------------------------

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

/**
 * Every way `item` breaks an authoring rule, as sentences a person can act on.
 *
 * Returns [] for a clean item. Each message names the rule so a disagreement
 * is about the rule and not about the reviewer.
 */
export function authoringViolations(item: LintableItem): string[] {
  const out: string[] = [];
  const where = item.id || "(unnamed item)";
  const stem = item.stem ?? "";
  const options = [item.answer, ...item.distractors.map((d) => d.text)];

  // --- A1 option count -----------------------------------------------------
  const n = options.length;
  if (n < 2) {
    out.push(`${where}: A1 one option is not a question.`);
  } else if (n > MAX_OPTION_COUNT) {
    out.push(
      `${where}: A1 ${n} options. Three is optimal and four is the ceiling (Rodriguez 2005); ` +
        `past that at least one is filler nobody picks.`,
    );
  }

  // --- A2 compound options -------------------------------------------------
  for (const text of options) {
    for (const pattern of COMPOUND_OPTION) {
      if (pattern.test(text)) {
        out.push(
          `${where}: A2 "${text.slice(0, 48)}" is an all/none/both option. ` +
            `Partial knowledge solves it without knowing the content.`,
        );
        break;
      }
    }
  }

  // --- A3 negated stem -----------------------------------------------------
  if (!item.negationIsThePoint) {
    for (const pattern of NEGATED_STEM) {
      if (pattern.test(stem)) {
        out.push(
          `${where}: A3 the stem asks which option is wrong. Ask it positively, or set ` +
            `negationIsThePoint if this is a compliance item where "what not to do" IS the objective.`,
        );
        break;
      }
    }
  }

  // --- A4 the cover test ---------------------------------------------------
  const stemWords = words(stem);
  if (stemWords.length < MIN_STEM_WORDS || stem.trim().length < MIN_STEM_CHARS) {
    out.push(
      `${where}: A4 the stem is ${stemWords.length} words. A stem must be answerable with the ` +
        `options covered, and one this short never is. Put the situation in the stem.`,
    );
  }
  if (
    BARE_COMPARATIVE.test(stem) &&
    !HAS_REFERENT.test(stem) &&
    stemWords.length < COMPARATIVE_CONTEXT_WORDS
  ) {
    out.push(
      `${where}: A4 the stem compares without saying against what. "Which costs you less?" ` +
        `is a label on a list, not a question. Name the alternative in the stem.`,
    );
  }

  // --- A5 option homogeneity ----------------------------------------------
  if (n >= 2) {
    const lengths = options.map((o) => o.trim().length);
    const keyLength = lengths[0];
    const others = lengths.slice(1);
    const meanOthers = others.reduce((a, b) => a + b, 0) / others.length;
    if (meanOthers > 0 && keyLength > meanOthers * LENGTH_CLUE_RATIO) {
      out.push(
        `${where}: A5 the right answer is ${Math.round((keyLength / meanOthers) * 100)}% the length ` +
          `of the average wrong one. Length is a giveaway. Even them up.`,
      );
    }

    // Clang clue: a distinctive word shared by the stem and the key alone.
    const distinctive = (s: string) =>
      new Set(
        words(s.toLowerCase().replace(/[^a-z\s]/g, " "))
          .filter((w) => w.length >= 5 && !STOPWORD.has(w)),
      );
    const stemWordSet = distinctive(stem);
    const keyWordSet = distinctive(item.answer);
    const distractorWords = new Set<string>();
    for (const d of item.distractors) for (const w of distinctive(d.text)) distractorWords.add(w);
    for (const w of keyWordSet) {
      if (stemWordSet.has(w) && !distractorWords.has(w)) {
        out.push(
          `${where}: A5 "${w}" appears in the stem and in the right answer but in no wrong one. ` +
            `That is a clang clue: it can be answered by matching words.`,
        );
        break;
      }
    }

    // Duplicated option text marks a rep wrong for choosing identical words.
    const seen = new Set<string>();
    for (const text of options) {
      const key = text.trim().toLowerCase();
      if (seen.has(key)) {
        out.push(`${where}: A5 "${text.slice(0, 48)}" appears twice. One of them is unwinnable.`);
        break;
      }
      seen.add(key);
    }
  }

  // --- A6 absolutes as a cue ----------------------------------------------
  if (!item.negationIsThePoint) {
    const withAbsolute = options.filter((o) => ABSOLUTE.test(o));
    if (withAbsolute.length === 1) {
      out.push(
        `${where}: A6 exactly one option contains an absolute ("${withAbsolute[0].slice(0, 40)}"). ` +
          `An absolute in one option only is a cue. Put one in another option, or drop it.`,
      );
    }
  }

  // --- A7 / A8 every distractor is a named mistake, explained --------------
  if (item.distractors.length === 0) {
    out.push(`${where}: A7 no distractors.`);
  }
  for (const [i, d] of item.distractors.entries()) {
    if (!d.text?.trim()) out.push(`${where}: A7 distractor ${i + 1} is empty.`);
    if (!d.realError?.trim()) {
      out.push(
        `${where}: A7 distractor ${i + 1} names no real rep error. A distractor nobody can ` +
          `name a mistake for is one nobody picks, and the question is really two options.`,
      );
    }
    if (!d.whyWrong?.trim()) {
      out.push(
        `${where}: A8 distractor ${i + 1} has no explanation. Without one, reading it teaches ` +
          `it (Roediger & Marsh 2005). Feedback is what reverses that, so it is not optional.`,
      );
    }
  }
  if (!item.whyRight?.trim()) {
    out.push(`${where}: A8 no explanation of why the right answer is right.`);
  }

  return out;
}

/** Convenience for tests and for the authoring script. */
export function assertAuthorable(items: readonly LintableItem[]): void {
  const all = items.flatMap(authoringViolations);
  if (all.length > 0) {
    throw new Error(`${all.length} authoring violation(s):\n  ${all.join("\n  ")}`);
  }
}
