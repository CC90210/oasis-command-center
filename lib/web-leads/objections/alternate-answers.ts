/**
 * THE ALTERNATES. Two per objection, so every card has three genuinely
 * different moves and `ObjectionCard.tsx`'s posture picker, which is gated on
 * `answers.length > 1`, finally renders. Before this it never rendered once:
 * every objection had exactly one approved response, so "recovery by posture"
 * could only ever have measured the default posture.
 *
 * KEYED BY SLUG, and in its own module for the same reason `seed-slugs.ts`
 * exists: `scripts/seed-objection-catalog.ts` runs `main()` as a module-level
 * side effect, so importing it from a test would execute a seed run. This file
 * does NO I/O and imports nothing but a type, so the copy-rule test can read
 * every sentence a rep will say out loud. The seed imports it and asserts every
 * key matches a real seeded slug, and `answersFor()` asserts every slug has at
 * least one alternate, so a typo or a new objection added without alternates
 * fails the seed run rather than quietly shipping a card with no picker.
 *
 * EVERY ALTERNATE'S POSTURE DIFFERS from the primary's and from the other
 * alternate's. Three rewordings of one move would defeat the four-posture
 * model outright: the scoreboard is meant to answer "does taking it away beat
 * questioning back on this objection", which it cannot do if all three rows
 * are the same move in different words.
 *
 * REGISTER, same as angles.ts and remedies.ts: spoken aloud, owner language,
 * and it names a behaviour of the OWNER'S CUSTOMER rather than a failing of
 * the owner. No em dash, no double hyphen, and no figure: a rep who reads a
 * number off a script is quoting a price they have not scoped.
 *
 * `just-send-email` is the one with a legal fence rather than a stylistic one.
 * The objection is itself a request for an email, so any answer that ends in
 * one needs an express-consent basis under CASL s.10(1), and s.13 puts the
 * onus of proof on us. Both alternates therefore carry the same three
 * elements the primary does: who it comes from, what it is about, and the
 * right to stop it. An alternate without them would give a rep a path to
 * picking posture B and emailing with no consent on record.
 */
import type { ObjectionPosture } from "./types";

export const ALTERNATE_ANSWERS: Record<string, { posture: ObjectionPosture; body: string }[]> = {
  "nephew-built-website": [
    {
      posture: "question_back",
      body:
        "Can I ask you something about it first, and it has nothing to do with who built it. When " +
        "somebody lands on that page who has never met you, what is the one thing you want them to " +
        "do before they leave? That is the bit I want to look at with you.",
    },
    {
      posture: "take_it_away",
      body:
        "Then you may not need me at all, and I would rather find that out now than take up your " +
        "afternoon. One question and I will know. When somebody rings you off the back of that " +
        "site, do they already know what you do and roughly what it costs, or are they ringing to " +
        "find out? If they already know, I will leave you to it.",
    },
  ],
  "no-budget": [
    {
      posture: "agree_and_redirect",
      body:
        "That is completely fair, and most people I ring say it, usually because nobody has ever " +
        "shown them what leaving it alone is costing. I am not asking you for anything today. I " +
        "would rather show you the one thing on the page I think is losing you work, and you can " +
        "decide later whether it is worth a conversation.",
    },
    {
      posture: "reframe_the_cost",
      body:
        "I understand, and I am not trying to talk you into an expense. The thing worth working " +
        "out is not what this costs. It is what the page is already costing you in people who " +
        "looked and went elsewhere. That one never arrives as a bill, which is exactly why it " +
        "never gets budgeted for. Can I show you where it is happening?",
    },
  ],
  "just-send-email": [
    {
      posture: "question_back",
      body:
        "I can do that. So it is not another thing sitting unopened, what is the one thing you " +
        "would want it to answer? And I have to say three quick things before I am allowed to " +
        "send it. It comes from me, at the same company and the same number I gave you when I " +
        "rang. It would only ever be about your website, nothing else. And you can tell me to " +
        "stop at any time and that is the end of it. Is that alright, and who should I put it to?",
    },
    {
      posture: "take_it_away",
      body:
        "I can, or I can save you the inbox. Most of what I would put in that email is one " +
        "sentence, and I can say it now and let you go. Which would you rather? If you do still " +
        "want it in writing then I have to say three things first so I am allowed to send it. It " +
        "comes from me, at the company and number I gave you when I rang. It would only ever be " +
        "about your website. And you can tell me to stop at any time and that is the end of it.",
    },
  ],
  "not-interested": [
    {
      posture: "agree_and_redirect",
      body:
        "That is fair, you did not ask me to ring. I am not selling you anything on this call. I " +
        "have your site open and there is one thing on it I think is quietly turning people away " +
        "before they get as far as ringing you. One sentence and you can decide whether it matters.",
    },
    {
      posture: "question_back",
      body:
        "Fair enough. Can I ask one thing before I go, because it is the reason I rang you rather " +
        "than anybody else. When somebody who has never heard of you looks you up before they " +
        "call, what do you think they see first? That is the only thing I wanted to talk about.",
    },
  ],
  "how-much-is-it": [
    {
      posture: "agree_and_redirect",
      body:
        "Good question, and I will answer it properly rather than dodge it. It moves on two " +
        "things, how many pages you need and whether you want us keeping it current afterwards. " +
        "Let me ask you those two and you will have a real figure before we hang up, not a range.",
    },
    {
      posture: "question_back",
      body:
        "I will give you a straight answer, and it will be a more useful one if I know something " +
        "first. Is this you working out whether it is worth doing at all, or have you already " +
        "decided it needs doing and you want to know where it lands? Those are two different " +
        "conversations and I do not want to give you the wrong one.",
    },
  ],
  "call-back-later": [
    {
      posture: "agree_and_redirect",
      body:
        "That is fine, I will put it in. One thing worth saying before I do. The people looking " +
        "you up between now and then are still looking you up, and the page they land on does not " +
        "change while we wait. So I will ring you when you said, and in the meantime I will not " +
        "chase you about it.",
    },
    {
      posture: "take_it_away",
      body:
        "I can do that, or I can take you off the list properly so nobody here rings you again. I " +
        "would rather do whichever one is actually true. If it is a no, that is a fine answer and " +
        "it costs you nothing to say it. If there is genuinely something happening in a few " +
        "months, tell me what it is and I will make the note worth having.",
    },
  ],
  "word-of-mouth": [
    {
      posture: "question_back",
      body:
        "That is the best kind of work there is. Can I ask what happens next though? Somebody gets " +
        "your name from a neighbour, and they are standing in their kitchen with your name and " +
        "nothing else. What do you reckon they do before they ring you? That is the bit I am " +
        "calling about.",
    },
    {
      posture: "reframe_the_cost",
      body:
        "I would not touch that, it is the best work there is. The thing worth knowing is that a " +
        "referral is not as free as it looks. Somebody on your team earned it on a job, and then " +
        "it gets checked online before anybody dials. If that check goes badly, what gets lost is " +
        "the work you already did to earn the name, not a stranger's click.",
    },
  ],
  "facebook-page-is-enough": [
    {
      posture: "question_back",
      body:
        "That is a good place to be found and I would not touch it. Can I ask you one thing about " +
        "it though. When somebody messages that page at nine on a Sunday night wanting to know if " +
        "you cover their street, what happens? That is the gap I am ringing about, not the page.",
    },
    {
      posture: "take_it_away",
      body:
        "Then it might be doing the job and I am not going to argue with it. Let me check one " +
        "thing, and if I am wrong I will leave you alone. Is everything somebody needs in order to " +
        "decide on that page right now, or is it the last few posts? If it is all there, I have " +
        "got nothing for you.",
    },
  ],
  "conversion-plenty-of-calls": [
    {
      posture: "question_back",
      body:
        "I believe you. Can I ask what the calls are like though? Are people ringing already " +
        "knowing what you do and roughly what it costs, or are they ringing to find that out? " +
        "Because the second kind is the page making them do the work, and that is the group where " +
        "you only ever hear from the patient ones.",
    },
    {
      posture: "take_it_away",
      body:
        "Then you may well not need this. The only thing I would check is whether you are getting " +
        "the calls you want or just the calls you get. If the phone is full of the right jobs, I " +
        "will leave it there and wish you well.",
    },
  ],
  "trust-reviews-on-google": [
    {
      posture: "question_back",
      body:
        "Good, that is real proof and it is worth having. Where do you think somebody actually is " +
        "when they decide to ring you though? If they are on your page and the proof is somewhere " +
        "else, they have to go and look for it. How many do you reckon bother?",
    },
    {
      posture: "reframe_the_cost",
      body:
        "Good, and you paid for those in work rather than in advertising. Every one of them is a " +
        "job somebody did well. What it costs you is that they are sitting one click away from " +
        "the moment a stranger is deciding, and one click away is where proof stops working. You " +
        "already own the expensive part. This is about putting it where it counts.",
    },
  ],
  "design-customers-dont-care": [
    {
      posture: "question_back",
      body:
        "Your customers do not, and you are right about that. Can I ask about the other group " +
        "though. Somebody who has never heard of you, four tabs open, comparing three of you at " +
        "once. What do you think decides it for them, when they cannot tell the difference in the " +
        "work yet?",
    },
    {
      posture: "take_it_away",
      body:
        "You are right about your customers, and if all your work comes from people who already " +
        "know you, this genuinely is not for you. It only matters if you want the ones who do " +
        "not. Do you?",
    },
  ],
  "mobile-looks-fine": [
    {
      posture: "agree_and_redirect",
      body:
        "It probably does, and that is not you being wrong. Your phone has been to that page " +
        "before and it knows the way. The person I am worried about is arriving cold, on a bad " +
        "signal, looking for one thing. That is a different page than the one you and I get.",
    },
    {
      posture: "take_it_away",
      body:
        "Then we can settle this in a second. Open it on your phone now and find your own opening " +
        "hours. If you get there without pinching or hunting for it, I will take your word for it " +
        "and leave you alone.",
    },
  ],
  "content-everyone-knows-us": [
    {
      posture: "question_back",
      body:
        "Around here, probably true. Who moved in this year though? Every one of those people is " +
        "looking for somebody who does what you do and has never heard your name. Where do you " +
        "think they are looking?",
    },
    {
      posture: "take_it_away",
      body:
        "If everybody who could ever hire you already knows you, then you do not need a website " +
        "and I will say so. The only question is whether you want the people who do not. If the " +
        "answer is no, that is a legitimate way to run a business and I will leave it there.",
    },
  ],
  "performance-loads-fine-for-me": [
    {
      posture: "agree_and_redirect",
      body:
        "It does for you, and that is not a trick. Your browser saved it the last time you opened " +
        "it, so you are being shown the quick version. The one that costs you is what a stranger " +
        "gets on data, on a page nobody on your phone has ever loaded.",
    },
    {
      posture: "reframe_the_cost",
      body:
        "It does for you, and here is the part that is hard to see. Nobody has ever rung you to " +
        "say your site was slow. They went back and picked somebody else, and that looks exactly " +
        "like a quiet week. This one never arrives as a complaint, which is why it can run for " +
        "years.",
    },
  ],
  "discoverability-already-on-google": [
    {
      posture: "question_back",
      body:
        "You are listed, that part is done. Can I get you to try something? Search the thing you " +
        "actually sell plus your town, without your business name in it. Where do you come? That " +
        "is the search a new customer is doing.",
    },
    {
      posture: "reframe_the_cost",
      body:
        "You are listed, and that gets you the people already looking for you by name. Those were " +
        "coming anyway. The ones worth having are searching for the job rather than the company, " +
        "and right now that search is being answered by somebody else in your town. That is going " +
        "on every week without a bill ever landing for it.",
    },
  ],
};

/** One answer as the seed writes it into `objection_response`. */
export type SeedAnswer = { label: string; body: string; posture: ObjectionPosture };

/** The standard name for each posture, used for every alternate so the picker
 *  reads consistently. The primaries already use exactly these strings. */
export const POSTURE_LABEL: Record<ObjectionPosture, string> = {
  agree_and_redirect: "Agree, then redirect",
  question_back: "Question it back",
  reframe_the_cost: "Reframe the cost",
  take_it_away: "Take it away",
};

/**
 * The primary followed by its alternates, with the postures checked here
 * rather than trusted.
 *
 * A duplicate posture inside one objection would collide on the seed writer's
 * natural key, `(tenant_id, objection_id, posture)`, so the second row would
 * overwrite the first and the card would silently end up with fewer answers
 * than were written. Throwing is the only honest outcome: the whole point of
 * this data is that a rep gets three DIFFERENT moves, and a card that quietly
 * lost one looks identical to a card that never had it.
 *
 * Pure, and separate from the seed script, so a test can prove both throws
 * fire without executing a seed run. The seed script calls `main()` as a
 * module-level side effect, so it can never be imported by a test.
 */
export function mergeAnswers(slug: string, primary: SeedAnswer): SeedAnswer[] {
  const alternates = ALTERNATE_ANSWERS[slug] ?? [];
  if (alternates.length === 0) {
    throw new Error(
      `no ALTERNATE_ANSWERS entry for ${slug}. Every objection needs at least one alternate: ` +
        `ObjectionCard gates its posture picker on answers.length > 1, so a single-answer ` +
        `objection renders no picker at all and its posture can never be compared against another.`,
    );
  }
  const answers: SeedAnswer[] = [
    primary,
    ...alternates.map((a) => ({ label: POSTURE_LABEL[a.posture], body: a.body, posture: a.posture })),
  ];
  const postures = answers.map((a) => a.posture);
  const dupe = postures.find((p, i) => postures.indexOf(p) !== i);
  if (dupe) {
    throw new Error(
      `${slug} has two answers with posture ${dupe}. Postures must be distinct within an ` +
        `objection: they are the writer's natural key, and they are what "recovery by posture" ` +
        `compares.`,
    );
  }
  return answers;
}
