/**
 * lib/web-leads/automations.ts — the capability catalogue a rep sells from.
 *
 * `remedies.ts` holds 44 entries, one per check code in the scoring model
 * (JARVIS `services/leadgen/lib/quality-model.js`), each a two-line
 * {costs, fix}. Nobody buys a check code: nobody purchases `og_tags`, `tel_link`
 * or `no_fixed_width`. They buy "show up properly when someone shares your
 * page", "make it easy to call you", "work properly on a phone". This module
 * is the bridge between the two: it groups the 44 measured codes into a
 * smaller set of things an owner recognises as something Oasis would build
 * for them, in their language, plus the offer-ladder items beyond the
 * website that are not part of the checks at all.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD: every code in `REMEDIES` lands in
 * exactly one bundle below. An unmapped code is a defect we measure, would
 * charge to fix, and cannot explain to a prospect. A code claimed by two
 * bundles is a rep contradicting themselves on a call — "that's covered
 * under two different things I do" is not an answer a rep can give. Both
 * failure modes are pinned by tests/web-leads-automations.test.ts, which
 * derives both sides (the codes REMEDIES actually measures, and the codes
 * every bundle claims) from the live modules rather than from a hardcoded
 * count, because a count typed into a test drifts the moment the scoring
 * model changes and fails for the wrong reason — or gets bumped by someone
 * who never checked the new code was actually bundled.
 *
 * WHY THIS IS A HAND-WRITTEN MODULE, NOT A DATABASE TABLE: same convention
 * and same reasoning as `remedies.ts` and `angles.ts`. Copy is a display
 * concern and belongs beside the component that renders it, not behind an
 * API route. This is a deliberate departure from the objection engine, which
 * lives in Turso: the objection engine ingests new objections at runtime and
 * learns which answers recover, so it needed a database. Nothing here is
 * ingested, scored, or learned — it is a fixed, reviewed description of what
 * Oasis sells today and over the next twelve months. It changes when the
 * offer changes, and it should change through a reviewed diff, the same way
 * `remedies.ts` does, not through an admin form. See design spec
 * `docs/superpowers/specs/2026-09-11-oasis-automations-catalogue-design.md`
 * §4 for the full reasoning and the type shape this file implements.
 *
 * THE TWO REGISTERS (Task 2, 2026-09-11). `whatItIs` and `howYouSayIt` are
 * deliberately different writing, not one sentence typed twice. `whatItIs`
 * describes the thing itself in the words an owner would use to their
 * spouse over dinner: what it is, what it does, what happens when a
 * customer meets it. `howYouSayIt` is an utterance, not a description. It
 * is what leaves a rep's mouth on a live call, so it opens with a question
 * or an instruction the owner can act on while holding the phone, it leaves
 * room for their answer, and it teaches one thing rather than listing
 * features. An owner-facing explanation read aloud verbatim sounds like a
 * brochure, which is exactly the register this product cannot afford; a
 * spoken line written down as an explanation reads as evasive. Both are
 * pinned only weakly by test (literal equality), so the discipline is on
 * the writer and on review.
 *
 * The copy rules, all pinned by tests/web-leads-automations.test.ts:
 *   1. No em dash and no double hyphen in any string a rep or an owner
 *      reads. Both render literally on the card.
 *   2. No `today`-stage title or summary contains "AI"
 *      (`OASIS_UNDENIABLE_OFFER_STRATEGY.md` §5: leading with AI puts Oasis
 *      in the bucket with the spam the owner already deletes). The word is
 *      allowed inside a later-stage entry's own detail, where it is a
 *      description of a thing they asked about rather than an opener.
 *   3. No dollar figure is attached to a customer outcome. We have no
 *      revenue data for these businesses, the same standing rule
 *      `angles.ts` documents. Cost is stated in customers and behaviour.
 *   4. Any figure carries `source`. Nothing below cites one: the prices in
 *      the strategy doc are a recommendation Adon has not signed off for
 *      reps to say aloud (§5), and a spoken number that turns out to be
 *      wrong about a specific business is the worst thing this product can
 *      produce.
 *   5. No entry names the defect as a defect. Every line names a behaviour
 *      of the owner's customer instead. An owner whose nephew built the
 *      site is otherwise being asked to insult somebody they like, and that
 *      ends the call quietly without the rep ever finding out why.
 *
 * `title`, `summary`, `stage`, `stageReason` and `codes` were set by Task 1
 * and are unchanged here.
 *
 * BUNDLING: derived from the seven scored dimensions in `remedies.ts`
 * (conversion, trust, design, mobile, content, performance, discoverability),
 * then regrouped once around how an owner would describe the thing, per
 * design spec §3.2 ("the implementer may regroup, rename, split or merge
 * bundles where the owner-language reading is better"). One departure from
 * the spec's proposal: `fresh` moved out of the content-dimension bundle
 * ("say what you actually do, and where") into the visual-currency bundle
 * ("look current, not dated"). Its cost line is "the copyright date and the
 * content both look untouched for years, so a visitor wonders if you are
 * even still in business" — that is an appearance-of-being-active signal,
 * the same thing `no_dated_markup` and `not_default_tpl` measure, not a
 * describe-your-services signal like `service_detail` or `service_area`.
 *
 * LADDER ENTRIES: sourced from `OASIS_UNDENIABLE_OFFER_STRATEGY.md` §5's
 * upsell ladder, not from the scoring model — they carry no `codes` and are
 * always shown, never matched against a lead's audit. The stage gate on each
 * is a product constraint, not a technical one (spec §3.3): missed-call
 * text-back and speed-to-lead wait for two landed evidence reports because
 * they are a plan change on a website the client already trusts, not a cold
 * AI pitch; the front desk and booking agent wait for month six-plus because
 * they touch bookings and customer records, the exact liability tier that
 * gets AI agencies refused on data custody; custom agentic software waits a
 * year because it is scoped only after two lower tiers have proven out.
 */

export type Stage = "today" | "after_evidence" | "month_six_plus" | "year_plus";

/** Stage gate, in the order a client climbs it. Also the UI's grouping order. */
export const STAGES: readonly Stage[] = ["today", "after_evidence", "month_six_plus", "year_plus"];

export type Capability = {
  /** Stable key. */
  id: string;
  /** The name on the row. Owner language, not a feature name. */
  title: string;
  /** Owner language, the row a rep scans. One line, no jargon. */
  summary: string;
  /** Layer 1. What it does, as an owner would describe it. Task 2. */
  whatItIs: string;
  /** Layer 2. How a customer is lost today. Absent for ladder entries,
   *  which are not defect-driven. Task 2. */
  costsThem?: string;
  /** Layer 3. The rep's spoken words, verbatim. Task 2. */
  howYouSayIt: string;
  /** Layer 4. What we actually deliver. Task 2. */
  whatWeDeliver: string[];
  /** Layer 5. */
  stage: Stage;
  /** Why this stage, shown when stage !== "today". */
  stageReason?: string;
  /** Check codes this bundle covers. Empty for ladder entries. */
  codes: string[];
  /** Required whenever any copy cites a figure or a competitor price. */
  source?: string;
};

export const CAPABILITIES: Capability[] = [
  // ---- today: the website, in owner language ------------------------------
  {
    id: "easy-to-call",
    title: "Make it easy to call you",
    summary: "Right now calling you takes extra steps, so people give up and call someone else instead.",
    whatItIs:
      "Your phone number sits at the top of every page, and it is a button rather than just text. " +
      "Somebody reading about you on their phone taps it once and their phone is already dialling. No " +
      "writing it down, no switching apps, no hunting further down the page for it.",
    costsThem:
      "Somebody on a phone has to find your number partway down the page, hold it in their head and " +
      "then type it in by hand. Plenty of them mean to and never do, and the ones who had already " +
      "decided to ring you are exactly the ones lost that way.",
    howYouSayIt:
      "Do me a favour while we are talking and pull your own site up on your phone. Now pretend you are " +
      "somebody who has just decided they want to ring you. What do you actually have to do? For most " +
      "of the people I call, the number is halfway down and it does not do anything when you touch it. " +
      "The ones who copy it out by hand were always going to call you. It is the other ones I am " +
      "ringing about, and you never hear from any of them, so it never shows up as a problem. It shows " +
      "up as a quiet week.",
    whatWeDeliver: [
      "Your phone number pinned to the top of every page, visible before anybody scrolls.",
      "One tap to dial, from any page, on any phone.",
      "A call button that stays on screen while a visitor scrolls on a phone.",
      "The same number everywhere on the site, so nothing contradicts your listings.",
    ],
    stage: "today",
    codes: ["tel_link", "phone_in_header"],
  },
  {
    id: "reach-without-phoning",
    title: "Let people reach you without phoning",
    summary: "Anyone who would rather message than call has no way to do it, so they leave instead.",
    whatItIs:
      "Some people will not ring a stranger. They want to type two lines and get on with their day. " +
      "This gives them a short form on every page, an address they can write to, and a chat box for a " +
      "quick question, so the ones who were never going to phone still land in your inbox.",
    costsThem:
      "The phone is the only way in at the moment. Anybody who cannot take a call right then, or who " +
      "would simply rather write, has nothing to use and closes the page. Where there is a form, it " +
      "asks for so much before it will send that most people give up partway down it.",
    howYouSayIt:
      "Think about the last handful of people who booked you in. I would guess nearly all of them " +
      "phoned. Here is the part that is easy to miss. The people who would rather send two lines than " +
      "talk to somebody they have never met do not show up in that count at all, because there was " +
      "nothing on the page for them to use. They are not being fussy. They are usually the ones sitting " +
      "in an office at four in the afternoon who cannot make a personal call. I would rather they " +
      "landed in your inbox than on somebody else's page.",
    whatWeDeliver: [
      "A short contact form on every page: name, number, and the job. Nothing else.",
      "A working email address, so a message reaches you outside business hours.",
      "A chat box for a quick question, answered while they are still on the page.",
      "At least three ways to reach you, so a phone call is never the only option.",
      "Every message routed to an inbox you actually read, and tested before launch.",
    ],
    stage: "today",
    codes: ["contact_form", "short_form", "email_route", "chat", "multi_route"],
  },
  {
    id: "book-themselves-in",
    title: "Let them book themselves in",
    summary: "A customer deciding at night has no way to lock in a time, so they have booked with someone else by morning.",
    whatItIs:
      "A calendar on your own site that shows when you are free and lets a customer take a slot. They " +
      "pick a time, you get a notification, and it is in the book. It works at eleven at night while " +
      "you are asleep.",
    costsThem:
      "Somebody deciding at the end of their evening has no way to lock anything in. They either have " +
      "to still care enough to ring in the morning, or they carry on looking and book with whoever let " +
      "them choose a time on the spot. Most of them carry on looking.",
    howYouSayIt:
      "When do you reckon people are actually sitting there looking for somebody like you? It is rarely " +
      "during the working day. It is late, after the kids are down, when the thing has been playing up " +
      "all evening. If the only thing your page can tell them is to ring in the morning, you are asking " +
      "them to still care in the morning. A good share of them will have sorted it by then, with " +
      "whoever let them pick a time there and then.",
    whatWeDeliver: [
      "A booking calendar on your site, showing only the slots you want filled.",
      "Your hours, your days off and your job lengths set up as the rules it books by.",
      "A text or an email to you the moment something is taken.",
      "A confirmation to the customer, so nobody turns up on the wrong day.",
    ],
    stage: "today",
    codes: ["booking"],
  },
  {
    id: "tell-them-what-to-do-next",
    title: "Tell them what to do next",
    summary: "A visitor can read the whole page and still not know what you want, so they do nothing.",
    whatItIs:
      "One obvious button on every page telling a visitor the next move, in your words. Call now, get a " +
      "quote, book a visit. It is the difference between a page that reads well and a page that ends " +
      "with somebody doing something.",
    costsThem:
      "A visitor can read everything you have written, decide you sound right for the job, and reach " +
      "the bottom of the page with nothing telling them what happens next. So they do nothing, because " +
      "doing nothing is always the easiest option in front of them.",
    howYouSayIt:
      "Read your own homepage down to the bottom and ask what it tells somebody to do. Most sites just " +
      "stop. Somebody who has finished reading about you with no instruction in front of them does the " +
      "easy thing, which is close the tab and mean to come back to it. They do not come back. I am not " +
      "talking about a trick here. I am talking about telling them plainly what you want them to do, " +
      "because at the moment the page leaves that up to them.",
    whatWeDeliver: [
      "One clear action on every page, written in your words rather than ours.",
      "The same action repeated at the top and the bottom of the longer pages.",
      "Wording chosen per page, so a service page asks for a quote and the contact page asks for the call.",
      "Buttons built big enough to hit with a thumb on the first go.",
    ],
    stage: "today",
    codes: ["cta_present"],
  },
  {
    id: "look-established",
    title: "Look like a real, established business",
    summary: "Nothing on the page proves you're legit, local or experienced, so a stranger has to take your word for it.",
    whatItIs:
      "The parts of the page that answer what a stranger wants to know before they will ring you. Who " +
      "has hired you before, what your work actually looks like, whether you are insured, where you " +
      "are, how long you have been at it, and what happens if something goes wrong. It is everything a " +
      "neighbour would tell them about you, written down.",
    costsThem:
      "Somebody who has never met you is standing in front of three names looking for a reason to pick " +
      "one. If the page will not hand them a reason, they leave it and go looking for one elsewhere, " +
      "and where they go looking is exactly where your competitors are.",
    howYouSayIt:
      "Let me ask you one thing. When somebody is choosing between you and two other names they found " +
      "the same afternoon, what is the thing that makes them pick you? Whatever you just told me, I " +
      "could not find any of it on the page. The people who already know you do not need it there. The " +
      "person who does not know you is looking for one reason to trust somebody, and if your page will " +
      "not give them one they will go and find it somewhere else. That is the part that costs you, and " +
      "it costs you quietly.",
    whatWeDeliver: [
      "Your best reviews on the site itself, with the customer's first name and their town.",
      "Licence, insurance and any certifications stated plainly beside your contact details.",
      "Real photographs of your crew and finished jobs, in place of stock images.",
      "Your address and a map, so nobody has to wonder whether you are local.",
      "How long you have been in business, in one line, where trust gets decided.",
      "Whatever guarantee you already give a customer, written down where a nervous one sees it.",
    ],
    stage: "today",
    codes: ["testimonials", "review_platform", "credentials", "real_photos", "address", "map", "years_trading", "guarantee"],
  },
  {
    id: "look-current",
    title: "Look current, not dated",
    summary: "The site reads as unfinished or years old, which undercuts the trust the rest of the page is trying to build.",
    whatItIs:
      "The version of your business a stranger meets in the first second, before they have read a word. " +
      "Your own look instead of a stock theme, type and spacing that line up, your photographs through " +
      "the page, your logo used the same way everywhere, and a site that reads like somebody is still " +
      "minding it.",
    costsThem:
      "People decide whether a business is still going and still any good off nothing but how the page " +
      "looks, and they do it before they read anything on it. To somebody who has never met you, a page " +
      "that looks left alone reads as a business that might not pick up the phone.",
    howYouSayIt:
      "Can I ask when the site was last properly touched? Not the wording on it, the look of the thing. " +
      "The reason I ask is that people make their mind up about a business off the first second of the " +
      "page, before they read a line of it, and they are not really judging the design. They are " +
      "working out whether you are still going. It is an unfair way to be judged and it happens anyway, " +
      "and the only people doing it are the ones who have never met you, so nothing else they might " +
      "have heard about you gets a say.",
    whatWeDeliver: [
      "A design built around your services and your photographs, not a theme with your name dropped into it.",
      "Type, spacing and colour chosen once and used the same way on every page.",
      "Your logo and colours across the whole site, including the small icon in the browser tab.",
      "Any website-builder badge removed from the footer, replaced with one that belongs to your business.",
      "The pages rebuilt on current code, so they line up properly on new phones and new screens.",
      "Dates and details kept current, so nobody has to wonder whether you are still trading.",
    ],
    stage: "today",
    codes: [
      "layout_quality",
      "web_fonts",
      "not_default_tpl",
      "image_rich",
      "no_dated_markup",
      "consistent_brand",
      "favicon",
      "no_builder_badge",
      "fresh",
    ],
  },
  {
    id: "work-on-a-phone",
    title: "Work properly on a phone",
    summary: "Most visitors are on a phone, and right now the page fights them the whole way through.",
    whatItIs:
      "The site reshaping itself for whatever somebody is holding. On a phone the text is readable " +
      "without pinching, the menu opens with a thumb, and your number is a button rather than something " +
      "to squint at. Nobody has to scroll sideways to finish a sentence.",
    costsThem:
      "Most of the people meeting you for the first time are on a phone, and getting to your hours or " +
      "your number means dragging and pinching to do it. Nobody does that for a business they have not " +
      "chosen yet. They go back to the search results and open whoever came up properly.",
    howYouSayIt:
      "Do this one with me. Pull the site up on your own phone and try getting to your opening hours, " +
      "then to your number, the way somebody who had never seen it would. Whatever you just had to do " +
      "to get there, a stranger will not do it. They are standing in a car park with one hand free. " +
      "They go back to the results and open the next name instead, and that is the whole decision. It " +
      "takes them no time at all and you never hear about it.",
    whatWeDeliver: [
      "A layout that reflows for phones, tablets and desktops, built for the phone first.",
      "A menu and buttons sized for a thumb rather than a mouse pointer.",
      "Your number and your hours reachable on a phone without a single pinch.",
      "No sideways scrolling on any screen, checked on real phone sizes before launch.",
    ],
    stage: "today",
    codes: ["viewport", "responsive_css", "no_fixed_width", "tap_targets"],
  },
  {
    id: "say-what-you-do",
    title: "Say what you actually do, and where",
    summary: "A visitor can't tell what you handle or whether you cover their area, so they can't decide to call.",
    whatItIs:
      "The page answering the three things somebody wants settled before they will ring: what you " +
      "actually do, whether you cover where they live, and roughly what it is going to cost them. Each " +
      "service gets its own page in plain words, with headings down it so a person skimming on a phone " +
      "finds their own problem.",
    costsThem:
      "Somebody comparing three businesses gives each one a few seconds to answer those three " +
      "questions, and the one that answers them gets the call even when it is not the best of the " +
      "three. A visitor who cannot see any hint of cost assumes the worst and rings somebody else " +
      "rather than ask you.",
    howYouSayIt:
      "If I had never heard of you, where on the site would I find what you actually do, the towns you " +
      "cover, and roughly what it costs? I ask because that is the shortlist test, and it is not a " +
      "contest about who is best. It is a contest about who is clear, and clear is a far easier one to " +
      "win. The person comparing you is not being difficult. They have three tabs open and no reason to " +
      "work harder on yours than on the other two.",
    whatWeDeliver: [
      "A homepage that answers what you do, where you work and roughly what it costs, before anybody scrolls.",
      "A separate page for each service, in the words a customer would use for it.",
      "Section headings all the way down, so somebody skimming finds their own problem in seconds.",
      "Your service area named town by town, so nobody has to guess whether you cover them.",
      "A starting price, a range, or a plain free-quote line, whichever you are comfortable with.",
    ],
    stage: "today",
    codes: ["substantial", "service_detail", "headings", "service_area", "pricing_signal"],
  },
  {
    id: "load-fast-enough-to-stay",
    title: "Load fast enough that they stay",
    summary: "The page is slow enough that some visitors give up before it even appears.",
    whatItIs:
      "The page showing up straight away on a phone out on a weak signal, instead of sitting on a blank " +
      "screen while everything behind it loads. Lighter pages, quicker hosting, and the first thing a " +
      "visitor needs put in front of them first.",
    costsThem:
      "A page that takes its time loses people before it has said a word, and not one of them tells " +
      "you. Nobody rings to say they gave up on your website. They simply are not there, and somebody " +
      "on a phone at a job site with one bar of signal is the first to go.",
    howYouSayIt:
      "Try something for me later, when you are not on your own wifi. Open the site on your phone, on " +
      "data, on a page you have not looked at in a while, and count how long you sit there looking at " +
      "nothing. It comes up instantly for you because your browser saved it the last time. A stranger " +
      "gets the slow version, and they are not invested in you yet, so they do not wait it out. You " +
      "will never get a complaint about this one. You just get fewer calls.",
    whatWeDeliver: [
      "Hosting and a build set up so the page appears almost immediately.",
      "Images and page weight cut right down, so it opens on a weak signal.",
      "The code that holds up the first view moved out of the way, so something shows instantly.",
      "The speed measured before and after, so you can see it rather than take our word for it.",
    ],
    stage: "today",
    codes: ["fast_ttfb", "lean_html", "few_blocking"],
  },
  {
    id: "findable-and-safe-to-click",
    title: "Be findable, and safe to click",
    summary: "Search engines and shared links undersell you, and a security warning can chase a visitor off before they read a word.",
    whatItIs:
      "The part of the site that does its work before anybody has reached it. Your business name and " +
      "what you do in the search result instead of a stray line of code, the details a map listing " +
      "reads so local searches turn you up, a proper picture and headline when somebody texts your link " +
      "on, and the padlock that stops a browser warning people away.",
    costsThem:
      "People searching for the work rather than for your name never reach you at all, and they are " +
      "precisely the ones who have not already chosen somebody. When a happy customer does pass your " +
      "link on, it arrives as a bare blue link and gets scrolled past, and if a browser flags the site " +
      "as not secure first, a good share of visitors close the tab before they read a word.",
    howYouSayIt:
      "Where are your new customers coming from at the moment? And if somebody searched for the work " +
      "you do rather than for you by name, where do you reckon you would come up? The reason I am " +
      "asking is that anyone typing your name in has already chosen you. The whole job of this part is " +
      "the people who have not. The other half of it is the moment a happy customer texts you to their " +
      "brother-in-law. Right now that arrives as a plain blue link with nothing on it, so a " +
      "recommendation from a friend turns up looking like spam.",
    whatWeDeliver: [
      "A title and a description written for every page, so your search result reads like your business.",
      "Your business details published in the format search engines and map listings read.",
      "A proper preview picture and headline, so a shared or texted link looks like you.",
      "One clear main heading on each page, saying exactly what that page is.",
      "A valid security certificate, so no browser warns anybody off before they read a word.",
    ],
    stage: "today",
    codes: ["https", "title", "meta_desc", "local_schema", "og_tags", "h1"],
  },

  // ---- the ladder: OASIS_UNDENIABLE_OFFER_STRATEGY.md §5 ------------------
  {
    id: "missed-call-text-back",
    title: "Missed-call text-back",
    summary: "When you can't pick up, the caller gets an automatic text instead of silence, so they don't hang up and dial the next name on the list.",
    whatItIs:
      "When a call comes in and nobody can get to it, the caller gets a text back within seconds " +
      "instead of a voicemail beep. It says who you are, that you are on a job, and asks what they " +
      "need. They can answer it from where they are standing, and you pick it up when you come off the " +
      "ladder.",
    howYouSayIt:
      "How many calls go to voicemail on a normal day? And of those, how many actually leave a message? " +
      "That gap is the bit worth looking at, because a missed call is not a lost customer yet. It is " +
      "somebody standing there with the next number already open. If a text from you lands on their " +
      "phone before they dial it, most people will just answer the text. It is not doing anything " +
      "clever. It is answering somebody who already chose to ring you.",
    whatWeDeliver: [
      "An automatic text to any caller you did not get to, sent within seconds.",
      "The wording written with you, in your voice, signed with your business name.",
      "Their replies landing in one place you can work through at the end of the day.",
      "Hours you set and an off switch, so nothing goes out at two in the morning.",
      "A count of the calls it caught, in the monthly report you already get.",
    ],
    stage: "after_evidence",
    stageReason:
      "This is a plan change on a website you already trust, not a new sale from a stranger, so we wait until two monthly evidence reports have landed and you've seen the site working before offering it.",
    codes: [],
  },
  {
    id: "speed-to-lead",
    title: "Speed-to-lead",
    summary: "The moment someone fills out your form, they get a reply in seconds instead of waiting on you to notice it and moving on to a competitor.",
    whatItIs:
      "The moment somebody fills in your form they get an answer back, rather than waiting to find out " +
      "whether anyone read it. A message within seconds saying you have got it and when you will be in " +
      "touch, and your own phone going off at the same time so you know somebody is warm right now.",
    howYouSayIt:
      "When a form comes in on a Tuesday afternoon, how long before somebody looks at it? Be honest, " +
      "because everybody is the same on this. You are on a job, you see it at six, you ring back at " +
      "seven and they have already booked somebody. The person who filled in your form filled in two " +
      "others the same evening. Whoever answers first usually gets the work, and that is not about who " +
      "is better at the job. It is about who was awake.",
    whatWeDeliver: [
      "An instant reply to anybody who fills in a form, saying you have it and what happens next.",
      "An alert to your phone the second it arrives, so a warm one never sits in an inbox.",
      "A second nudge later the same day if nobody has got back to them yet.",
      "Every enquiry in one list, so nothing gets lost between a text and an inbox.",
    ],
    stage: "after_evidence",
    stageReason:
      "Same reason as missed-call text-back: it only replies to someone who already reached out, and it waits for two evidence reports so it lands as an upgrade to a working relationship, not a cold pitch.",
    codes: [],
  },
  {
    id: "ai-front-desk",
    title: "AI front desk",
    summary: "Calls get answered and questions get handled even when nobody's free to pick up.",
    whatItIs:
      "Something that picks up when you cannot, talks to the caller in plain speech, answers the " +
      "ordinary questions about your hours, your area and what a call out costs, and takes their " +
      "details for you. Anything it is not sure about it hands straight to you, with a note on what " +
      "they were after.",
    howYouSayIt:
      "This one is not for today, and I would rather tell you why before I tell you what it is. It " +
      "answers your phone. That is a much bigger ask than a website, because it is talking to your " +
      "customers when you are not in the room, so I am not going to sell it to you until you have had " +
      "us a while and read a few of the reports. When we do get to it, the first thing you should ask " +
      "me is where the recordings and the customer details sit and who is accountable for them. I will " +
      "have that in writing for you before it is ever switched on.",
    whatWeDeliver: [
      "A line that answers in your business name and handles the routine questions.",
      "The answers written with you first, so it never guesses at your prices or your area.",
      "Anything outside what it was given handed to you, with what the caller wanted.",
      "Every call logged and readable, so you can check what it said.",
      "A written page on where the data lives, who can see it, and how to switch it off.",
    ],
    stage: "month_six_plus",
    stageReason:
      "This touches your bookings and customer records, which is a bigger ask than a website, so it waits until month six or later and comes with a written page on exactly where that data lives and who's accountable for it.",
    codes: [],
  },
  {
    id: "booking-agent",
    title: "Booking agent",
    summary: "Customers book themselves in around the clock, checked against your real calendar instead of a guess.",
    whatItIs:
      "The same idea pointed at your diary. A customer says what they need and when they are free, it " +
      "checks what you actually have open, offers real times and puts it in the book. It knows how long " +
      "each job takes and it will not double book you.",
    howYouSayIt:
      "Same rule as the front desk, this is a later conversation rather than a today one. It books " +
      "people into your real calendar without you touching it. The reason it waits is that it is " +
      "sitting inside your diary and your customer records, and if I offered you that on a first phone " +
      "call I would deserve to be hung up on. Get the site working, read a few of the reports, and if " +
      "you reach the point where the admin is what is eating your evenings, that is when you raise it " +
      "with me.",
    whatWeDeliver: [
      "Booking into your real calendar, with your job lengths, travel time and days off respected.",
      "Confirmations and reminders to the customer, so fewer of them forget you are coming.",
      "Changes and cancellations handled without a phone call to you.",
      "The final say kept with you: any slot can be held back or blocked off.",
      "The same written page on where the booking and customer data lives.",
    ],
    stage: "month_six_plus",
    stageReason:
      "Same reason as the front desk: it's inside your bookings and customer data, so it's a month-six-plus conversation with the data-custody page in hand, not a first-call add-on.",
    codes: [],
  },
  {
    id: "custom-agentic-software",
    title: "Custom agentic software",
    summary: "Once the website and the automations before it are proven, we build the specific system that runs a repeatable part of your business.",
    whatItIs:
      "A piece of software built for the one job that eats your week, whatever that turns out to be. " +
      "Quoting, scheduling, chasing invoices, keeping suppliers straight. It is not something off a " +
      "shelf. It is us watching how you actually work, then building the thing that does the repetitive " +
      "part of it.",
    howYouSayIt:
      "I am only mentioning this because you asked what else we do, and it is genuinely a year away. By " +
      "then we will have built your site, you will have had the monthly reports, and we will know how " +
      "your business really runs. At that point, if there is one job eating a day of your week every " +
      "week, we can build something that does it. I am not going to scope it today. Anybody who tries " +
      "to sell you custom software off a cold call has no idea what your week looks like.",
    whatWeDeliver: [
      "Time spent watching how the work actually moves through your business.",
      "A written scope with a price on it, before anything gets built.",
      "The software built, run and maintained by us.",
      "Yours the same way the site is: you own it, and you keep it if you leave.",
      "Nothing scoped until the tiers before it have been running and reported on.",
    ],
    stage: "year_plus",
    stageReason:
      "This is scoped only after roughly a year of proven results from the tiers before it; pitching custom software on an early call is the same cold, high-liability approach that gets AI agencies turned away at the door.",
    codes: [],
  },
];

const CODE_TO_CAPABILITY: Map<string, Capability> = new Map();
for (const cap of CAPABILITIES) {
  for (const code of cap.codes) {
    CODE_TO_CAPABILITY.set(code, cap);
  }
}

export function codeToCapability(code: string): Capability | null {
  return CODE_TO_CAPABILITY.get(code) || null;
}

const automationsModule = { CAPABILITIES, STAGES, codeToCapability };
export default automationsModule;
