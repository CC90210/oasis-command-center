/**
 * The drillable facts.
 *
 * GROUPED SO THE DECOYS ARE HARD. Items in one group are each other's wrong
 * answers, so the four offer labels compete against each other rather than
 * against a buyer level. A question whose wrong answers come from a different
 * subject can be answered by someone who knows nothing, and it teaches them
 * that they knew it.
 *
 * NO ITEM'S ANSWER STATES A PRICE, and a test asserts it. The three source
 * documents give three incompatible pricing rules and one of them says no
 * approved price exists at all (`docs/training/CONTENT_CONFLICTS.md`). A drill
 * whose right answer is an unapproved number would put it in fifteen mouths.
 *
 * `because` is not decoration. Being told you were wrong teaches nothing on its
 * own; being told why that one was right is the part that transfers.
 */

import type { DrillItem } from "@/lib/training/types";

export const ITEMS: DrillItem[] = [
  // --- the four offer labels -------------------------------------------------
  {
    id: "label-standard",
    section: "what-we-sell",
    group: "offer-labels",
    prompt: "An owner wants a repeated manual task automated. It is one of the paths we already sell. Which label?",
    answer: "Standard offer",
    because: "A buying path already represented in the playbook. You can talk about it without checking first.",
  },
  {
    id: "label-discovery",
    section: "what-we-sell",
    group: "offer-labels",
    prompt: "We can definitely build it, but the scope, timeline and integrations all depend on how their business runs. Which label?",
    answer: "Sell after discovery",
    because: "Most of what we do lives here. The capability is real; the shape of it is not known until you look.",
  },
  {
    id: "label-proof",
    section: "what-we-sell",
    group: "offer-labels",
    prompt: "You want to show an owner we have built this kind of system before. Which label?",
    answer: "Proof of capability",
    because: "Use it to prove depth. It is evidence, not a product you may promise to reproduce.",
  },
  {
    id: "label-internal",
    section: "what-we-sell",
    group: "offer-labels",
    prompt: "It exists and it works, but nobody has approved selling it. Which label?",
    answer: "Internal or not promiseable",
    because: "You may use it to understand Oasis. You may not quote it as a live product.",
  },

  // --- the three buying lanes ------------------------------------------------
  {
    id: "lane-automation",
    section: "what-we-sell",
    group: "buying-lanes",
    prompt: "One repeated task, done by hand, many times a month. Which lane?",
    answer: "One-off automation",
    because: "Smallest credible entry, and the most common first sale.",
  },
  {
    id: "lane-build",
    section: "what-we-sell",
    group: "buying-lanes",
    prompt: "They have outgrown the system they are running the business on. Which lane?",
    answer: "Custom software build",
    because: "Replacing something they already depend on, rather than adding to it.",
  },
  {
    id: "lane-advisory",
    section: "what-we-sell",
    group: "buying-lanes",
    prompt: "They know something is wrong but cannot say what should be built. Which lane?",
    answer: "Advisory work",
    because: "We think alongside them first. Selling a build here means guessing.",
  },

  // --- FIND ------------------------------------------------------------------
  {
    id: "find-f",
    section: "diagnosis",
    group: "find",
    prompt: "FIND, first step: what are you actually asking about?",
    answer: "Find the repeated problem",
    because: "Where customers, information or work gets delayed, forgotten, or copied out by hand.",
  },
  {
    id: "find-i",
    section: "diagnosis",
    group: "find",
    prompt: "FIND, second step: you have a problem. What now?",
    answer: "Identify the cost",
    because: "Frequency, time, missed work, rework. Without a cost there is nothing to justify fixing.",
  },
  {
    id: "find-n",
    section: "diagnosis",
    group: "find",
    prompt: "FIND, third step: before you propose anything, what do you do?",
    answer: "Name the desired result in their words",
    because: "If you cannot say it back in their language, you did not understand it.",
  },
  {
    id: "find-d",
    section: "diagnosis",
    group: "find",
    prompt: "FIND, last step: how does the call end?",
    answer: "Decide the next small step",
    because: "A review or a demonstration. You are not designing the whole solution on this call.",
  },
  {
    id: "find-frequency",
    section: "diagnosis",
    group: "problem-worth-fixing",
    prompt: "Which problem is the better place to start?",
    answer: "A small one that happens a hundred times a month",
    because: "Frequency is what turns a small irritation into real money.",
  },
  {
    id: "find-rare",
    section: "diagnosis",
    group: "problem-worth-fixing",
    prompt: "An owner names something painful that happens once a year. What is it worth as a starting point?",
    answer: "Rarely worth starting with",
    because: "Real pain, but too rare to justify a first build. Note it and keep looking.",
  },

  // --- the five-part offer ---------------------------------------------------
  {
    id: "offer-boundary",
    section: "offer",
    group: "offer-parts",
    prompt: "Which part of the offer statement do reps most often skip?",
    answer: "The boundary, what stays human",
    because: "Saying what the system will NOT do is what makes the rest believable.",
  },
  {
    id: "offer-result",
    section: "offer",
    group: "offer-parts",
    prompt: "What has to be measurable in an offer statement?",
    answer: "The result",
    because: "A result nobody can measure cannot be shown to have worked, so the second sale never comes.",
  },
  {
    id: "offer-smallest",
    section: "offer",
    group: "offer-parts",
    prompt: "There is an obvious bigger version of this build. When do you sell it?",
    answer: "Not on call one",
    because: "The bigger work is sold by the first thing working, not by describing it.",
  },

  // --- objections ------------------------------------------------------------
  {
    id: "obj-agree",
    section: "objections",
    group: "moves",
    prompt: "They said something true and arguing would end the call. Which move?",
    answer: "Agree, then redirect",
    because: "Concede the point they actually made, then move to something they have not considered.",
  },
  {
    id: "obj-question",
    section: "objections",
    group: "moves",
    prompt: "You suspect the objection is a guess, or it is about their own experience rather than a customer's. Which move?",
    answer: "Question it back",
    because: "Assert nothing. Ask the diagnostic question and let the silence do the work.",
  },
  {
    id: "obj-cost",
    section: "objections",
    group: "moves",
    prompt: "The objection is about money, and the real number is the one they cannot see. Which move?",
    answer: "Reframe the cost",
    because: "Move off what this costs and onto what the current situation is already costing them.",
  },
  {
    id: "obj-away",
    section: "objections",
    group: "moves",
    prompt: "They are pushing back reflexively and you would rather have a clean no. Which move?",
    answer: "Take it away",
    because: "Genuinely offer to leave it. If you are not willing to actually leave, they can hear it.",
  },
  {
    id: "obj-prevented",
    section: "objections",
    group: "objection-economics",
    prompt: "Which costs you less?",
    answer: "An objection you prevented",
    because: "One you handled costs the momentum of the call even when you handle it well.",
  },
  {
    id: "obj-cause",
    section: "objections",
    group: "objection-economics",
    prompt: "The best reps collect fewer objections using the same answers. What are they doing differently?",
    answer: "Speaking later",
    because: "Describing the build before the owner admits a problem turns everything you said into something to argue with.",
  },

  // --- buyer levels ----------------------------------------------------------
  {
    id: "buyer-unaware",
    section: "who-you-are-talking-to",
    group: "buyer-response",
    prompt: "\"We are too small for that, my business is different.\" What do you do?",
    answer: "Ask about one familiar operating problem",
    because: "Do not teach the technology. Use examples from their trade and make the conversation about the process.",
  },
  {
    id: "buyer-clever",
    section: "who-you-are-talking-to",
    group: "buyer-response",
    prompt: "The owner clearly understands the technology better than you do. What does that tell you about the sale?",
    answer: "Nothing about whether they will buy",
    because: "Technical knowledge is not willingness. An informed owner may have no problem worth solving.",
  },
  {
    id: "buyer-naive",
    section: "who-you-are-talking-to",
    group: "buyer-response",
    prompt: "The owner understands none of it but has an obvious, painful, repeated problem. What is likely?",
    answer: "They may buy quickly",
    because: "The result is obvious and the risk feels small. Do not mistake confusion for reluctance.",
  },

  // --- opening ---------------------------------------------------------------
  {
    id: "open-reason",
    section: "opening",
    group: "opening-moves",
    prompt: "What goes in your first breath on a cold call?",
    answer: "The reason you are calling",
    because: "Naming it outright, specific to their business, outperforms every clever alternative.",
  },
  {
    id: "open-bad-time",
    section: "opening",
    group: "opening-moves",
    prompt: "\"Did I catch you at a bad time?\" How does that opener perform?",
    answer: "It is the worst one measured",
    because: "You have handed them a way to end the call before they know what it is about.",
  },
  {
    id: "open-specific",
    section: "opening",
    group: "opening-moves",
    prompt: "What makes an opener land?",
    answer: "One real observation about their business",
    because: "It proves you looked. Nothing clever substitutes for that.",
  },

  // --- advancing -------------------------------------------------------------
  {
    id: "adv-action",
    section: "advancing",
    group: "call-outcome",
    prompt: "How do you judge whether a call went well?",
    answer: "By what the owner did",
    because: "A pleasant conversation where nothing was agreed is not progress. Compliments are not success.",
  },
  {
    id: "adv-no",
    section: "advancing",
    group: "call-outcome",
    prompt: "An owner gives you a clean no. What is that worth?",
    answer: "A good outcome",
    because: "It costs you one call instead of six. A maybe you chase for a month costs far more.",
  },
  {
    id: "adv-disqualify",
    section: "advancing",
    group: "call-outcome",
    prompt: "No repeated problem, nobody who can decide, no willingness to change anything. What now?",
    answer: "Disqualify and move on",
    because: "Knowing early is what protects your week. Say it plainly and leave the door open.",
  },

  // --- guardrails ------------------------------------------------------------
  {
    id: "guard-price",
    section: "guardrails",
    group: "guardrails",
    prompt: "An owner asks what it costs. What do you say?",
    answer: "That you would rather understand the process first",
    because: "A price you have not scoped is a promise you cannot keep, and the hardest thing to walk back.",
  },
  {
    id: "guard-evidence",
    section: "guardrails",
    group: "guardrails",
    prompt: "You saw something we built for another client and this owner wants the same. What is it?",
    answer: "Evidence, not a product you may sell",
    because: "Never turn repository evidence into an unapproved promise.",
  },
  {
    id: "guard-buildable",
    section: "guardrails",
    group: "guardrails",
    prompt: "They ask for something you are not sure we sell. What is the line?",
    answer: "That it sounds buildable, and you will bring in the technical team to scope it",
    because: "It keeps the door open without promising scope, timeline or ownership you do not have.",
  },
];

/** Every item in one section. */
export function itemsForSection(slug: string): DrillItem[] {
  return ITEMS.filter((i) => i.section === slug);
}

/** The items an item competes against for decoys. */
export function groupPeers(item: DrillItem): DrillItem[] {
  return ITEMS.filter((i) => i.group === item.group);
}
