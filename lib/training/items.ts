/**
 * The drillable judgments.
 *
 * REWRITTEN 2026-09-17. The first release had 34 items and Adon's verdict was
 * "way too vague and very uneducational." The measurement agreed in a way the
 * eyeball did not: only 4 stems failed a mechanical rule, but 11 of 34 quizzed
 * internal taxonomy. The four offer labels, the three buying lanes, the four
 * FIND letters. A rep could score full marks on all eleven and still not know
 * what to say when someone picks up the phone.
 *
 * So the rule for this file is now a test a human applies before the lint runs:
 * EVERY ITEM IS A DECISION SOMEBODY MAKES ON A CALL, AND BEING WRONG COSTS
 * SOMETHING. If the answer is a label, it does not belong here. If a rep would
 * never face the choice, it does not belong here.
 *
 * DISTRACTORS ARE AUTHORED. Each one is a mistake real reps make, named in
 * `realError`, explained in `whyWrong`. This is the half that does the
 * teaching: multiple choice WITHOUT per-option feedback installs the
 * distractors as false knowledge rather than correcting them (Roediger & Marsh
 * 2005), and feedback is what reverses it (Butler & Roediger 2008).
 *
 * NO ITEM STATES A PRICE, and a test asserts it. Three source documents give
 * three incompatible pricing rules and one says in its own words that no
 * approved price exists (`docs/training/CONTENT_CONFLICTS.md`).
 *
 * THINGS DELIBERATELY NOT TAUGHT, because the corpus's own replication notes
 * say they are wrong: the Kitty Genovese "38 witnesses" story (false, debunked
 * 2007), Milgram's "65%" without its range of 0 to 92 across 24 conditions,
 * Hofling's "95%" (a 1966 figure; modern replications land at 16 to 30), and
 * Rackham's "ten times more need-payoff questions" (labelled rhetorical, no
 * published baseline). Also absent: "87% of sales training is forgotten in 30
 * days", which has no primary source in any version.
 */

import type { DrillItem } from "@/lib/training/types";

export const ITEMS: DrillItem[] = [
  // =========================================================================
  // WHAT WE SELL. The ladder from a single automated task up to an agent
  // team, taught as "what do you say to this person", never as a taxonomy.
  // =========================================================================
  {
    id: "ladder-novice-words",
    section: "what-we-sell",
    unit: "the-ladder",
    group: "explaining-agents",
    stem:
      "A roofing owner with nine crew asks what you actually build. He has never used anything " +
      "beyond a scheduling app. How do you describe the specialised agent team to him?",
    answer:
      "Different jobs go to different digital assistants, inside one workspace you control",
    whyRight:
      "The course gives this wording for a novice buyer, and tells us in the same breath not to " +
      "lead with the phrase agent harness. He can picture staff with jobs. He cannot picture a harness.",
    distractors: [
      {
        text: "A multi-agent operating layer with tenant boundaries and tool permissions",
        whyWrong:
          "That is the wording for an advanced buyer, and it is in the course for that reason. " +
          "Said to this owner it buys a polite nod and no second meeting.",
        realError: "Using the advanced explanation because it sounds more impressive",
      },
      {
        text: "An agent harness that runs your business operations without supervision",
        whyWrong:
          "Two problems in one sentence. The course says not to lead with that phrase, and we " +
          "do not promise unattended autonomy over anything sensitive.",
        realError: "Leading with internal vocabulary, and overpromising autonomy",
      },
    ],
    source: "OASIS Sales Training Course, Offer 18",
    provenance: "ours",
  },
  {
    id: "ladder-advanced-words",
    section: "what-we-sell",
    unit: "the-ladder",
    group: "explaining-agents",
    stem:
      "The person across from you built their own internal tooling and asks how permissions and " +
      "logging work across your agents. Which register do you answer in?",
    answer:
      "The technical one, because they asked a precise question and can check what you say",
    whyRight:
      "The course carries two explanations on purpose. Picking between them is the skill. This " +
      "buyer has earned the detailed one and will discount you for talking down to them.",
    distractors: [
      {
        text: "The simple one, because plain language works on everybody",
        whyWrong:
          "It reads as evasion to someone who can evaluate the real answer. They asked a precise " +
          "question; a vague answer says you do not have one.",
        realError: "Defaulting to the simple explanation regardless of who is listening",
      },
      {
        text: "Neither. Route the question to a solutions call and move on",
        whyWrong:
          "Deferring a question you can answer costs you the credibility the question was testing " +
          "for. Route what you genuinely do not know, not what you have not bothered to learn.",
        realError: "Deferring every technical question instead of learning the material",
      },
    ],
    source: "OASIS Sales Training Course, Offer 18",
    provenance: "ours",
  },
  {
    id: "ladder-proof-not-promise",
    section: "what-we-sell",
    unit: "what-we-promise",
    group: "what-you-may-say",
    stem:
      "An owner sees a system we built for another client and says he wants that exact thing. " +
      "It was built as proof of what we can do, not packaged for sale. What do you tell him?",
    answer:
      "That we have done this kind of system before, and we would scope his properly",
    whyRight:
      "Proof of capability is evidence that we can do the work. It is not a product you may " +
      "promise to reproduce, because nobody has scoped or priced his version of it.",
    distractors: [
      {
        text: "That we can deliver the same system on the same terms",
        whyWrong:
          "You have promised a scope nobody has looked at. Delivery inherits whatever you said, " +
          "and the gap between the demo and his business is where the relationship dies.",
        realError: "Treating a demo as a catalogue item",
      },
      {
        text: "That it belongs to another client, so we cannot discuss it",
        whyWrong:
          "Too far the other way. We show it precisely so owners can see depth. Refusing to talk " +
          "about what we have built throws away the strongest thing in the conversation.",
        realError: "Hiding proof of capability out of caution",
      },
    ],
    source: "OASIS Sales Training Course, the four offer labels",
    provenance: "ours",
  },
  {
    id: "ladder-unapproved",
    section: "what-we-sell",
    unit: "what-we-promise",
    group: "what-you-may-say",
    stem:
      "You have used an internal tool that works well and would obviously help the owner you are " +
      "meeting. Nobody has approved selling it. What is the line?",
    answer: "Understand it, use it to think, and quote nothing about it to him",
    whyRight:
      "Internal or not promiseable means exactly that. Knowing how it works makes you better in " +
      "the room. Saying we sell it commits the company to something it has not agreed to.",
    distractors: [
      {
        text: "Describe it as something coming soon so he can plan for it",
        whyWrong:
          "A roadmap promise is still a promise, and it is the kind that gets repeated back to " +
          "you in six months by someone who made a decision on it.",
        realError: "Selling the roadmap to fill a gap in the offer",
      },
      {
        text: "Mention it and let him decide whether he wants to wait for it",
        whyWrong:
          "Once it is in the room he is buying it, whatever caveat you attached. The caveat is " +
          "the first thing forgotten and the last thing you can point to.",
        realError: "Assuming a caveat survives the conversation",
      },
    ],
    source: "OASIS Sales Training Course, the four offer labels",
    provenance: "ours",
  },

  // =========================================================================
  // WHO YOU ARE TALKING TO.
  // =========================================================================
  {
    id: "buyer-more-technical",
    section: "who-you-are-talking-to",
    unit: "buyer-levels",
    group: "reading-the-buyer",
    stem:
      "Twenty minutes in, it is clear the owner understands the technology better than you do. " +
      "What does that tell you about how the rest of the sale should go?",
    answer: "Stop explaining and start asking what they have already tried and why it failed",
    whyRight:
      "Your value to this buyer is not information, because they have it. It is helping them " +
      "decide. Their failed attempts are the most useful thing in the room and nobody has asked.",
    distractors: [
      {
        text: "Bring in someone more technical and step back from the conversation",
        whyWrong:
          "It hands away the relationship over a gap you could close by asking questions instead " +
          "of answering them. Bring help for scope, not for being out-read.",
        realError: "Escalating out of a call rather than changing what you do in it",
      },
      {
        text: "Match their depth so they take you seriously as a peer",
        whyWrong:
          "Competing on knowledge with someone who has more of it is a contest you lose slowly " +
          "and in front of them. They are not assessing your expertise, they are assessing ours.",
        realError: "Treating a technical buyer as an exam",
      },
    ],
    source: "SPIN Selling, question type by audience",
    provenance: "prescriptive",
  },
  {
    id: "buyer-painful-problem",
    section: "who-you-are-talking-to",
    unit: "buyer-levels",
    group: "reading-the-buyer",
    stem:
      "An owner cannot follow any of the technical detail, but describes a painful thing that " +
      "happens to him every single week. What is the most likely read?",
    answer: "A real sale, if you stay on the problem and off the technology",
    whyRight:
      "A repeated painful problem is the strongest buying signal available. He does not need to " +
      "understand how it gets fixed, and every minute spent on how is a minute off the pain.",
    distractors: [
      {
        text: "A poor fit, because he cannot evaluate what we would build",
        whyWrong:
          "Understanding the build is not a buying requirement. He is buying an outcome, and he " +
          "is the one who can tell you what the outcome is worth.",
        realError: "Disqualifying a buyer for not being technical",
      },
      {
        text: "A teaching job first, so walk him through how the system would work",
        whyWrong:
          "Explaining the mechanism to a buyer who did not ask moves the conversation away from " +
          "the one thing that is already working for you.",
        realError: "Educating instead of selling when the pain is already stated",
      },
    ],
    source: "SPIN Selling, need development",
    provenance: "prescriptive",
  },

  // =========================================================================
  // OPENING. Cold outreach at volume, and the dial.
  // =========================================================================
  {
    id: "dial-ninety-seconds",
    section: "opening",
    unit: "the-dial",
    group: "cold-call-shape",
    stem:
      "You have ninety seconds on a cold dial before the owner decides whether to stay on the " +
      "line. What do you spend them on?",
    answer: "One reason you called, tied to them, then an ask for a short meeting",
    whyRight:
      "Under two minutes there is no room for a question chain. The only winnable outcome is a " +
      "next step on the calendar, so everything that does not move toward one is spent time.",
    distractors: [
      {
        text: "A chain of questions about how their business runs today",
        whyWrong:
          "That is discovery, and discovery needs a booked meeting. On a cold dial it burns the " +
          "window you were given and they hang up part way through.",
        realError: "Running SPIN on a cold call because SPIN is what they were taught",
      },
      {
        text: "A description of what we build until something lands with them",
        whyWrong:
          "Pitching before they have agreed anything is wrong is what manufactures the objections " +
          "you then spend the call arguing with.",
        realError: "Leading with capability instead of a reason for the call",
      },
    ],
    source: "SPIN Selling, when SPIN does not apply",
    provenance: "prescriptive",
  },
  {
    id: "dial-bad-time",
    section: "opening",
    unit: "the-dial",
    group: "cold-call-shape",
    stem:
      "A rep opens every dial with the words did I catch you at a bad time. What is wrong with " +
      "starting there?",
    answer: "It offers them an exit before you have given them a reason to stay",
    whyRight:
      "The question invites the easiest possible answer, and the easiest answer ends the call. " +
      "Give them the reason first; they can still say they are busy after they have heard it.",
    distractors: [
      {
        text: "It sounds rehearsed, and owners can hear a script",
        whyWrong:
          "Sounding rehearsed is a delivery problem, and it is fixable by saying it more often. " +
          "The structural problem is the exit, and no amount of delivery closes that door.",
        realError: "Diagnosing a structural problem as a delivery problem",
      },
      {
        text: "Nothing. It is polite, and politeness buys you a hearing",
        whyWrong:
          "Politeness that hands over the decision before you have made a case is not courtesy, " +
          "it is a coin flip you arranged to lose.",
        realError: "Confusing deference with respect on a cold call",
      },
    ],
    source: "Oasis dial guidance, authored by us",
    provenance: "ours",
  },
  {
    id: "outreach-low-reply",
    section: "opening",
    unit: "cold-outreach",
    group: "diagnosing-a-channel",
    stem:
      "Your cold email has gone to four thousand targeted contacts over two months and the reply " +
      "rate is a third of one percent. What does that number tell you to fix?",
    answer: "The message and the targeting, because volume will not rescue either",
    whyRight:
      "At that sample size the channel has been given a fair run. A reply rate that low is a " +
      "message problem, and answering it with more sending burns the sending domain instead.",
    distractors: [
      {
        text: "The volume, because the channel has not had a real chance yet",
        whyWrong:
          "Four thousand sends is a real chance. That answer is right for six hundred, which is " +
          "why the two cases have to be told apart before anybody changes anything.",
        realError: "Reaching for more volume because volume is the easier lever",
      },
      {
        text: "The follow up, because most replies come after several touches",
        whyWrong:
          "Plausible, and the corpus flags the statistic behind it as one nobody can source. " +
          "Fix follow up when the first touch works and stalls, not when nothing lands at all.",
        realError: "Citing the follow up statistic that has no primary source",
      },
    ],
    source: "100M Leads, cold outreach problems",
    provenance: "directional",
  },
  {
    id: "outreach-not-yet-tested",
    section: "opening",
    unit: "cold-outreach",
    group: "diagnosing-a-channel",
    stem:
      "A rep sent six hundred cold emails over thirty days, booked three meetings, and wants to " +
      "drop the channel. What is the honest read on that evidence?",
    answer: "The channel has not been tested yet, because the sample and the window are both small",
    whyRight:
      "Twenty sends a day for a month cannot separate a weak message from too little data, and " +
      "thirty days is shorter than most sales cycles. Most channel does not work verdicts are this.",
    distractors: [
      {
        text: "The channel does not work for us and the effort belongs elsewhere",
        whyWrong:
          "That conclusion needs evidence this test cannot produce. Reps who draw it rebuild on a " +
          "new channel, hit the same wall at week four, and never finish anything.",
        realError: "Killing a channel before it has run at any real scale",
      },
      {
        text: "Three meetings from six hundred is fine, so scale the same message tenfold",
        whyWrong:
          "Scaling a message you have not yet judged multiplies whatever is wrong with it, and " +
          "the reputation cost of doing that at volume is not recoverable in a week.",
        realError: "Scaling before knowing whether the thing being scaled works",
      },
    ],
    source: "100M Leads, Rule of 100",
    provenance: "prescriptive",
  },
  {
    id: "outreach-length",
    section: "opening",
    unit: "cold-outreach",
    group: "writing-the-message",
    stem:
      "You are writing a first cold email to an owner who has never heard of us. How long should " +
      "the whole thing be before you send it?",
    answer: "Around five sentences, with one specific thing about them in it",
    whyRight:
      "A cold reader gives you a few seconds. Five sentences is enough for a reason, a specific " +
      "detail, a credential and an ask, and is short enough to be read at all.",
    distractors: [
      {
        text: "Long enough to explain what we do properly, so they can judge the fit",
        whyWrong:
          "Nobody judges fit in a cold inbox, they judge whether to keep reading. A complete " +
          "explanation is a complete explanation nobody reaches the end of.",
        realError: "Writing for a reader who has already decided to care",
      },
      {
        text: "Two lines, because the first email exists to get a reply and nothing else",
        whyWrong:
          "Too short to carry the specific detail that earns the reply. A two line note reads as " +
          "a template, which is what it usually is.",
        realError: "Cutting so far that nothing distinguishes the message",
      },
    ],
    source: "100M Leads, cold outreach",
    provenance: "prescriptive",
  },
  {
    id: "outreach-fake-unity",
    section: "opening",
    unit: "cold-outreach",
    group: "writing-the-message",
    stem:
      "A rep wants to open cold emails with the words as a fellow business owner, having never " +
      "run a business. What happens when an owner reads that?",
    answer: "They spot the claim, and discount everything after it",
    whyRight:
      "Shared identity is a strong opener when it is true. Claimed by a stranger it signals that " +
      "you know the lever exists and pulled it dishonestly, which is worse than not pulling it.",
    distractors: [
      {
        text: "It builds rapport, since owners prefer hearing from people like themselves",
        whyWrong:
          "The preference is real, which is exactly why the false version costs so much. The " +
          "reader is not comparing you to nobody, they are comparing you to someone honest.",
        realError: "Borrowing a tactic without the condition that makes it work",
      },
      {
        text: "Very little either way, because openers are skimmed anyway",
        whyWrong:
          "The opener is the one line that does get read, and an identity claim is the kind of " +
          "detail people check. This is the sentence they remember you by.",
        realError: "Assuming the opening line does not matter",
      },
    ],
    source: "Influence, Unity, manufactured unity",
    provenance: "prescriptive",
  },
  {
    id: "outreach-lead-decay",
    section: "opening",
    unit: "cold-outreach",
    group: "working-a-list",
    stem:
      "A rep has a list of nine hundred names, works the forty that look warmest, and leaves the " +
      "rest untouched for three months. What has happened to those names?",
    answer: "They have gone cold again, so the list has to be reworked or written off",
    whyRight:
      "Lists decay. A name nobody has worked for three months is worth roughly what a cold name " +
      "is worth, and the company has paid for data it never converted.",
    distractors: [
      {
        text: "Nothing much, since the contact details are still accurate",
        whyWrong:
          "Accuracy is not the decaying part. What decays is the timing, the context you had for " +
          "reaching out, and whatever was happening in their business when the list was built.",
        realError: "Treating a lead list as a static asset",
      },
      {
        text: "They improved, because more time has passed for the problem to get worse",
        whyWrong:
          "Sometimes true for one name, never true for a list. You cannot plan around a change " +
          "you did not observe and were not there for.",
        realError: "Rationalising an unworked list as ripening",
      },
    ],
    source: "100M Leads, lead hoarding",
    provenance: "prescriptive",
  },

  // =========================================================================
  // DIAGNOSIS. What you ask once you have the meeting.
  // =========================================================================
  {
    id: "spin-researchable",
    section: "diagnosis",
    unit: "asking-well",
    group: "question-choice",
    stem:
      "You are opening a booked discovery call. Their headcount, their locations and their " +
      "software are all on their website. Which of these belongs in the call?",
    answer: "Ask what breaks when the business gets busy, since no site will tell you that",
    whyRight:
      "Questions you could have answered by looking cost you the credibility the meeting was " +
      "granted on, and they eat the minutes you need for the ones only they can answer.",
    distractors: [
      {
        text: "Ask them to walk you through their business so you both start level",
        whyWrong:
          "It is the most common opening and it announces that you did not prepare. They know " +
          "their business better than you ever will; that is not where your value is.",
        realError: "Opening with a broad background question to fill the first minutes",
      },
      {
        text: "Confirm the facts you found, so they know you did your homework",
        whyWrong:
          "Reading their website back to them proves you can read. Use the research to ask a " +
          "sharper question, which is the thing that actually demonstrates preparation.",
        realError: "Performing research instead of using it",
      },
    ],
    source: "SPIN Selling, situation questions",
    provenance: "verified",
  },
  {
    id: "spin-sad-or-happy",
    section: "diagnosis",
    unit: "asking-well",
    group: "question-choice",
    stem:
      "An owner has agreed that their intake process is slow. You want to build the value of " +
      "fixing it rather than deepen the pain. Which question does that?",
    answer: "If intake handled itself, what would change for your team",
    whyRight:
      "There is a clean test for these two. Questions about the cost of the problem are sad; " +
      "questions about the value of the solution are happy. This one is happy, which is the job.",
    distractors: [
      {
        text: "What is it costing you each month that intake runs this way",
        whyWrong:
          "That is a good question in the wrong slot. It makes the problem bigger, which you have " +
          "already done. Asked again here it keeps them in the pain rather than moving them out.",
        realError: "Mislabelling a cost question as a value question",
      },
      {
        text: "How many people does slow intake end up affecting downstream",
        whyWrong:
          "Also about the size of the damage. Useful earlier, but it does not get them describing " +
          "what they want, which is the sentence you need them to say out loud.",
        realError: "Staying on the problem after it has been established",
      },
    ],
    source: "SPIN Selling, need-payoff questions",
    provenance: "prescriptive",
  },
  {
    id: "spin-implied-not-signal",
    section: "diagnosis",
    unit: "reading-the-answer",
    group: "buying-signals",
    stem:
      "Halfway through a discovery call the owner says yeah, that is a problem for us. What have " +
      "you actually got at that moment?",
    answer: "An admission there is a problem, which is not the same as wanting it solved",
    whyRight:
      "On a larger sale that sentence is a stage, not a signal. What you need is them saying they " +
      "want something fixed, in their words, before anything you describe counts as a benefit.",
    distractors: [
      {
        text: "A buying signal, so this is the moment to show what we would do about it",
        whyWrong:
          "This is the most expensive misread available on a discovery call. Moving to solution " +
          "here is what produces the price objection twenty minutes later.",
        realError: "Reading an admitted problem as intent to buy",
      },
      {
        text: "Very little, because owners call almost anything a problem",
        whyWrong:
          "Too dismissive. It is genuine progress, and it is the thing you build on. Discarding " +
          "it means you start over rather than going one question deeper.",
        realError: "Discounting real progress and restarting discovery",
      },
    ],
    source: "SPIN Selling, implied and explicit needs",
    provenance: "verified",
  },
  {
    id: "momtest-hypothetical",
    section: "diagnosis",
    unit: "getting-true-answers",
    group: "question-choice",
    stem:
      "You are trying to work out whether a problem is real for an owner, before anything has " +
      "been scoped. Which question gets you an answer you can trust?",
    answer: "Talk me through the last time that happened to you",
    whyRight:
      "Past behaviour is checkable and specific. It gets you a date, a cost and who was involved, " +
      "none of which a person can invent as easily as an opinion about the future.",
    distractors: [
      {
        text: "Would you use something that fixed this for you",
        whyWrong:
          "Everybody says yes to that, which is why the answer carries no information. It feels " +
          "like validation and it is the reason people build things nobody buys.",
        realError: "Asking a hypothetical and banking the yes",
      },
      {
        text: "How much would you pay to have this solved",
        whyWrong:
          "A number feels rigorous and is still a guess, made by someone with no reason to be " +
          "accurate and every reason to be polite.",
        realError: "Treating an invented number as research",
      },
    ],
    source: "The Mom Test, the three rules",
    provenance: "prescriptive",
  },
  {
    id: "momtest-compliment",
    section: "diagnosis",
    unit: "getting-true-answers",
    group: "handling-a-non-answer",
    stem:
      "You describe what Oasis does and the owner says that is really cool, I love it. What is " +
      "the right next sentence out of your mouth?",
    answer: "Thanks. How are you handling this at the moment",
    whyRight:
      "A compliment is the politest way to say nothing. Deflect it and get back to what they " +
      "actually do today, which is the only part of the conversation with information in it.",
    distractors: [
      {
        text: "Ask which part they liked most, so you know what to lead with next time",
        whyWrong:
          "It builds a whole strategy on a sentence designed to be agreeable. You will optimise " +
          "toward whatever is most pleasant to say yes to.",
        realError: "Mining a compliment for signal",
      },
      {
        text: "Move to next steps, since they have told you they like it",
        whyWrong:
          "Nothing has been established except goodwill. Proposing a step here gets a warm yes " +
          "and a cold calendar, which is the classic polite rejection.",
        realError: "Reading enthusiasm as commitment",
      },
    ],
    source: "The Mom Test, three types of bad data",
    provenance: "prescriptive",
  },
  {
    id: "momtest-vs-spin",
    section: "diagnosis",
    unit: "getting-true-answers",
    group: "question-choice",
    stem:
      "Oasis has a defined thing to sell and a validated market. On a booked call with a real " +
      "buyer, should you run it the way you would run a research interview?",
    answer: "No, because research questions and selling questions are built for opposite jobs",
    whyRight:
      "Research forbids asking whether they would find something useful. Selling depends on that " +
      "exact question once a need is explicit. Blending them does neither job.",
    distractors: [
      {
        text: "Yes, since asking about their life rather than your idea is the safer instinct",
        whyWrong:
          "It is the right rule before there is a product. Applied to a real buyer it produces a " +
          "pleasant conversation, no proposal, and a call logged as going well.",
        realError: "Running discovery as research long after the product exists",
      },
      {
        text: "Yes, because a discovery call is a research call with a different name",
        whyWrong:
          "They share a tone and nothing else. A discovery call that is secretly a research call " +
          "fails at both, and the corpus says so in those words.",
        realError: "Treating discovery and research as the same conversation",
      },
    ],
    source: "SPIN and The Mom Test, integration notes",
    provenance: "prescriptive",
  },

  // =========================================================================
  // OFFER.
  // =========================================================================
  {
    id: "offer-lower-the-bottom",
    section: "offer",
    unit: "building-the-offer",
    group: "value-levers",
    stem:
      "An owner wants the outcome you are describing but does not believe it can happen in his " +
      "business. You cannot make the outcome any bigger. What do you work on instead?",
    answer: "How long it takes and how much he has to do, because those are the other levers",
    whyRight:
      "Value moves on four things, and two of them are how long the wait is and how much effort " +
      "it costs him. When you cannot raise the top of that, you lower the bottom.",
    distractors: [
      {
        text: "Describe the outcome more vividly until it lands",
        whyWrong:
          "He is not failing to imagine it, he is failing to believe it. Repeating the promise " +
          "louder pushes on the one part of the equation that is already at its limit.",
        realError: "Restating the promise when the objection is belief",
      },
      {
        text: "Offer to reduce the commitment so the decision feels smaller",
        whyWrong:
          "Close, and it is the wrong end. Shrinking the deal changes what he gets, not what he " +
          "believes. Shorten the wait and the work first, and see whether the belief follows.",
        realError: "Discounting scope in answer to a credibility problem",
      },
    ],
    source: "100M Offers, the value equation",
    provenance: "prescriptive",
  },
  {
    id: "offer-defensible-value",
    section: "offer",
    unit: "building-the-offer",
    group: "value-levers",
    stem:
      "You are listing what an owner gets, and you want each line to carry weight. What has to " +
      "be true of every figure you attach to those lines?",
    answer: "He could check it himself and reach roughly the same conclusion",
    whyRight:
      "A value figure he cannot verify is one he will eventually test. Numbers that do not " +
      "survive contact turn into refund requests and into a story he tells other owners.",
    distractors: [
      {
        text: "It should be ambitious, so the total clearly outweighs what he pays",
        whyWrong:
          "The gap matters and inflating it is how people reach for it. An unverifiable total is " +
          "worth less than a smaller one he believes.",
        realError: "Inflating a stack because the ratio is what gets taught",
      },
      {
        text: "It should match what competitors charge for the same component",
        whyWrong:
          "Comparable pricing is evidence, not a licence. If you cannot explain how the figure " +
          "applies to his business, pointing at somebody else's rate card does not fix that.",
        realError: "Borrowing a number instead of justifying one",
      },
    ],
    source: "100M Offers, integration notes on honest claims",
    provenance: "prescriptive",
  },
  {
    id: "offer-scarcity-gate",
    section: "offer",
    unit: "building-the-offer",
    group: "pressure-and-when",
    stem:
      "You are working a long deal with several people involved on their side. A colleague " +
      "suggests closing with a deadline on the offer. What does the evidence say about that here?",
    answer: "It tends to backfire on a larger sale, whatever it does on a small one",
    whyRight:
      "The two frameworks genuinely disagree, and the disagreement resolves on deal shape. " +
      "Pressure works where one person decides quickly. It reads as desperation where many do not.",
    distractors: [
      {
        text: "Use it, because a deadline creates the urgency that gets decisions made",
        whyWrong:
          "True on a fast single decision, and this is not one. Several people have to justify " +
          "the choice internally, and an artificial deadline gives them a reason to wait you out.",
        realError: "Applying small sale pressure to a committee deal",
      },
      {
        text: "Avoid it entirely, since pressure tactics are manipulative wherever they appear",
        whyWrong:
          "Too broad, and it throws away a legitimate tool. Real scarcity honestly stated is fine. " +
          "What fails here is the deal shape, not the ethics.",
        realError: "Replacing a judgment call with a blanket rule",
      },
    ],
    source: "SPIN, Influence and 100M Offers, integration notes",
    provenance: "prescriptive",
  },

  // =========================================================================
  // OBJECTIONS. The live engine is the catalogue; these teach posture and
  // prevention, which is the part a catalogue cannot hold.
  // =========================================================================
  {
    id: "obj-posture-true",
    section: "objections",
    unit: "postures",
    group: "which-posture",
    stem:
      "An owner says something about his own business that is simply true, and arguing with it " +
      "would end the conversation. Which move do you make?",
    answer: "Agree with it plainly, then move to the part he has not considered",
    whyRight:
      "Agreement costs nothing when he is right, and it is the only move that keeps the call " +
      "alive. The redirect is where the work happens, and it only lands after the agreement.",
    distractors: [
      {
        text: "Ask a question back, so he examines whether it really holds",
        whyWrong:
          "Questioning a true statement reads as not listening. Save that move for a claim that " +
          "is a guess, which this is not.",
        realError: "Reaching for the questioning move regardless of whether the claim is true",
      },
      {
        text: "Show him the cost of thinking that way",
        whyWrong:
          "Reframing a true statement as expensive tells him he is wrong in a longer sentence. " +
          "He will hear the disagreement and not the reframe.",
        realError: "Reframing when the objection is accurate",
      },
    ],
    source: "Oasis objection engine, the four postures",
    provenance: "ours",
  },
  {
    id: "obj-posture-guess",
    section: "objections",
    unit: "postures",
    group: "which-posture",
    stem:
      "An owner objects on the basis of something he clearly has not checked, or that is about " +
      "his own experience rather than his customers. Which move fits?",
    answer: "Ask a question back, so he hears himself test it",
    whyRight:
      "When the claim is a guess, the fastest route is him finding the hole rather than you " +
      "pointing at it. A conclusion he reached himself is one he will not argue against.",
    distractors: [
      {
        text: "Agree with it, then redirect to something he has not thought about",
        whyWrong:
          "Agreeing with a guess makes it a fact for the rest of the call, and you will have to " +
          "unpick it later against your own agreement.",
        realError: "Agreeing reflexively to keep the call pleasant",
      },
      {
        text: "Take the objection away and offer him a clean exit",
        whyWrong:
          "Far too early. That move is for reflexive pushback you want off the table, not for a " +
          "claim that will not survive one question.",
        realError: "Backing off a claim that was about to collapse on its own",
      },
    ],
    source: "Oasis objection engine, the four postures",
    provenance: "ours",
  },
  {
    id: "obj-created-by-you",
    section: "objections",
    unit: "prevention",
    group: "where-objections-come-from",
    stem:
      "A rep keeps hitting the same objection in the first few minutes of call after call. Where " +
      "should they look for the cause?",
    answer: "At what they say before it, because early objections are usually made by the seller",
    whyRight:
      "Objections early in a call track talking about solutions before a need has been built. " +
      "The fix is upstream in what gets said first, never downstream in a better rebuttal.",
    distractors: [
      {
        text: "At their rebuttals, since the same objection means the answer is not working",
        whyWrong:
          "Sharpening the rebuttal optimises the symptom and guarantees you keep meeting it. A rep " +
          "with twelve polished rebuttals is a rep generating twelve objections.",
        realError: "Drilling rebuttals for an objection that should not be occurring",
      },
      {
        text: "At the list, because the objection says these are the wrong people to call",
        whyWrong:
          "Possible, and it is the expensive thing to conclude first. The same objection at the " +
          "same point in every call points at the script, not the names.",
        realError: "Blaming the list for a repeatable pattern in the call",
      },
    ],
    source: "SPIN Selling, objection prevention",
    provenance: "verified",
  },

  // =========================================================================
  // ADVANCING. The part that decides whether the call was worth making.
  // =========================================================================
  {
    id: "adv-advance-vs-continuation",
    section: "advancing",
    unit: "what-counts-as-success",
    group: "judging-a-call",
    stem:
      "A call ends with the owner saying that was a great conversation, let us talk again soon. " +
      "Nothing is booked. How should the rep record that call?",
    answer: "As a call that did not succeed, because no action was agreed",
    whyRight:
      "A call succeeds when they do something specific next. Warm words with no date are the most " +
      "common way a pipeline turns into fiction, and everyone involved feels good about it.",
    distractors: [
      {
        text: "As a success, since the relationship clearly moved forward",
        whyWrong:
          "Judge these on actions, not words. Compliments are not a sign of a call that worked, " +
          "and logging them as one is how a forecast stops meaning anything.",
        realError: "Scoring a call on how it felt",
      },
      {
        text: "As a failure, and take them out of the pipeline",
        whyWrong:
          "Too far. It did not succeed, which is a different thing from being dead. The rep owes " +
          "it another attempt with a specific ask attached.",
        realError: "Discarding a live account over one unsuccessful call",
      },
    ],
    source: "SPIN Selling, the four call outcomes",
    provenance: "verified",
  },
  {
    id: "adv-one-close",
    section: "advancing",
    unit: "what-counts-as-success",
    group: "closing-behaviour",
    stem:
      "A rep is nervous about being pushy, so they end calls without asking for anything specific. " +
      "What does the research on closing attempts say about that habit?",
    answer: "Asking nothing performs worse than asking once, clearly",
    whyRight:
      "The curve has a peak in the middle. One clear proposal beats zero by a wide margin, and " +
      "beats three or more by a wider one. Not asking is not the safe option, it is the low one.",
    distractors: [
      {
        text: "It is the safer habit, since pushing costs you deals you would otherwise win",
        whyWrong:
          "Pushing repeatedly does cost deals, and that is a different behaviour. Silence has its " +
          "own cost and it is larger than a single ask.",
        realError: "Treating no ask as the conservative choice",
      },
      {
        text: "It makes little difference, since asking is not what decides a good call",
        whyWrong:
          "Calls do not close themselves, and the measured gap between asking once and not asking " +
          "at all is the largest step on the curve.",
        realError: "Believing good discovery removes the need to propose anything",
      },
    ],
    source: "SPIN Selling, the closing studies",
    provenance: "directional",
  },
  {
    id: "adv-tell-dont-ask",
    section: "advancing",
    unit: "what-counts-as-success",
    group: "closing-behaviour",
    stem:
      "You have built a real need and it is time to propose the next step. Which form of words " +
      "gives you the best chance of getting it?",
    answer: "The next step would be a short session with your operations lead",
    whyRight:
      "Proposing a specific step, stated rather than requested, gives them something concrete to " +
      "accept or adjust. It is also the highest realistic commitment rather than the easiest.",
    distractors: [
      {
        text: "Would you like to move forward with this",
        whyWrong:
          "Open ended, and it invites a no as the least effortful answer. It also names no action, " +
          "so even a yes leaves you without a date.",
        realError: "Asking for agreement instead of proposing a step",
      },
      {
        text: "Let me know if you want to take this further at some point",
        whyWrong:
          "This hands the next move to the person with the least reason to make it. It is how a " +
          "good call becomes a warm conversation that never happens again.",
        realError: "Leaving the next action with the buyer",
      },
    ],
    source: "SPIN Selling, obtaining commitment",
    provenance: "prescriptive",
  },
  {
    id: "adv-clean-no",
    section: "advancing",
    unit: "what-counts-as-success",
    group: "judging-a-call",
    stem:
      "An owner tells you plainly that this is not something he is going to do, and gives you a " +
      "straight reason. What is that outcome worth to the rep?",
    answer: "A good deal, because it frees the time a maybe would have consumed",
    whyRight:
      "A clean no is cheap and quick. What costs a rep their quarter is a queue of polite maybes " +
      "that each need chasing and none of which close.",
    distractors: [
      {
        text: "Almost nothing, since a no produces no revenue",
        whyWrong:
          "It produces capacity, which is the scarce thing. Counting only revenue is what keeps " +
          "dead deals in a pipeline for months.",
        realError: "Valuing outcomes only by whether they closed",
      },
      {
        text: "A setback worth one more attempt to change his mind",
        whyWrong:
          "Arguing with a stated reason converts a cheap no into an expensive one and costs you " +
          "the referral and the callback in a year.",
        realError: "Treating a clear no as an objection to be overcome",
      },
    ],
    source: "Oasis call guidance, authored by us",
    provenance: "ours",
  },

  // =========================================================================
  // GUARDRAILS. The things that are policy rather than technique.
  // =========================================================================
  {
    id: "guard-no-number",
    section: "guardrails",
    unit: "what-you-may-say",
    group: "commitments",
    stem:
      "An owner presses you for a figure on the call, twice, and says he cannot take it to his " +
      "partner without one. What do you say?",
    answer: "That it depends on what the work turns out to be, and offer to scope it quickly",
    whyRight:
      "No approved figure exists to quote, and the honest version of that is a next step rather " +
      "than a refusal. Scoping it fast is what he actually needs to take to his partner.",
    distractors: [
      {
        text: "Give him a range, with the caveat that it could move either way",
        whyWrong:
          "A range is a quote. The bottom of it is what gets repeated to the partner, and every " +
          "conversation after that is a negotiation down from a number you invented.",
        realError: "Treating a hedged range as not really a price",
      },
      {
        text: "Tell him pricing is not something you are able to discuss",
        whyWrong:
          "Accurate and useless. It sounds evasive, and it leaves him with the same problem he " +
          "had before he asked, which is the thing that loses the deal.",
        realError: "Refusing without offering the path that answers the real need",
      },
    ],
    source: "Oasis guardrails, pending the pricing decision",
    provenance: "ours",
  },
  {
    id: "guard-autonomy",
    section: "guardrails",
    unit: "what-you-may-say",
    group: "commitments",
    stem:
      "An owner asks whether the agents can just run his back office overnight without anyone " +
      "checking. What can you commit to?",
    answer: "That people approve what matters, and the system does the rest",
    whyRight:
      "The course is explicit that unattended autonomy over sensitive systems is not something we " +
      "promise. What we do promise is real and is usually what he wanted anyway.",
    distractors: [
      {
        text: "That it can, once it has learned how his business runs",
        whyWrong:
          "This is the promise the course names and refuses. It survives exactly until the first " +
          "decision somebody wishes a human had seen.",
        realError: "Promising autonomy because the buyer asked for it",
      },
      {
        text: "That nothing happens without a person approving each step",
        whyWrong:
          "Undersells it in a way that removes the reason to buy. The system does plenty on its " +
          "own; the approvals sit on the consequential decisions.",
        realError: "Overcorrecting into a product nobody would want",
      },
    ],
    source: "OASIS Sales Training Course, Offer 18",
    provenance: "ours",
  },
  {
    id: "guard-unsure-scope",
    section: "guardrails",
    unit: "what-you-may-say",
    group: "commitments",
    stem:
      "An owner asks for something and you genuinely do not know whether Oasis sells it or can " +
      "build it. He is waiting for an answer. What do you say?",
    answer: "That you do not know, and you will find out and come back today",
    whyRight:
      "Not knowing is fine and checkable. Guessing creates a commitment nobody else agreed to, " +
      "and the person who finds out is whoever has to deliver it.",
    distractors: [
      {
        text: "That it sounds like something we can do, and confirm the detail later",
        whyWrong:
          "He hears yes. The later confirmation lands after he has already made plans, which is " +
          "the most expensive moment to take something back.",
        realError: "Softening a guess into a provisional yes",
      },
      {
        text: "That it is outside what we do, to avoid promising anything",
        whyWrong:
          "You may have just refused work we do. Declining on a guess is the same error as " +
          "accepting on one, and it is harder to notice.",
        realError: "Guessing in the cautious direction and calling it discipline",
      },
    ],
    source: "OASIS Sales Training Course, the four offer labels",
    provenance: "ours",
  },
];

/** Items in the same group, which are the ones confusable with each other.
 *  Used for interleaving, no longer for generating decoys. */
export function groupPeers(item: DrillItem): DrillItem[] {
  return ITEMS.filter((i) => i.group === item.group);
}

/** Every item in a section, in curriculum order. */
export function itemsForSection(section: string): DrillItem[] {
  return ITEMS.filter((i) => i.section === section);
}

/** Every item in one unit. A unit is what a rep finishes in a sitting. */
export function itemsForUnit(unit: string): DrillItem[] {
  return ITEMS.filter((i) => i.unit === unit);
}

/** The units in a section, in the order they first appear. */
export function unitsForSection(section: string): string[] {
  const seen: string[] = [];
  for (const i of ITEMS) {
    if (i.section === section && !seen.includes(i.unit)) seen.push(i.unit);
  }
  return seen;
}
