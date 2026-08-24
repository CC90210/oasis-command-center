/**
 * lib/web-leads/angles.ts — the one idea a rep opens with, and the objections
 * that arrive no matter which idea it was.
 *
 * Design spec 2026-08-24, §5. Seven angles, one per dimension, selected by
 * which dimension is losing the site the most composite points. NOT forty-nine:
 * a rep opens a call with a single idea, and a list of nine talking points is a
 * rep improvising a tenth.
 *
 * ═══ WHY THIS IS NOT GENERATED ══════════════════════════════════════════════
 *
 * A model writing per-lead sales copy will eventually assert "your site takes
 * eight seconds to load" about a site we measured at two, and a rep will say it
 * aloud to a stranger. That is the worst outcome this system can produce, and
 * it is not preventable by prompt. So this is a fixed table, same discipline as
 * remedies.ts, and it is unit-tested for completeness -- a dimension with no
 * angle is a hole in the product, not a cosmetic gap.
 *
 * ═══ WHERE THIS COPY CAME FROM (research, 2026-08-24) ═══════════════════════
 *
 * The operator's instruction was to stop writing from intuition: *"if you do
 * enough market research I'm sure you can come up with ideas that are even
 * better than mine... I also think it's important to be adding new
 * perspective."* So the structure below is not a style choice. Each field
 * exists because a specific school of selling says it has to, and where two
 * schools contradicted each other the disagreement is named and taken a side
 * on rather than averaged into mush.
 *
 * ── The five schools consulted ─────────────────────────────────────────────
 *
 * 1. CONSULTATIVE / DIAGNOSTIC (Sandler pain funnel; Rackham's SPIN). Ask, do
 *    not tell. Rackham's Huthwaite study observed 35,000 live sales calls by
 *    10,000 sellers across 23 countries over 12 years; its most useful finding
 *    here is not about closing at all, it is that top performers PREVENT
 *    objections rather than handle them. Average reps collected two to three
 *    objections a call, top performers fewer than one, using the same answers.
 *    The difference was sequencing: a benefit stated before the buyer has
 *    admitted the matching problem manufactures the objection to it.
 *      -> Why the `diagnostic` field exists, and why every objection below
 *         carries a `prevent` line as well as a `response`.
 *      Source: Neil Rackham, SPIN Selling (McGraw-Hill, 1988); Huthwaite
 *      International, huthwaiteinternational.com/spin-methodology.
 *
 * 2. CHALLENGER (Dixon & Adamson, 2011). Teach the prospect something about
 *    their own business they did not already know, reframe the problem, then
 *    connect it to what you sell. A "commercial insight" is not information,
 *    it is a correction to how they were thinking.
 *      -> Why `cost` is written as a teach block and not as a feature list,
 *         and why the word-of-mouth objection below reframes rather than
 *         argues.
 *
 * 3. COLD-CALL OUTCOME DATA (Gong Labs, 300M+ recorded cold calls, published
 *    2024-07-24). Saying the reason for your call outright lifts the success
 *    rate 2.1x. The worst opener they measured is "Did I catch you at a bad
 *    time?" at 2.15%; a permission opener that names a specific duration
 *    measured 11.18%. Successful cold calls also run about twice as long as
 *    failed ones, and the rep talks roughly 55% of the time.
 *      -> Why `opener` is a STATEMENT that names a duration and a reason.
 *
 * 4. LOCAL / SMB WEB-DESIGN FIELD PRACTICE. A distinct market: owner-operators,
 *    low trust, price anchored low, and very often a website built by a family
 *    member who is now emotionally in the room. The recurring field lesson is
 *    that the pitch which opens by criticising the site loses the call outright
 *    ("nothing says hire me like a sales pitch that starts out 'your website is
 *    crap'"). The useful move from the vendor literature is turning "I could
 *    build one myself" into "why haven't you already?"
 *      -> Why NO opener names the defect as a defect. Every one names a
 *         behaviour of the prospect's own customer instead.
 *      Source: SiteSwan, "5 Common Sales Objections Web Designers Face."
 *
 * 5. BEHAVIOURAL FRAMING (Kahneman & Tversky prospect theory; Rothman &
 *    Salovey on gain vs loss frames). Losses land about twice as hard as
 *    equivalent gains, which argues for loss framing throughout. But Rothman
 *    and Salovey's split says gain frames win for PREVENTION behaviours -- the
 *    ones with a certain up-front cost and a diffuse future benefit -- and
 *    later meta-analysis (O'Keefe & Jensen) found the loss advantage for
 *    detection behaviours is small and inconsistent anyway. Buying a website is
 *    a prevention behaviour.
 *      -> So the frame SWITCHES mid-angle, on purpose: `cost` is loss-framed
 *         (who is not calling you), `build` is gain-framed (here is what it
 *         does). Loss to open the wound, gain to close it.
 *
 * ── Where the schools disagreed, and what was chosen ───────────────────────
 *
 * A. QUESTION OR STATEMENT FIRST? Sandler says the opener should be a question.
 *    Gong's 300M-call data says the top-measured openers are statements that
 *    name a reason, and that permission-seeking which does not name one is the
 *    worst thing measured. CHOSEN: both, in order. `opener` is a stated
 *    permission-plus-reason block of about twenty seconds; `diagnostic` is the
 *    question that immediately follows it. They are not actually in conflict,
 *    they operate on different beats of the same minute: Gong's data is about
 *    earning the next thirty seconds, Sandler's is about what to do with them
 *    once earned.
 *
 * B. "IS NOW A BAD TIME?" Chris Voss argues for no-oriented questions because
 *    a "no" makes the other person feel safe and in control. Gong measured that
 *    exact phrasing as their single worst opener. CHOSEN: Gong, for the literal
 *    phrase. A measured outcome over 300M calls of this specific behaviour
 *    outranks a mechanism argument carried over from hostage negotiation. But
 *    Voss's mechanism is kept: every `diagnostic` is a question the prospect
 *    can answer honestly, including with a no, without the call ending.
 *
 * C. TALK OR LISTEN? Sandler says talk less, listen more. Gong found the rep
 *    talks 55% of the time on SUCCESSFUL cold calls, with monologues averaging
 *    53 seconds against 25 on failed ones. CHOSEN: Gong for the cold call,
 *    Sandler for everything after it. A first call to an owner-operator is not
 *    a discovery call in a complex enterprise cycle, and Rackham himself found
 *    the large-sale findings do not transfer down to small ones. So the shape
 *    is: talk (opener), ask one question (diagnostic), stop talking, then teach
 *    for about a minute (cost) only once they have answered.
 *
 * ═══ WHAT WE ARE ALLOWED TO SAY ═════════════════════════════════════════════
 *
 * NOT ONE SPOKEN SENTENCE MENTIONS A NUMBER. Every angle names a behaviour the
 * prospect can check on their own phone while the rep is talking. The measured
 * numbers live in the audit and are rendered beside this, from the audit, where
 * they are true by construction. Copy that quotes a measurement is copy that
 * can be wrong about a specific business.
 *
 * We have NO revenue data for these businesses. Not a dollar of it. So nothing
 * here says "you are losing $X a month" and nothing here ever will. The cost is
 * always stated in customer behaviour, never in money.
 *
 * `proof` is the one place a number is allowed, and it is NOT part of the
 * pitch. It is what a rep reaches for only when a prospect pushes back on the
 * general claim, and every one of them cites its study, its sample and its year
 * so a rep who gets challenged can go and find it. Four angles have no proof,
 * deliberately: the widely-quoted click-to-call conversion figures ("calls
 * convert 10-12x better than forms") could not be traced past SEO blogs to any
 * primary source, so they are left out rather than repeated. Do not add a stat
 * here without a source you have actually opened.
 *
 * CANADA: these are cold VOICE calls, which CASL does not govern (it covers
 * commercial electronic messages) and which are exempt from the National DNCL
 * for business-to-business under the CRTC's Unsolicited Telecommunications
 * Rules -- but the caller must identify themselves and honour an internal
 * do-not-call list. Nothing in this file implies we may email or text them.
 * Sending anything afterwards needs consent, and the "send me an email"
 * objection below is written around getting that consent properly.
 *
 * The rep's own name and company introduction comes BEFORE `opener` and is not
 * written here, because it is the rep's own and because CRTC rules require it.
 */

export type Angle = {
  /**
   * Beat one, STATED, about twenty seconds. Permission plus the reason for the
   * call, per the Gong data: naming the reason outright measured 2.1x, and
   * soft permission-seeking that does not name one measured worst of all.
   * Never names the defect as a defect. Names a behaviour of their customer.
   */
  opener: string;
  /**
   * Beat two, ASKED, then silence. Sandler's move: the prospect finds the gap
   * themselves and cannot argue with a conclusion they reached. Also Rackham's
   * objection-prevention, since a benefit stated before the problem is admitted
   * manufactures the objection to it. Answerable with a no without ending the
   * call, which is the one thing kept from Voss.
   */
  diagnostic: string;
  /**
   * Beat three, TAUGHT, only after they have answered. The Challenger reframe,
   * loss-framed, in customers and behaviour. Never in dollars: we have no
   * revenue data for these businesses.
   */
  cost: string;
  /** The push-back this specific angle actually gets, and the answer to it. */
  objection: { says: string; response: string };
  /**
   * What we would build, gain-framed, so it doubles as scope for the sale.
   * Gain rather than loss on purpose: buying a website is a prevention
   * behaviour with a certain up-front cost, which is where gain framing wins.
   */
  build: string;
  /**
   * Held in reserve. Only if they challenge the general claim, never as part of
   * the pitch. Must cite a study a rep can actually go and find.
   */
  proof?: { stat: string; source: string };
};

/**
 * Keyed by the dimension keys JARVIS's quality-model.js emits: conversion,
 * trust, design, mobile, content, performance, discoverability.
 */
export const ANGLES: Record<string, Angle> = {
  conversion: {
    opener:
      "Give me twenty seconds and then tell me whether it is worth carrying on. The reason I am calling is that I went through your website the way one of your customers would, from a phone, and there is one thing I ran into that I wanted to ask you about.",
    diagnostic:
      "When somebody lands on your site on their phone and decides right then that they want to talk to you, what do they actually do next? Walk me through it.",
    cost:
      "Here is what happened when I tried it. There was no obvious way to just start the call from the page. That matters more than it sounds like, because the people arriving that way are the ones who are already ready. They are not researching you, they are choosing between you and two other names. A number somebody has to memorise and dial by hand is a number a fair share of them never dial, and you never hear from any of those people, so it never turns up as a problem. It turns up as a quiet month.",
    objection: {
      says: "We get plenty of calls.",
      response:
        "I believe you, and the ones you get are the ones who were willing to work for it. I am talking about the ones who were not. You would never hear from either group, so the only thing separating them is whether the page made it easy.",
    },
    build:
      "Tap to call in the header of every page, a short form underneath it for the people who would rather write than talk, and a call button that stays on screen on a phone while they scroll.",
  },

  trust: {
    opener:
      "Give me twenty seconds. The reason I am calling is that I looked at your site the way somebody who had never heard of you would, and there was a question I could not answer from it.",
    diagnostic:
      "When somebody is choosing between you and two other places they found the same afternoon, what is the thing that makes them pick you?",
    cost:
      "Whatever you just told me, none of it is on the page. Somebody who already knows you does not need it there. Somebody who does not know you is standing in front of three names looking for a reason to believe one of them, and if your page does not hand them one, they leave the page to go and find it. Where they go looking is exactly where your competitors are.",
    objection: {
      says: "Our reviews are all on Google.",
      response:
        "Good, and that is a trip off your site to go and find them. Most people check more than one place before they decide anything, so the reviews that do the work are the ones sitting where the decision is actually being made.",
    },
    build:
      "Your best reviews on the site itself with names and the town they are in, your licence and insurance stated plainly, and whatever guarantee you already give a customer written down where they can see it.",
    proof: {
      stat:
        "74% of consumers check two or more review sites before deciding, and only 42% now trust reviews as much as a recommendation from a friend, down from 79% in 2020. Trust is getting harder to earn and it is spread across more places than it used to be.",
      source:
        "BrightLocal, Local Consumer Review Survey 2025 (1,026 US adults, SurveyMonkey). brightlocal.com/research/local-consumer-review-survey-2025/",
    },
  },

  design: {
    opener:
      "Give me twenty seconds. The reason I am calling is about the first second somebody spends on your website, before they have read a single word of it.",
    diagnostic:
      "When was the site last properly touched? Not the wording on it, the actual look of the thing.",
    cost:
      "The reason I ask is that people decide whether a business is still going and still any good off nothing but how the page looks, and they do it before they read anything on it. A dated site does not read as thrifty and it does not read as established. To somebody who has never met you it reads as a business that might not pick up the phone.",
    objection: {
      says: "Our customers do not care what it looks like.",
      response:
        "Your customers do not, and you are right about that. They already know you and they are not on the site anyway. This is about the person who has never heard of you and has four other tabs open.",
    },
    build:
      "A rebuild on your own look rather than a template, current type and layout, your real photographs instead of stock ones, and your logo used properly on every page.",
    proof: {
      stat:
        "Stanford asked 2,684 people why they did or did not believe a website. The look of the site was the single most cited reason, in 46% of the comments, ahead of the information on it. One warning: the '75% of people judge your business by your website' line that circulates online is not from that study and is not sourced anywhere. Do not use it. It is exactly the kind of thing a prospect looks up afterwards.",
      source:
        "Fogg, Soohoo, Danielson, Marable, Stanford and Tauber, 'How do users evaluate the credibility of Web sites?', Proceedings of DUX 2003, Stanford Persuasive Technology Lab. 2,684 participants.",
    },
  },

  mobile: {
    opener:
      "Give me twenty seconds. The reason I am calling is that I would like you to pull your own website up on your phone while we are talking, because I think you will see this faster than I can describe it.",
    diagnostic:
      "Have a look at it now. Can you get to your phone number without pinching the screen?",
    cost:
      "That is the whole thing, really. On a phone, a site built for a computer means dragging and pinching just to read one sentence, and nobody does that for a business they have not chosen yet. They go back to the search results and pick whoever came up properly. And most of the people seeing your site for the first time are seeing it exactly the way you are seeing it right now.",
    objection: {
      says: "It looks fine on my phone.",
      response:
        "Then try the menu, and then try finding your opening hours. That is usually where it goes, and it is the part that costs you, because that is the last thing somebody checks before they decide to ring.",
    },
    build:
      "A layout that reflows properly on every screen size, a menu built for a thumb rather than a mouse, and your number and your hours reachable without a single pinch.",
  },

  content: {
    opener:
      "Give me twenty seconds. The reason I am calling is that I read your homepage twice and there were three things I still could not have told you afterwards.",
    diagnostic:
      "If I had never heard of you, where on your site would I find what you actually do, the area you cover, and roughly what it costs?",
    cost:
      "Somebody comparing three businesses gives each one a few seconds to answer those exact three questions. The one that answers them gets the call, even when it is not the best of the three. It is not a competition about who is better. It is a competition about who is clear, and the second one is a great deal easier to win.",
    objection: {
      says: "Everyone around here already knows what we do.",
      response:
        "The people who know you are not the ones on the site. The ones on the site are the ones who do not, and everybody who moved into the area this year is in that group.",
    },
    build:
      "A homepage that answers those three questions before anybody has to scroll, and then a separate page for each service so each one can be found and read on its own.",
  },

  performance: {
    opener:
      "Give me twenty seconds. The reason I am calling is about how long your site takes to come up for somebody who has never opened it before.",
    diagnostic:
      "When you send somebody your website, on their data rather than on your own wifi, how long does it sit there before anything appears?",
    cost:
      "A page that takes its time loses people before it has said a word, and if the browser puts a warning up about the connection first, it loses most of the rest. Neither one gives you a signal of any kind. Nobody rings to tell you they gave up on your website. They simply are not there.",
    objection: {
      says: "It loads fine for me.",
      response:
        "It does, because your browser has it saved from the last time you opened it. Try it on your phone, on data, on a page you have not looked at in a while. That is what a stranger gets.",
    },
    build:
      "A valid certificate so no browser warns anybody off, images cut down to a sensible size, and the code that holds up the first thing they see moved out of the way.",
    proof: {
      stat:
        "Google's own mobile research found 53% of mobile visits are abandoned when a page takes longer than three seconds to appear. Use it as a rule of thumb about people, never as a claim about their business: it is a 2016 average across thousands of sites, not a measurement of theirs.",
      source:
        "Google / DoubleClick, 'The Need for Mobile Speed', September 2016. Aggregated Google Analytics data, roughly 3,700 mobile sites, March 2016.",
    },
  },

  discoverability: {
    opener:
      "Give me twenty seconds. The reason I am calling is about how somebody finds you when they do not already know your name.",
    diagnostic:
      "Where do your new customers come from at the moment? And if somebody searched for the service rather than for you by name, would you come up?",
    cost:
      "Right now the site is missing the pieces that tell a search engine and a map listing what you are and where you are. So you are relying on people already knowing to type your name in. Everybody searching for the service instead of the business never reaches you at all, and those are precisely the ones who have not already chosen somebody else.",
    objection: {
      says: "We are already on Google.",
      response:
        "You are listed, and listed is not the same as findable for the thing you actually sell. Those are two separate pieces and only one of them is done. The listing tells Google that you exist. The site is what tells it what you do.",
    },
    build:
      "A title and a description written for every page, local business markup so the map listing and the site agree with each other, a sitemap so nothing gets missed, and analytics so you can finally see what is arriving.",
  },
};

/**
 * ═══ THE OBJECTION PANEL ════════════════════════════════════════════════════
 *
 * The eight that arrive regardless of which angle was used. Requested by the
 * operator earlier in the build and not delivered until now.
 *
 * The shape is Rackham's, not the usual one. Nearly every objection-handling
 * resource is a two-column table of "they say" and "you say", which teaches a
 * rep to get better at the moment the objection lands. Rackham's data says that
 * is the wrong place to spend the effort: across 35,000 observed calls, top
 * performers did not answer objections better, they received about a third as
 * many, because the sequencing of the call never gave the objection a reason to
 * form. So every entry here carries a `prevent` as well as a `response`, and
 * the `prevent` is the more valuable of the two.
 *
 * `meaning` is Sandler's contribution: the stated objection is very rarely the
 * real one, and answering the stated one convincingly is how a rep wins an
 * argument and loses a call.
 *
 * `response` is spoken and follows the same rules as an angle: no numbers, no
 * jargon, no money we cannot evidence. `meaning`, `prevent` and `source` are
 * coaching notes for the rep and are never read aloud, so a figure is allowed
 * there, and anything that cites one carries `source`.
 */
export type Objection = {
  /** What they actually say, in their words. */
  says: string;
  /** What it usually means, which is rarely what it says. Not read aloud. */
  meaning: string;
  /** What to say. Spoken verbatim, same rules as an angle. */
  response: string;
  /** What to have done EARLIER so it never forms. Not read aloud. */
  prevent: string;
  /** Required whenever `meaning` or `prevent` cites a figure. */
  source?: string;
};

export const OBJECTIONS: Objection[] = [
  {
    says: "We already have a website. My nephew built it.",
    meaning:
      "Usually not a refusal. It is 'I already dealt with this', and when a family member built it, it is also 'you are about to ask me to insult someone I like'. That second one ends calls quietly and the rep never finds out why.",
    response:
      "I know you have one. I have had it open in front of me, that is the reason I am calling. I am not ringing about whether you have a site. I am ringing about one thing on it that I think is costing you calls. Can I tell you the one thing?",
    prevent:
      "Never let your first sentence sound like you have just discovered they have no website. Say early that you have already looked at it. And if a relative built it, that person is now in the room: praise the effort, criticise nothing about the work, and talk only about what the site does rather than about who made it. The angle table above is written to make this easy, because not one opener in it names the defect as a defect.",
  },
  {
    says: "We have no budget for that right now.",
    meaning:
      "Almost always 'not worth it yet' rather than 'the money does not exist'. A price objection raised before a price has been mentioned is a value objection wearing a costume.",
    response:
      "That is fair, and I am not asking you to spend anything today. I would rather work out whether this is even worth money to you in the first place. Can I ask you two quick questions, and if the answer is no then we have both saved the time?",
    prevent:
      "Budget comes up early when a rep described something they would build before the owner had admitted there was a problem. Rackham's 35,000-call study found average reps collected two to three objections a call and the best collected fewer than one, using the same answers. The difference was sequencing. Ask the diagnostic question and wait for the answer before you describe anything.",
    source: "Neil Rackham, SPIN Selling (1988), Huthwaite International research base.",
  },
  {
    says: "Just send me an email.",
    meaning:
      "The politest way there is to end a call. Occasionally genuine. Treating it as genuine costs nothing, but get the consent properly on the way out.",
    response:
      "Happy to. So that I am allowed to, I have to ask you straight out: is it alright if I email you about this, and who should I put it to? And before I let you go, so the email is actually worth opening, what is the one thing you would want it to answer?",
    prevent:
      "This one is a legal step in Canada, not only a sales one. The call itself is fine: CASL governs commercial electronic messages, not voice calls, and business-to-business calls are exempt from the National DNCL. Emailing them afterwards is a different thing. It is a commercial electronic message and it needs consent. Spoken consent does count, but the onus of proving it sits on us under section 13, and the CRTC's position is that oral consent needs either a complete unedited recording or independent third-party verification. So ask in plain words, get an audible yes, and log it in the call outcome with the date and what they said. Never send off the back of a 'sure, send me something' you did not record.",
    source:
      "CASL s.13 (onus of proof on the sender); CRTC Enforcement Advisory, Keeping Records of Consent under CASL; CRTC Unsolicited Telecommunications Rules (business-to-business DNCL exemption).",
  },
  {
    says: "We are not interested.",
    meaning:
      "A reflex, and it arrives before they have heard what the call is about, which means it is aimed at the shape of the call rather than at the offer. It is the cheapest sentence in the language and it costs them nothing to say.",
    response:
      "Understood, and you have not heard what it is yet, so that is fair enough. One sentence and then I will leave you alone: I have your website open in front of me and there is one thing on it that I think is turning people away. Do you want to know what it is, or should I leave it?",
    prevent:
      "A reflex no is aimed at anything that sounds like a script. Gong's analysis of over 300 million recorded cold calls found that saying the reason for the call outright lifts the success rate 2.1x, and that opening with 'did I catch you at a bad time' was their worst measured opener at 2.15%. Name the reason in your first breath and make it about their business specifically. Do not ask permission to exist.",
    source:
      "Gong Labs, 'The best and worst cold call openers, backed by data from 300M+ cold calls', published 2024-07-24.",
  },
  {
    says: "How much is it?",
    meaning:
      "Interest, most of the time, not resistance. This is the objection reps most often mishandle, because the instinct is to dodge until value is built, and to an owner-operator a dodged price reads as a setup.",
    response:
      "Straight answer: it moves with how many pages you need and whether you want us keeping it current afterwards. Give me two minutes to work out which of those apply to you and I will give you a real number rather than a range.",
    prevent:
      "Know your own starting number cold before you dial. A rep who cannot answer 'how much' within a few seconds of being asked sounds like somebody about to invent one, and that is worse than any price. Answer the question, then scope it, then give the real figure. Never dodge it twice. This market is anchored low and the anchor does not move by avoiding the subject. It moves by showing them the named local competitor on this card who is already beating them.",
  },
  {
    says: "Call me back in a few months.",
    meaning:
      "A soft no with a date stapled to it, unless something real is genuinely happening then. The date is the tell: a vague one is a no, a specific one attached to an event is an appointment.",
    response:
      "I can do that. So that I am not ringing you cold all over again, what changes between now and then? If the answer is that things are flat out at the moment, that is exactly when I would rather have this already working for you.",
    prevent:
      "Ask what changes, every time, before you agree to the callback. If they cannot name the thing, you have a no and it should be logged as one rather than as a follow-up that will burn another call. If they can name it, put the actual event in the note, not the month.",
  },
  {
    says: "We get all our work by word of mouth.",
    meaning:
      "Usually true, usually said with some pride, and usually the thing they believe most firmly about their own business. A rep who argues with it has lost the call in one sentence.",
    response:
      "That is the best kind of work there is, and it is actually the reason this matters. When somebody gets your name from a friend, the first thing they do is look you up before they ring. The site is not there to find you new customers. It is there so the ones you have already earned do not have second thoughts.",
    prevent:
      "Do not treat this as an objection to beat, because they are right. Reframe instead: a referral gets checked online before the call, so the site is the place a referral is either confirmed or lost. That is the Challenger move, teaching them something about a channel they already believe in, and it lands far better than telling a proud owner that word of mouth is not enough.",
  },
  {
    says: "We have a Facebook page, that does the job.",
    meaning:
      "A genuine belief, and half right. Social is often where they get found. It is not where anybody is convinced, and it is not theirs.",
    response:
      "That is a good place to be found and I would not touch it. The difference is that you rent that page and you own a website. A social page shows somebody what you posted last. A site answers the questions somebody has when they are about to spend money with you, and those are two different jobs.",
    prevent:
      "Never rubbish their social presence. It is often the thing they are proudest of and it is frequently working. Position the website as the second half of the same job rather than as a replacement, and ask what happens when somebody messages the page at nine on a Sunday night.",
  },
];

/**
 * The dimension losing the site the most composite points, which is the angle a
 * rep opens with.
 *
 * WEIGHTED, NOT RAW: dimensions normalise to 100 independently and then carry
 * very different weights into the composite (conversion 0.28, discoverability
 * 0.05). A discoverability 20 and a conversion 60 both look bad, but fixing the
 * conversion 60 is worth eleven composite points and fixing the discoverability
 * 20 is worth four. Ranking on the raw score sends a rep into the smaller
 * conversation and, worse, into the smaller build.
 *
 * TIEBREAK toward `conversion`, then `trust`, per the spec: those two convert
 * into money the fastest for the prospect and are the cheapest for us to build,
 * so a genuine tie should resolve toward the sale that closes.
 */
const TIEBREAK = ["conversion", "trust"];

export function recoverablePoints(d: { score: number; weight: number }): number {
  return Math.max(0, 100 - d.score) * d.weight;
}

export function selectAngle(
  dimensions: { key: string; label: string; score: number; weight: number }[],
): { key: string; label: string; angle: Angle } | null {
  const ranked = [...dimensions]
    .filter((d) => ANGLES[d.key])
    .sort((a, b) => {
      const diff = recoverablePoints(b) - recoverablePoints(a);
      if (Math.abs(diff) > 1e-9) return diff;
      const ai = TIEBREAK.indexOf(a.key);
      const bi = TIEBREAK.indexOf(b.key);
      // Not in the tiebreak list sorts after both entries in it.
      return (ai === -1 ? TIEBREAK.length : ai) - (bi === -1 ? TIEBREAK.length : bi);
    });
  const winner = ranked[0];
  if (!winner) return null;
  return { key: winner.key, label: winner.label, angle: ANGLES[winner.key] };
}

const anglesModule = { ANGLES, OBJECTIONS, selectAngle };
export default anglesModule;
