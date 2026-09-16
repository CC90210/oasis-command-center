/**
 * The eight sections, in the order a call actually happens.
 *
 * ORDERED BY THE CALL, not by topic. A rep does not need "product knowledge"
 * and "objection handling" as separate subjects; they need to know what happens
 * first, then what happens next. The order is the teaching.
 *
 * WRITTEN FOR THE SCREEN rather than copied from the source documents. The
 * plan said long-form would render from markdown in `content/training/`; it
 * does not, and that is a deliberate change: the three source documents total
 * over 100KB and were written to be read once by a person deciding strategy,
 * not worked through by a rep learning a job. Dumping them into a page would
 * produce something nobody finishes. Each section names its source so anyone
 * wanting the full argument knows exactly which file to open.
 *
 * NOTHING HERE STATES A PRICE. See `docs/training/CONTENT_CONFLICTS.md` for
 * why, and for the seven conflicts between the source documents that are
 * waiting on Adon.
 */

import type { TrainingSection } from "@/lib/training/types";

export const SECTIONS: TrainingSection[] = [
  {
    slug: "what-we-sell",
    title: "What we sell",
    promise: "Say what Oasis does in one sentence, and know what you may and may not promise.",
    source: "OASIS Sales Training Course",
    lessons: [
      {
        id: "one-sentence",
        heading: "The one sentence",
        body: [
          "Oasis builds the software a small business is missing. Sometimes that is a website. More often it is the thing behind the website: the part that catches an enquiry, answers it, and makes sure nobody is forgotten.",
          "You will be tempted to list what we can build. Do not. An owner cannot buy a list. They can buy the end of one specific problem they already know they have.",
        ],
      },
      {
        id: "three-lanes",
        heading: "The three ways someone buys",
        body: [
          "Everything we sell arrives through one of three doors. Knowing which door you are standing in tells you what conversation to have.",
          "A one-off automation fixes one repeated task. A custom software build replaces a system they have outgrown. Advisory work is us thinking alongside them when they do not yet know what to build.",
          "Most first sales are the smallest of these. That is not a compromise, it is the point: the first thing has to work before anything bigger is credible.",
        ],
      },
      {
        id: "offer-labels",
        heading: "The four labels, and why they exist",
        body: [
          "Before you promise anything, put the opportunity in one of four labels. This is the single rule that keeps a rep out of trouble.",
          "A standard offer is a path we already sell. Sell-after-discovery means we can build it but the scope depends on their business, and most things live here. Proof of capability means we have built that kind of system before and you may use it to show depth, not to promise the same thing again. Internal or not promiseable means it exists but nobody has approved selling it.",
          "The mistake this prevents is turning evidence into a promise. Seeing that we built something for one client does not mean you may sell it to the next one.",
        ],
        lines: [
          "That sounds buildable. Let me bring the technical team into a discovery call so we can scope it correctly.",
        ],
      },
    ],
  },
  {
    slug: "who-you-are-talking-to",
    title: "Who you are talking to",
    promise: "Work out within a minute how much the owner already knows, and change how you speak.",
    source: "AI Sales Playbook for Reps",
    lessons: [
      {
        id: "five-levels",
        heading: "Five levels, and the trap in the middle",
        body: [
          "Owners sit somewhere on a ladder from having no idea this is possible to knowing exactly what they want built. Where they sit changes your language completely, and you can usually tell from their first two sentences.",
          "The trap: technical knowledge is not the same as willingness to buy. An owner who understands all of it may have no problem worth solving. An owner who understands none of it may buy quickly, because the result is obvious and the risk feels small.",
          "So do not sell to how clever they sound. Sell to whether something is actually broken.",
        ],
      },
      {
        id: "level-one",
        heading: "The one you will meet most",
        body: [
          "Most cold calls land on someone who is not thinking about any of this. They will say they do not need it, or that their business is different.",
          "Do not teach them. Do not explain the technology. Ask about one familiar operating problem and use examples from their trade.",
        ],
        lines: [
          "You do not need to understand any of this for us to have this conversation. I am trying to understand what happens when a customer calls or messages and nobody can get to them.",
          "This may not be useful for your business. The first thing I want to establish is whether there is a repeated problem worth fixing.",
        ],
      },
    ],
  },
  {
    slug: "opening",
    title: "Opening the call",
    promise: "Get past the first ten seconds without sounding like a script.",
    source: "AI Sales Playbook for Reps, and the live opening angles in the product",
    lessons: [
      {
        id: "first-breath",
        heading: "Say why you are calling, in your first breath",
        body: [
          "The most reliable opening is the honest one: name that it is a cold call, say you will be quick, and name the specific thing you noticed about their business.",
          "Do not ask whether you caught them at a bad time. You are handing them a way to end the call before they know what it is about.",
          "Specific beats clever. One real observation about their business outperforms any clever line, because it proves you looked.",
        ],
      },
      {
        id: "the-battlecard",
        heading: "You are not doing this from memory",
        body: [
          "Every lead in the software carries an opening angle built from what is actually wrong with that business's website, and the words to say it. Use it. That is what it is for.",
          "Training is for the moments the card cannot help: when they interrupt, when they push back, when the call goes somewhere you did not plan.",
        ],
      },
    ],
  },
  {
    slug: "diagnosis",
    title: "Diagnosis",
    promise: "Find a repeated problem worth money before you describe anything we would build.",
    source: "AI Sales Playbook for Reps",
    lessons: [
      {
        id: "find",
        heading: "FIND, in that order",
        body: [
          "Find the repeated problem. Ask where customers, information or work gets delayed, forgotten, or copied out by hand.",
          "Identify the cost. Frequency, time, missed work, rework. A problem that happens once a year is rarely worth starting with. A small one that happens a hundred times a month usually is.",
          "Name the desired result, in their words, not ours.",
          "Decide the next small step. A review, a demonstration, a first piece of work. You are not designing the solution on this call.",
        ],
        lines: [
          "From what you described, the main issue is [problem]. It happens about [frequency] and affects [time, customers, or money]. The first result worth testing is [result]. The sensible next step is [review or demonstration], focused only on that process.",
        ],
      },
      {
        id: "why-order",
        heading: "Why the order matters more than the questions",
        body: [
          "The best reps in a study of thirty-five thousand sales calls collected fewer than one objection per call. The average rep collected two or three. They were using the same answers.",
          "The difference was when they spoke. Describe what you would build before the owner has agreed something is broken, and everything you said becomes a thing to argue with. You made the objection, then handled it.",
          "This is why diagnosis comes before the offer, and why it is worth being uncomfortable with the silence after a question.",
        ],
      },
    ],
  },
  {
    slug: "offer",
    title: "Turning it into an offer",
    promise: "Turn what you heard into one specific next step, without over-promising.",
    source: "AI Sales Playbook for Reps, and the OASIS Sales Training Course",
    lessons: [
      {
        id: "five-parts",
        heading: "The five parts",
        body: [
          "State the problem in their language. Name the result that is measurable. Say what the workflow would be and where it stops. Name the boundary, what stays human. Then the next small step.",
          "The boundary is the part reps skip, and it is the part that makes an owner relax. Telling someone what the system will NOT do is what makes the rest believable.",
        ],
      },
      {
        id: "smallest-credible",
        heading: "Pick the smallest thing that could work",
        body: [
          "There is always a bigger version. Selling it on call one is how a deal dies quietly: the number gets large, the risk gets obvious, and the owner decides to think about it.",
          "Choose the smallest entry that solves something real. The bigger work is sold by the first thing working, not by you describing it.",
        ],
      },
    ],
  },
  {
    slug: "objections",
    title: "Objections",
    promise: "Recognise what an objection actually means, and stop most of them being said at all.",
    source: "The live objection library in this software",
    lessons: [
      {
        id: "manufactured",
        heading: "Most objections are made, not met",
        body: [
          "An objection you prevented costs nothing. One you handled costs the momentum of the call even when you handle it well.",
          "Most of them are created upstream, by describing what we would build before the owner admitted anything was wrong. That is why diagnosis comes first.",
        ],
      },
      {
        id: "four-moves",
        heading: "Four moves, and no fifth",
        body: [
          "Agree and redirect: concede the point they actually made, then move to something they have not considered. Question it back: assert nothing, ask one diagnostic question, leave room for the answer. Reframe the cost: move off what this costs and onto what the current situation is already costing. Take it away: genuinely offer to leave it.",
          "The common failure is making no move at all. Repeating the pitch louder is not a move, and neither is agreeing so hard the call ends politely.",
          "The objection library has the full set, with what each one means underneath and how to stop it coming up. Practise it there.",
        ],
      },
    ],
  },
  {
    slug: "advancing",
    title: "Advancing the call",
    promise: "End every call with something that actually moved, or a clean no.",
    source: "AI Sales Playbook for Reps",
    lessons: [
      {
        id: "judge-by-action",
        heading: "Judge the call by what they did",
        body: [
          "A pleasant conversation where nothing was agreed is not progress. Compliments are not success. The only question that matters afterwards is whether something changed: a decision, a booked time, a named next step with a date on it.",
          "A clean no is a good outcome. It costs you one call instead of six.",
        ],
      },
      {
        id: "disqualify",
        heading: "Disqualifying is a skill, not a failure",
        body: [
          "Some businesses are not worth the follow-up, and the sooner you know, the better your week goes. No repeated problem, nobody who can decide, no willingness to change how anything is done.",
          "Say it plainly and leave the door open. You will get more from an honest close than from a maybe you chase for a month.",
        ],
      },
    ],
  },
  {
    slug: "guardrails",
    title: "Guardrails",
    promise: "Know exactly what you must never say, and what to say instead.",
    source: "OASIS Sales Training Course, and the compliance fences in this software",
    lessons: [
      {
        id: "never-promise",
        heading: "Never turn evidence into a promise",
        body: [
          "You will see things in this software that we built for other clients. That is proof of what we can do. It is not a product you may sell.",
          "If price, timeline, ownership, integrations or readiness is not in the approved deal sheet, you do not have it to give.",
        ],
        lines: [
          "That sounds buildable. Let me bring the technical team into a discovery call so we can scope it correctly.",
        ],
      },
      {
        id: "never-quote",
        heading: "You do not say a number",
        body: [
          "A price you have not scoped is a promise you cannot keep, and it is the hardest thing to walk back. Map the problem, then a quote gets confirmed by someone who can approve it.",
          "This is currently the firmest rule in this course, because the internal documents disagree with each other about pricing and that disagreement has not been settled. Until it is, nobody quotes.",
        ],
        lines: [
          "I would rather not guess at a number. Let me understand the process properly first, and we will come back to you with something real.",
        ],
      },
    ],
  },
];

export function sectionBySlug(slug: string): TrainingSection | null {
  return SECTIONS.find((s) => s.slug === slug) ?? null;
}
