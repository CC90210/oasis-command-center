import assert from "node:assert";

import {
  LENGTH_CLUE_RATIO,
  MAX_OPTION_COUNT,
  MIN_STEM_WORDS,
  PREFERRED_OPTION_COUNT,
  assertAuthorable,
  authoringViolations,
  type LintableItem,
} from "@/lib/training/authoring-rules";

// ---------------------------------------------------------------------------
// The authoring lint.
//
// Every rule here is checked by PLANTING the defect it exists to catch and
// asserting that the specific rule fires. A lint whose rules have never been
// seen to fire is a comment claiming a guarantee, and this repo has shipped
// three of those: a count of filters that passed when the important one was
// deleted, a name-presence check satisfied by an import line, and a disabled=
// guard satisfied by a second element on the page.
//
// So: no rule below is trusted because it was written. Each one is watched
// catching something.
//
// WHAT THIS CANNOT COVER. Whether a question is WORTH asking. A perfectly
// linted item about something no rep needs still wastes their morning, and no
// assertion here would notice.
// ---------------------------------------------------------------------------

/** A clean item. Every negative case below is this, with one thing broken. */
const GOOD: LintableItem = {
  id: "cold-call-spin",
  stem:
    "You have ninety seconds on a cold dial before the owner decides whether to stay on. " +
    "What do you do with them?",
  answer: "Give one reason you called, then ask for a short meeting",
  whyRight:
    "Under two minutes there is no room for a question chain. The only winnable outcome is a " +
    "next step on the calendar.",
  distractors: [
    {
      text: "Open a chain of questions about how their business runs today",
      whyWrong:
        "That is discovery, and it needs a booked meeting. On a cold dial it burns the only " +
        "window you get and they hang up mid-question.",
      realError: "Running SPIN on a cold call because SPIN is what they were taught",
    },
    {
      text: "Describe what we build until something lands with them",
      whyWrong:
        "Pitching before they have agreed anything is wrong is what creates the objections you " +
        "then argue with.",
      realError: "Leading with capability instead of a reason for the call",
    },
  ],
};

assert.deepEqual(authoringViolations(GOOD), [], "the reference item must be clean");
assert.doesNotThrow(() => assertAuthorable([GOOD]));

/** Every planted defect must produce a violation naming the rule. */
const fires = (item: LintableItem, rule: string, why: string) => {
  const found = authoringViolations(item);
  assert.ok(
    found.some((v) => v.includes(`: ${rule} `)),
    `${rule} did not fire on a planted defect (${why}). Got: ${JSON.stringify(found)}`,
  );
};

// --- A1 option count -------------------------------------------------------

fires(
  { ...GOOD, distractors: [...GOOD.distractors, ...GOOD.distractors, ...GOOD.distractors] },
  "A1",
  "seven options",
);
assert.deepEqual(
  authoringViolations({ ...GOOD, distractors: [...GOOD.distractors, GOOD.distractors[0]] })
    .filter((v) => v.includes(": A1 ")),
  [],
  `${MAX_OPTION_COUNT} options must be allowed, only more than that refused`,
);
fires({ ...GOOD, distractors: [] }, "A1", "no options at all");
assert.ok(PREFERRED_OPTION_COUNT === 3, "three options is the documented preference");

// --- A2 all/none of the above ---------------------------------------------

for (const bad of ["All of the above", "none of the above", "Both A and B"]) {
  fires(
    {
      ...GOOD,
      distractors: [GOOD.distractors[0], { ...GOOD.distractors[1], text: bad }],
    },
    "A2",
    bad,
  );
}

// --- A3 negated stems ------------------------------------------------------

for (const bad of [
  "Which of these should you not say on a first cold call to an owner?",
  "All of the following are true about cold outreach EXCEPT which one?",
  "Which opener is least likely to get you a second sentence on a cold dial?",
  "Which of these statements about the offer ladder is false, in your own words?",
  "On a cold dial you should do all of these things, but which one is NOT one of them?",
]) {
  fires({ ...GOOD, stem: bad }, "A3", bad.slice(0, 40));
}

// A scenario that merely contains "not" is NOT a negated stem. This distinction
// is the whole reason A3 matches the inversion rather than the word: a blanket
// /\bnot\b/ would have refused half the objection catalogue.
assert.deepEqual(
  authoringViolations({
    ...GOOD,
    stem:
      "An owner asks for something you are not sure we sell, and they want an answer now. " +
      "What do you say to them?",
  }).filter((v) => v.includes(": A3 ")),
  [],
  "a scenario containing 'not' must not be mistaken for a negated stem",
);

// The compliance exemption works, and is narrow.
assert.deepEqual(
  authoringViolations({
    ...GOOD,
    negationIsThePoint: true,
    stem: "Which of these must a rep never say to a merchant about who funds the deal?",
  }).filter((v) => v.includes(": A3 ")),
  [],
  "negationIsThePoint must exempt a genuine compliance item",
);

// --- A4 the cover test -----------------------------------------------------

fires({ ...GOOD, stem: "Which costs you less?" }, "A4", "the real shipped stem");
fires({ ...GOOD, stem: "Which problem is the better place to start?" }, "A4", "no referent");
fires({ ...GOOD, stem: "What makes an opener land?" }, "A4", "too short to stand alone");

// A comparative WITH a referent is fine, because the reader knows what is being
// weighed before they see the list.
assert.deepEqual(
  authoringViolations({
    ...GOOD,
    stem:
      "An owner has a painful problem once a year and an irritating one every week. " +
      "Which is the better place to start, and why does that beat the other?",
  }).filter((v) => v.includes(": A4 ")),
  [],
  "a comparative that names its alternative must pass",
);
assert.ok(MIN_STEM_WORDS >= 8, "the cover-test proxy must be meaningfully long");

// --- A5 homogeneity --------------------------------------------------------

fires(
  {
    ...GOOD,
    answer:
      "Give exactly one clear reason you called, tie it to something specific about their " +
      "business that you looked up beforehand, and then ask for a short meeting at a named time",
    distractors: [
      { text: "Pitch", whyWrong: "Too early.", realError: "Pitching cold" },
      { text: "Ask questions", whyWrong: "No time.", realError: "SPIN on a dial" },
    ],
  },
  "A5",
  "the key is far longer than the decoys",
);

fires(
  {
    ...GOOD,
    stem: "An owner raises a reflexive objection on a cold dial. Which posture do you take first?",
    answer: "Take the objection away from them",
    distractors: [
      { text: "Argue the point directly", whyWrong: "Arguing ends calls.", realError: "Debating" },
      { text: "Move straight to price", whyWrong: "Too early.", realError: "Quoting early" },
    ],
  },
  "A5",
  "'objection' appears in the stem and the key only",
);

fires(
  {
    ...GOOD,
    distractors: [GOOD.distractors[0], { ...GOOD.distractors[1], text: GOOD.distractors[0].text }],
  },
  "A5",
  "the same option twice",
);
assert.ok(LENGTH_CLUE_RATIO > 1, "the length-clue threshold must be a real ratio");

// --- A6 absolutes as a cue -------------------------------------------------

fires(
  {
    ...GOOD,
    answer: "Always give one reason you called before asking for anything",
    distractors: GOOD.distractors,
  },
  "A6",
  "an absolute in exactly one option",
);

// Two options carrying an absolute is not a cue, because it no longer
// discriminates. This is why A6 counts rather than bans: our compliance content
// legitimately says "never".
assert.deepEqual(
  authoringViolations({
    ...GOOD,
    answer: "Always give one reason you called before asking for anything",
    distractors: [
      { ...GOOD.distractors[0], text: "Always open a chain of questions about their business" },
      GOOD.distractors[1],
    ],
  }).filter((v) => v.includes(": A6 ")),
  [],
  "an absolute in two options is not a cue and must be allowed",
);

// --- A7 / A8 the distractor has to be a named, explained mistake -----------

fires(
  { ...GOOD, distractors: [{ ...GOOD.distractors[0], realError: "" }, GOOD.distractors[1]] },
  "A7",
  "a distractor naming no real rep error",
);
fires(
  { ...GOOD, distractors: [{ ...GOOD.distractors[0], whyWrong: "" }, GOOD.distractors[1]] },
  "A8",
  "a distractor with no explanation",
);
fires({ ...GOOD, whyRight: "" }, "A8", "no explanation of the right answer");

// --- the exemption is narrow ----------------------------------------------
// negationIsThePoint turns off A3 and A6. It must turn off NOTHING else, or a
// compliance flag becomes a way to smuggle a vague question past the gate.
{
  const vagueButFlagged: LintableItem = {
    ...GOOD,
    negationIsThePoint: true,
    stem: "Which costs you less?",
    distractors: [{ ...GOOD.distractors[0], whyWrong: "" }],
  };
  const found = authoringViolations(vagueButFlagged);
  assert.ok(found.some((v) => v.includes(": A4 ")), "the flag must not exempt the cover test");
  assert.ok(found.some((v) => v.includes(": A8 ")), "the flag must not exempt feedback");
}

// --- assertAuthorable reports everything, not the first thing --------------
{
  let message = "";
  try {
    assertAuthorable([{ ...GOOD, stem: "Which costs you less?", whyRight: "" }]);
  } catch (err) {
    message = (err as Error).message;
  }
  assert.ok(message.includes("A4"), "the batch assert must surface the stem defect");
  assert.ok(message.includes("A8"), "and the feedback defect in the same run");
}

console.log("training-authoring: every rule was watched catching a planted defect OK");
