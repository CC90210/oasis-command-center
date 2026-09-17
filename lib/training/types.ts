/**
 * The Training curriculum's shape.
 *
 * Curriculum as DATA, not prose inside components. A section written as JSX
 * cannot be drilled, cannot be counted, and cannot be tested; the same section
 * written as data can generate its own questions and can be asserted over. That
 * is the whole reason this file exists.
 *
 * WHAT IS NOT MODELLED HERE, and why. There is no `price` field and no drill
 * item whose answer is a number. The three source documents give three
 * incompatible pricing rules, one of which says in its own words that no
 * approved price exists. See `docs/training/CONTENT_CONFLICTS.md`. A drill with
 * an unapproved number as its right answer would teach fifteen reps to say it
 * out loud, which is the objection engine's failure mode arriving through a
 * different door. A test asserts no item's answer states money.
 */

export const SECTION_SLUGS = [
  "what-we-sell",
  "who-you-are-talking-to",
  "opening",
  "diagnosis",
  "offer",
  "objections",
  "advancing",
  "guardrails",
] as const;

export type SectionSlug = (typeof SECTION_SLUGS)[number];

export function isSectionSlug(v: unknown): v is SectionSlug {
  return typeof v === "string" && (SECTION_SLUGS as readonly string[]).includes(v);
}

/** One readable unit inside a section. Paragraphs, not markdown: this renders
 *  into a fixed layout and a rep never authors it, so a parser would be cost
 *  without a reader. */
export type Lesson = {
  id: string;
  heading: string;
  body: string[];
  /** Verbatim lines a rep is meant to be able to say or recognise. Rendered
   *  quoted and set apart, because the surrounding prose is explanation and
   *  these are the actual words. */
  lines?: string[];
};

export type TrainingSection = {
  slug: SectionSlug;
  title: string;
  /** What a rep can DO after this section, in one line. Written as a
   *  capability rather than a topic, because "understand our offers" is not
   *  something anyone can tell they have finished. */
  promise: string;
  /** Where the material came from, shown to the rep. A rep who wants depth
   *  should know which document to open, and naming it also makes a wrong
   *  lesson traceable to its source rather than to whoever typed it. */
  source: string;
  lessons: Lesson[];
};

/**
 * How much weight a claim carries, shown with the item.
 *
 * WHY THIS IS A FIELD AND NOT A COMMENT. The founder-playbook corpus labels its
 * own numbers, and several of the best known ones do not survive the labelling:
 * Rackham's "ten times more need-payoff questions" is marked rhetorical with no
 * published baseline, Milgram's "65%" is one of twenty-four conditions in a
 * range from 0 to 92, and the Kitty Genovese "38 witnesses" story is simply
 * false. A curriculum that flattens all of that into confident prose teaches
 * reps to repeat things that are not true, in front of customers.
 *
 * So an item states where it stands. "Prescriptive" is the honest label for
 * most sales advice: the framework says do this, and no effect size is claimed.
 */
export type Provenance =
  /** Replicated research, or a result measured with controls. */
  | "verified"
  /** The framework prescribes it. No effect size claimed, and none implied. */
  | "prescriptive"
  /** A number the source itself hedges. Teach the direction, never the figure. */
  | "directional"
  /** Oasis policy, or written by us. Belongs to no book and is not attributed to one. */
  | "ours";

/** A wrong option, and the mistake it represents. Mirrors the lint's shape in
 *  `lib/training/authoring-rules.ts`, which is what enforces both fields. */
export type DrillDistractor = {
  text: string;
  /** Shown when the rep picks THIS one. Why it is wrong, which is a different
   *  sentence from why the right one is right, and the one that teaches. */
  whyWrong: string;
  /** The real rep error it embodies. Authoring this forces naming the mistake;
   *  a distractor nobody can name a mistake for is one nobody picks. */
  realError: string;
};

/**
 * One drillable judgment.
 *
 * DISTRACTORS ARE AUTHORED, NOT DRAWN FROM PEERS. The first release generated
 * wrong answers from other items in the same group, which is cheap and produces
 * exactly the quiz Adon rejected on 2026-09-17: the four offer labels competing
 * with each other tests whether a rep memorised four labels, not whether they
 * can sell. It also cannot say why a chosen wrong answer is wrong, because
 * nobody wrote that sentence. Both defects are fixed by the same change.
 *
 * `group` survives for a different job now: items in one group are CONFUSABLE
 * with each other, which is what the scheduler interleaves on.
 */
export type DrillItem = {
  id: string;
  section: SectionSlug;
  /** The small unit inside the section. A unit is what a rep finishes in one
   *  sitting, which is the shape the goal-gradient work argues for. */
  unit: string;
  /** Items here are confusable with each other. Used for interleaving. */
  group: string;
  /** The question. Must stand on its own with the options covered. */
  stem: string;
  /** The correct option's text. */
  answer: string;
  /** Why the right one is right. */
  whyRight: string;
  distractors: DrillDistractor[];
  /** Which document or book this came from, shown to the rep so they can go
   *  deeper and so a wrong item is traceable to a source, not to a typist. */
  source: string;
  provenance: Provenance;
  /** Only for compliance items whose objective IS "what not to do". Exempts
   *  the item from the negated-stem and absolute-option rules, nothing else. */
  negationIsThePoint?: boolean;
};
