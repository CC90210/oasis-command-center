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
 * One drillable fact.
 *
 * `group` is what makes a question hard enough to be worth asking. Decoys are
 * drawn from the SAME group, so the four offer labels compete against each
 * other rather than against a buyer level. A question whose wrong answers come
 * from a different subject is answerable without knowing anything.
 */
export type DrillItem = {
  id: string;
  section: SectionSlug;
  group: string;
  /** The question, in the rep's language. */
  prompt: string;
  /** The correct option's text. */
  answer: string;
  /** Shown after answering: why that one, in a sentence. */
  because: string;
};
