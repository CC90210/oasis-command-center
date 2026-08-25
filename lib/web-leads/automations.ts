/**
 * lib/web-leads/automations.ts — what else we can build for this business,
 * per industry, for a rep who has never sold automation before.
 *
 * ═══ THE PROBLEM THIS SOLVES ════════════════════════════════════════════════
 *
 * Adon: *"A lot of my reps don't really understand automations and are not like
 * me and Cece, where we could look at a business and we already know exactly
 * what automations they need because we've been doing this for so long."* The
 * rep on the phone needs the sentence a fifteen-year operator would say, and
 * they need it without having to know why it is the right sentence. So the
 * knowledge lives here, in a table, and the rep reads it.
 *
 * ═══ WHY PER INDUSTRY AND NOT PER LEAD ══════════════════════════════════════
 *
 * JARVIS stamps every lead with one of seventeen industries at ingest
 * (INDUSTRY_MAP in services/leadgen/lib/sources/osm-source.js). It is a CLOSED
 * set, deliberately: *"212 raw OSM categories across 30 metros would be over
 * six thousand sheets, which is not a territory model, it is a spreadsheet
 * explosion."* Seventeen hand-written sets therefore cover every lead we hold
 * and every lead we will ever scrape.
 *
 * Per-lead copy would mean a model writing sales pitches about businesses it
 * has never seen, which is banned on this surface for the same reason
 * remedies.ts and angles.ts are fixed tables: a model writing sales copy will
 * eventually assert a capability we do not have, and a rep will say it out loud
 * to a stranger. See rule 3 in the BattleCard header.
 *
 * The per-lead relevance comes from somewhere safer. We already audited the
 * site on 49 checks, so `provenBy` lets a card say "they do not have this"
 * on the authority of a measurement we actually took, and `selectAutomations`
 * sorts those cards first. Same seventeen hand-written sets, ordered by
 * evidence. Nothing is generated.
 *
 * ═══ THE RULES THIS FILE DOES NOT GET TO BREAK ══════════════════════════════
 *
 * 1. NO CARD NAMES THE TECHNOLOGY. The rep card is explicit: "NEVER SAY --
 *    anything about AI on call one" (OASIS_UNDENIABLE_OFFER_STRATEGY.md §10),
 *    and 40% of this market says AI is "not relevant" to them. Every card
 *    describes behaviour an owner recognises. Not "an AI receptionist" but
 *    "the phone gets answered when you cannot". Enforced by
 *    tests/web-leads-automations.test.ts.
 *
 * 2. NO PRICES. No web-dev price exists anywhere in the Oasis codebase or
 *    business context; the strategy doc that recommends one says plainly that
 *    it is a recommendation and that Adon signs off before any rep says a
 *    number out loud. A number on a card is a rep quoting it.
 *
 * 3. WHAT WE CANNOT PROVE WE DELIVER DOES NOT RENDER. Every capability carries
 *    a `source` naming where the claim comes from. Anything sourced `inferred`
 *    is APEX's guess at what Oasis could plausibly build, and `isDeliverable`
 *    keeps it off the screen until a human clears it. It stays in the table so
 *    Adon and Cece can review it, because deleting it would just mean someone
 *    re-guesses it later. A rep offering a build we cannot ship is the same
 *    failure as a fabricated measurement, one step further down the call.
 *
 * 4. THIS PANEL IS THE SAVE, NOT THE OPENER. It renders below the objections
 *    for a reason. The upsell ladder (§5) puts the first automation sale at
 *    month three and the front-desk conversation at month six, after two
 *    evidence reports have landed. This surface exists for the moment Adon
 *    described: *"maybe you don't want the website, but we have a variety of
 *    automations that can help your website."* That is a rep saving a dying
 *    call, not a rep opening with a menu.
 *
 * ═══ WHERE THE CAPABILITY CLAIMS COME FROM ══════════════════════════════════
 *
 *   site-build  Part of the website we are already selling. The audit measures
 *               these directly, so they are the only ones with `provenBy`.
 *   modules     A named OASIS AI module (BUSINESS_CONTEXT/SOFTWARE_PRODUCTS.md):
 *               Lead Reactivation, Speed-to-Lead Responder, Reputation & Referral.
 *   ladder      A stage Oasis has already decided to offer, from the upsell
 *               ladder in OASIS_UNDENIABLE_OFFER_STRATEGY.md §5.
 *   platform    Built on machinery this codebase demonstrably runs today: the
 *               drip engine, the scheduler, the send gate, the SMS path. A new
 *               audience for a proven pipeline, not a new pipeline.
 *   inferred    APEX's own guess. NOT CLEARED, does not render. Needs Adon or
 *               Cece to confirm we can actually build it.
 */

import type { AuditResult } from "./audit";

export type CapabilitySource = "site-build" | "modules" | "ladder" | "platform" | "inferred";

/** Which half of the panel a card renders under. */
export type CapabilityGroup = "attached" | "later";

export type Capability = {
  /** The line a rep says out loud. Behaviour, never a product name. */
  says: string;
  /** One sentence on what the owner ends up with. */
  gets: string;
  group: CapabilityGroup;
  source: CapabilitySource;
  /**
   * Check codes from the quality model whose absence proves this business
   * lacks the thing. Empty means the audit cannot see it, which is honest:
   * most of these are about what happens after someone contacts them, and a
   * crawler cannot observe that. Every code here is verified against
   * REMEDIES by the test.
   */
  provenBy: string[];
};

/** One capability, as it applies to one industry. */
export type IndustryEntry = {
  id: string;
  /** Why it matters for THIS industry. The part a rep cannot improvise. */
  why: string;
  /** The brush-off this card answers. */
  answers: string;
};

export type SelectedAutomation = Capability &
  IndustryEntry & {
    /** True only when the audit ran AND recorded one of `provenBy` as absent. */
    missingHere: boolean;
  };

export type SelectedAutomations = {
  /** The industry whose set was used. The fallback key when nothing matched. */
  industryLabel: string;
  isFallback: boolean;
  attached: SelectedAutomation[];
  later: SelectedAutomation[];
};

/** The set used when a lead carries no industry, or one this table has not seen. */
export const GENERAL_KEY = "General";

// ───────────────────────────────────────────────────────────────────────────
// The capability catalog. Shared copy: what the thing IS does not change
// between a salon and a plumber, only why they should care does. Writing
// seventeen copies of "we text your missed callers" would be seventeen places
// for that sentence to drift out of step with what we actually build.
// ───────────────────────────────────────────────────────────────────────────

export const CAPABILITIES: Record<string, Capability> = {
  online_booking: {
    says: "They can book you from their phone at eleven at night, without you picking up.",
    gets: "A calendar on the site that takes real appointments while you are busy or asleep.",
    group: "attached",
    source: "site-build",
    provenBy: ["booking"],
  },
  web_chat: {
    says: "Someone with one quick question gets an answer on the page instead of leaving.",
    gets: "A message box on the site that handles the questions you answer every day, and passes the rest to you.",
    group: "attached",
    source: "site-build",
    provenBy: ["chat"],
  },
  short_enquiry_form: {
    says: "A visitor who will not phone you can still reach you in under a minute.",
    gets: "A short form asking for a name, a number and the job, and nothing else.",
    group: "attached",
    source: "site-build",
    provenBy: ["contact_form", "short_form"],
  },
  speed_to_lead: {
    says: "Every enquiry gets a reply in seconds, day or night, before they try the next place.",
    gets: "An instant first reply to everything that comes in, and a nudge to you to take it from there.",
    group: "attached",
    source: "modules",
    provenBy: [],
  },
  missed_call_text_back: {
    says: "Anyone who calls and does not get through gets a text back straight away.",
    gets: "A text to every missed caller within seconds, so the ones you could not pick up for do not just move on.",
    group: "attached",
    source: "ladder",
    provenBy: ["multi_route"],
  },
  review_requests: {
    says: "Every happy customer gets asked for a review at the moment they are happiest.",
    gets: "A message that goes out after the job asking for a review, with the link already in it.",
    group: "attached",
    source: "modules",
    provenBy: ["testimonials", "review_platform"],
  },
  appointment_reminders: {
    says: "Nobody forgets an appointment, and the ones who cannot make it tell you early enough to refill it.",
    gets: "A reminder before every booking, with a one tap way to confirm it or move it.",
    group: "attached",
    source: "platform",
    provenBy: [],
  },
  lead_reactivation: {
    says: "The old enquiries sitting in your phone get worked again without you touching them.",
    gets: "A run through everyone who asked once and never bought, checking whether now is a better time.",
    group: "attached",
    source: "modules",
    provenBy: [],
  },
  quote_followup: {
    says: "Every quote you send gets chased, so it does not just go quiet on you.",
    gets: "A short run of follow ups after each quote until they answer you one way or the other.",
    group: "attached",
    source: "platform",
    provenBy: [],
  },
  recall_reminders: {
    says: "The customers who are due back hear from you before they think about anyone else.",
    gets: "A message timed off their last visit, going out when they are due again.",
    group: "attached",
    source: "platform",
    provenBy: [],
  },

  // ---- the later conversation ----
  front_desk_agent: {
    says: "The phone gets answered when you cannot, and the caller still gets what they rang for.",
    gets: "Something that picks up, answers the usual questions, takes the booking, and hands you the rest.",
    group: "later",
    source: "ladder",
    provenBy: [],
  },
  custom_build: {
    says: "Whatever the repetitive part of your week is, that specific thing can be built for you.",
    gets: "Software built for your business alone, once the standard pieces are running well.",
    group: "later",
    source: "ladder",
    provenBy: [],
  },

  // ---- held back for review: APEX guessed these, nobody confirmed them ----
  inventory_sync: {
    says: "What is on the shelf and what the site says are the same number.",
    gets: "Stock counts kept in step, so nobody orders something you ran out of last week.",
    group: "attached",
    source: "inferred",
    provenBy: [],
  },
  invoice_chasing: {
    says: "The unpaid invoices chase themselves instead of sitting on your desk.",
    gets: "A polite reminder going out on a schedule until an invoice is actually settled.",
    group: "attached",
    source: "inferred",
    provenBy: [],
  },
  intake_documents: {
    says: "The paperwork arrives filled in before the customer does.",
    gets: "Forms sent out ahead of the appointment and collected back, so nothing is done at the counter.",
    group: "attached",
    source: "inferred",
    provenBy: [],
  },
};

/**
 * Whether a capability is cleared to be shown to a rep.
 *
 * The one gate between "APEX thought of this" and "a rep offers it to a
 * stranger". Deliberately a function rather than a boolean field, so the rule
 * is stated once and cannot be half-applied.
 */
export function isDeliverable(cap: Capability): boolean {
  return cap.source !== "inferred";
}

// ───────────────────────────────────────────────────────────────────────────
// Per industry: which capabilities, and the reason THIS trade cares. Every
// `why` is unique across the whole table, enforced by the test -- a reason
// reused between two industries is a stub, and it passes every other check.
// ───────────────────────────────────────────────────────────────────────────

export const INDUSTRY_AUTOMATIONS: Record<string, IndustryEntry[]> = {
  "Salons & Personal Care": [
    {
      id: "online_booking",
      why: "Salon customers book on impulse in the evening, and a chair sitting empty on a Tuesday is money that cannot be earned back later.",
      answers: "I already have a book by the phone.",
    },
    {
      id: "recall_reminders",
      why: "A colour or a cut has a natural six week clock on it, and whoever reminds them first gets the booking.",
      answers: "My regulars come back on their own.",
    },
    {
      id: "appointment_reminders",
      why: "A no show in a salon is an hour of a stylist paid for and nothing earned, and it is the most common way the day quietly loses money.",
      answers: "People usually turn up, it is fine.",
    },
    {
      id: "web_chat",
      why: "Most of what a salon gets asked is do you do this service and how much, which is the same handful of answers every single day.",
      answers: "People can just call me if they want to.",
    },
    {
      id: "review_requests",
      why: "People choose a salon on photos and star ratings more than on anything else, and a fresh review sits above an old one.",
      answers: "I do not want to pester clients.",
    },
    {
      id: "front_desk_agent",
      why: "A stylist with their hands in someone's hair cannot answer the phone, so the calls during your busiest hours are exactly the ones that go unanswered.",
      answers: "I would rather people got a real person.",
    },
  ],

  "Auto Services": [
    {
      id: "missed_call_text_back",
      why: "A driver with a car making a noise rings three shops in a row and books the first one that answers, so a missed call is a job that went next door.",
      answers: "I call people back when I get a chance.",
    },
    {
      id: "online_booking",
      why: "Booking a slot for a service is the one thing a driver would rather do at midnight than explain down the phone.",
      answers: "Every job is different, I cannot put times on a screen.",
    },
    {
      id: "recall_reminders",
      why: "An oil change, a tyre swap and a safety check all run on a known clock, so you already know who is due and roughly when.",
      answers: "My customers know when to come in.",
    },
    {
      id: "quote_followup",
      why: "A driver who hears a repair number goes quiet to think about it, and most of them never come back to say either way.",
      answers: "If they want it they will call me.",
    },
    {
      id: "review_requests",
      why: "Nobody trusts a garage they have not used before, so the star rating does most of the selling before anyone picks up a phone.",
      answers: "Word of mouth is enough around here.",
    },
    {
      id: "front_desk_agent",
      why: "The phone rings hardest at exactly the hours when everybody in the shop is under a car.",
      answers: "I have someone on the desk already.",
    },
  ],

  "Food Retail": [
    {
      id: "speed_to_lead",
      why: "A catering or special order enquiry is worth many times a walk in basket, and it goes cold within the hour.",
      answers: "I check my messages at the end of the day.",
    },
    {
      id: "short_enquiry_form",
      why: "Most of what a food shop gets asked is about a special order or a platter, and that is a message rather than a phone conversation.",
      answers: "People come in and ask me directly.",
    },
    {
      id: "recall_reminders",
      why: "Holiday orders run on a calendar you already know, and the customers who ordered a turkey last year are the easiest sale of the season.",
      answers: "They come to me when they need it.",
    },
    {
      id: "review_requests",
      why: "A food shop lives on being the one people name when someone asks where to go, and that recommendation now happens in reviews.",
      answers: "My customers are regulars, they do not write reviews.",
    },
    {
      id: "lead_reactivation",
      why: "Every large order you have ever taken is a customer with a reason to order again who has simply forgotten to.",
      answers: "I do not keep a list of customers.",
    },
    {
      id: "custom_build",
      why: "A shop taking orders on paper, on the phone and over the counter is running three systems that disagree with each other.",
      answers: "The way we do it already works fine.",
    },
  ],

  "Restaurants & Bars": [
    {
      id: "online_booking",
      why: "A table booked from a phone at nine at night is a table that would otherwise have gone to whoever picked up.",
      answers: "We take our bookings on the phone.",
    },
    {
      id: "missed_call_text_back",
      why: "A restaurant phone rings hardest during service, which is precisely when nobody on the floor can pick it up.",
      answers: "It is too busy to worry about the phone.",
    },
    {
      id: "appointment_reminders",
      why: "A no show table on a Saturday cannot be resold, and a reminder the day before turns most of them into a cancellation you can still fill.",
      answers: "People mostly show up for their table.",
    },
    {
      id: "speed_to_lead",
      why: "Function and party enquiries are the highest value messages a restaurant gets, and the ones most likely to sit unread until service ends.",
      answers: "We reply to those messages when we can.",
    },
    {
      id: "review_requests",
      why: "A restaurant is chosen on its rating more than on almost anything else it does, and a quiet month lets old reviews sit on top.",
      answers: "We do not chase people for reviews.",
    },
    {
      id: "front_desk_agent",
      why: "Every call during a dinner rush is a choice between the person on the phone and the person already sitting at the table.",
      answers: "I would rather a person answered.",
    },
  ],

  "Health & Medical": [
    {
      id: "appointment_reminders",
      why: "A missed appointment in a practice is a slot that cannot be refilled at short notice, and it is the most expensive empty hour in the building.",
      answers: "We already phone people the day before.",
    },
    {
      id: "recall_reminders",
      why: "Recalls already run on a fixed schedule in a practice, so the only real question is whether anyone has time to send them.",
      answers: "We do recalls when we get to them.",
    },
    {
      id: "online_booking",
      why: "A patient will book a check up online at a time they would never phone about, and your line is busiest during the hours they could call.",
      answers: "Our patients would rather just call.",
    },
    {
      id: "missed_call_text_back",
      why: "A patient who cannot get through rings the next practice on the list, and once they are registered elsewhere they are gone for years.",
      answers: "They will call back if it matters.",
    },
    {
      id: "review_requests",
      why: "People choose a practice on how other patients describe being treated, and a satisfied patient almost never thinks to write that down unprompted.",
      answers: "It feels wrong to ask patients for reviews.",
    },
    {
      id: "intake_documents",
      why: "New patient paperwork done at the counter holds up the whole waiting room and then gets typed into the system a second time.",
      answers: "The paper forms are fine as they are.",
    },
    {
      id: "front_desk_agent",
      why: "Reception is the busiest role in the building and the one that pulls staff away from patients who are physically standing in front of them.",
      answers: "We have the reception desk covered.",
    },
  ],

  "Education & Childcare": [
    {
      id: "speed_to_lead",
      why: "A parent looking for a place enquires at several at once, and the first one to answer is usually the only one they visit.",
      answers: "We get back to everyone eventually.",
    },
    {
      id: "online_booking",
      why: "Booking a tour or a first lesson is where most interested parents drop out, because it needs a phone call during working hours.",
      answers: "We arrange visits over the phone.",
    },
    {
      id: "appointment_reminders",
      why: "A missed lesson or a missed tour is an instructor or a manager paid for an hour with nobody there to use it.",
      answers: "Parents usually remember the time.",
    },
    {
      id: "quote_followup",
      why: "Parents compare fees across several places over a couple of weeks, and the one that stays in touch through that gap is the one they pick.",
      answers: "We do not want to push parents at all.",
    },
    {
      id: "review_requests",
      why: "A parent choosing childcare reads every word other parents have written, because no local purchase is researched harder than this one.",
      answers: "Our parents recommend us in person.",
    },
    {
      id: "front_desk_agent",
      why: "Enquiry calls arrive during exactly the hours when every member of staff is required to be with the children.",
      answers: "Someone always picks up eventually.",
    },
  ],

  "Apparel & Accessories": [
    {
      id: "web_chat",
      why: "Clothing questions are about size, stock and fit, and a shopper who cannot get an answer in the moment simply buys somewhere else.",
      answers: "They can always ring the shop and ask.",
    },
    {
      id: "lead_reactivation",
      why: "Anyone who has bought one thing from you has a size on file and a reason to hear about the next season.",
      answers: "I do not really keep customer details.",
    },
    {
      id: "recall_reminders",
      why: "Seasonal changeovers and sale dates are fixed months in advance, so the message that brings people back can be written long before you need it.",
      answers: "We put a sign up in the window.",
    },
    {
      id: "short_enquiry_form",
      why: "Alterations, special orders and holds are all things a shopper will ask in writing but will not phone about.",
      answers: "They can come in and ask about it.",
    },
    {
      id: "review_requests",
      why: "A clothing shop is judged by people who have never been inside it, and recent reviews are most of what they have to go on.",
      answers: "People find us walking on the street.",
    },
    {
      id: "custom_build",
      why: "A shop tracking stock in a notebook and sales in a till is counting the same thing twice and trusting neither number.",
      answers: "We manage it well enough as it is.",
    },
  ],

  "Electronics & Tech": [
    {
      id: "speed_to_lead",
      why: "Someone with a broken laptop needs it dealt with today, and the first shop to reply is the one they walk into.",
      answers: "We answer the phone when we are free.",
    },
    {
      id: "quote_followup",
      why: "A repair or a build quote gets compared against two others, and the shop that follows up is usually the only one that bothers.",
      answers: "They will come back if they want it.",
    },
    {
      id: "short_enquiry_form",
      why: "Half of what a tech shop is asked is whether you can fix one specific model, which is a written question with a written answer.",
      answers: "People phone up and describe it.",
    },
    {
      id: "review_requests",
      why: "Handing over a device means trusting a stranger with everything on it, and reviews are the only thing that makes that feel safe.",
      answers: "Our work here speaks for itself.",
    },
    {
      id: "recall_reminders",
      why: "Devices come back on a predictable cycle for batteries, upgrades and servicing, and nobody ever remembers on their own.",
      answers: "They come in when something breaks.",
    },
    {
      id: "front_desk_agent",
      why: "A technician mid repair cannot stop to answer whether you fix that model, and that is most of the calls you get.",
      answers: "We would rather explain properly.",
    },
  ],

  "Home & Hardware": [
    {
      id: "speed_to_lead",
      why: "A tradesperson who needs a part is standing on a job right now, and whoever confirms it first gets the drive across town.",
      answers: "We are behind the counter all day.",
    },
    {
      id: "short_enquiry_form",
      why: "Do you stock this and have you got it in today is the whole question, and it is faster typed than explained down a phone.",
      answers: "They can call the counter and ask.",
    },
    {
      id: "quote_followup",
      why: "Materials lists get priced up and then sat on, and the quote that gets chased is the one that turns into an order.",
      answers: "They already know where to find us.",
    },
    {
      id: "recall_reminders",
      why: "Garden and seasonal stock sells in the same weeks every single year, so the reminder can be ready long before the season is.",
      answers: "People know when it is spring.",
    },
    {
      id: "review_requests",
      why: "A hardware shop competes with a big box store on knowledge and service, and neither of those shows up anywhere except in what customers say.",
      answers: "The big stores beat us on price anyway.",
    },
    {
      id: "inventory_sync",
      why: "A shop with thousands of small lines cannot hold what is actually on the shelf in anybody's head.",
      answers: "We know our own stock well enough.",
    },
    {
      id: "custom_build",
      why: "Trade accounts, deliveries and counter sales usually live in three separate places that have to be reconciled by hand.",
      answers: "We have always done it this way.",
    },
  ],

  "Home Furnishings": [
    {
      id: "quote_followup",
      why: "A sofa or a kitchen is thought about for weeks, and almost nobody comes back unprompted to say yes.",
      answers: "It is a big decision, I do not want to chase.",
    },
    {
      id: "online_booking",
      why: "A design or measuring appointment is the real first step in a furniture sale, and asking for it by phone loses most of the people who wanted one.",
      answers: "They pop in when they are ready.",
    },
    {
      id: "lead_reactivation",
      why: "Everyone who took a brochure or asked about a price is a live customer who has simply not been asked a second time.",
      answers: "If they were serious they would have bought.",
    },
    {
      id: "appointment_reminders",
      why: "A missed home visit is a van, a fitter and half a day gone with nothing to show for any of it.",
      answers: "Customers are usually in when we call.",
    },
    {
      id: "review_requests",
      why: "A furniture purchase is trusted on how the delivery and the fitting went, which a photo cannot show and a review describes exactly.",
      answers: "The showroom really sells itself.",
    },
    {
      id: "front_desk_agent",
      why: "Showroom staff are with one customer for an hour at a time, so the phone rings out through the busiest part of the weekend.",
      answers: "We catch the phone between customers.",
    },
  ],

  "Sports & Outdoors": [
    {
      id: "online_booking",
      why: "Servicing, fittings and rentals are all slot based, and the customer wants to grab a slot the moment they think of it.",
      answers: "We take the bookings as they come.",
    },
    {
      id: "web_chat",
      why: "Whether a bike or a board actually suits someone is a conversation, and it is the reason a shopper picks a shop over a website at all.",
      answers: "They can come in for a fitting.",
    },
    {
      id: "recall_reminders",
      why: "Kit needs servicing on a season clock, and the week before the season opens is when every customer wants it done at once.",
      answers: "They bring it in when they need it.",
    },
    {
      id: "speed_to_lead",
      why: "Somebody planning a trip or an event is buying this week, so the enquiry goes stale faster than almost anything else in retail.",
      answers: "We get to messages eventually.",
    },
    {
      id: "review_requests",
      why: "Specialist shops win on advice, and advice is invisible online unless a customer writes down that they were given it.",
      answers: "Our regulars already know us well.",
    },
    {
      id: "custom_build",
      why: "Rentals, repairs and sales each need their own tracking, and most shops end up running all three out of one diary.",
      answers: "The paper diary works well for us.",
    },
  ],

  "Local Services": [
    {
      id: "missed_call_text_back",
      why: "Someone locked out or needing something today rings down a list until a person answers, so an unanswered call is the entire job lost.",
      answers: "I ring back as soon as I am free.",
    },
    {
      id: "speed_to_lead",
      why: "These are jobs people need dealt with now, and a reply an hour later arrives after they have already sorted it another way.",
      answers: "I am out on jobs for most of the day.",
    },
    {
      id: "online_booking",
      why: "Drop offs, collections and appointments are all fixed slots, and a customer will pick one off a screen far more readily than ask for one.",
      answers: "People just turn up at the counter.",
    },
    {
      id: "quote_followup",
      why: "A price given over the phone is forgotten by the afternoon unless something puts it back in front of them.",
      answers: "They have my number if they need me.",
    },
    {
      id: "review_requests",
      why: "A service in someone's home or on their possessions is bought almost entirely on how safe other people felt using you.",
      answers: "I have been here twenty years.",
    },
    {
      id: "front_desk_agent",
      why: "A one person business cannot answer the phone and do the work at the same time, and the work has to win.",
      answers: "I manage all the calls myself.",
    },
  ],

  "Pet Services": [
    {
      id: "recall_reminders",
      why: "A dog needs grooming on a rhythm the owner never tracks but that you can predict to the week.",
      answers: "They book the next one on the way out.",
    },
    {
      id: "online_booking",
      why: "Owners think about booking a groom in the evening when they notice the state of the coat, not during your opening hours.",
      answers: "We book them in at the counter.",
    },
    {
      id: "appointment_reminders",
      why: "A missed grooming slot is an hour of a table and a groomer with no realistic way to fill it.",
      answers: "Most people turn up for their slot.",
    },
    {
      id: "missed_call_text_back",
      why: "An owner with a distressed animal rings until somebody answers, and waiting is not something they will sit through.",
      answers: "We call people back on the same day.",
    },
    {
      id: "review_requests",
      why: "People hand over an animal they treat as family, so what other owners say carries more weight here than in almost any other trade.",
      answers: "Our clients already love what we do.",
    },
    {
      id: "front_desk_agent",
      why: "Nobody can stop mid groom with a wet animal on the table to take a booking down.",
      answers: "We would rather speak to owners ourselves.",
    },
  ],

  Travel: [
    {
      id: "speed_to_lead",
      why: "A holiday enquiry goes to several agents in one sitting, and the first useful reply usually takes the booking.",
      answers: "We reply to every enquiry in turn.",
    },
    {
      id: "quote_followup",
      why: "A trip is priced, thought about and compared for weeks, and it is the follow up rather than the quote that closes it.",
      answers: "They come back if the price is right.",
    },
    {
      id: "lead_reactivation",
      why: "Everyone who travelled with you has an anniversary, a season and a next trip, and all of it is already sitting in your records.",
      answers: "They know where to find us again.",
    },
    {
      id: "online_booking",
      why: "A consultation is where a browsing enquiry becomes a real customer, so it has to be bookable the moment they are interested.",
      answers: "They can call the office to arrange it.",
    },
    {
      id: "review_requests",
      why: "A holiday is the most researched purchase most families make, and it is decided on other travellers' accounts of it.",
      answers: "We get repeat customers anyway.",
    },
    {
      id: "front_desk_agent",
      why: "Enquiries arrive in the evening and at weekends, which is exactly when a small agency has nobody in the office.",
      answers: "Our opening hours are our hours.",
    },
  ],

  "Specialty Retail": [
    {
      id: "web_chat",
      why: "Specialist shops get asked whether you have one specific item, and that needs answering while the person is still looking for it.",
      answers: "They can ring the shop up and ask.",
    },
    {
      id: "lead_reactivation",
      why: "Anyone who bought something unusual from you told you exactly what they collect, which is a standing reason to contact them again.",
      answers: "I do not have a customer list.",
    },
    {
      id: "short_enquiry_form",
      why: "Special orders, valuations and holds are all written requests that a phone call handles badly.",
      answers: "People come in and bring it with them.",
    },
    {
      id: "recall_reminders",
      why: "Christmas, birthdays and collecting seasons are fixed dates, and the shop that gets in first takes the spend.",
      answers: "Everyone knows when Christmas is.",
    },
    {
      id: "review_requests",
      why: "A specialist shop is found by people who did not know it existed, and reviews are most of what tells them it is worth the trip.",
      answers: "We are a bit of a hidden gem here.",
    },
    {
      id: "custom_build",
      why: "One of a kind stock cannot be managed with a standard till system, which is why most shops end up back on a notebook.",
      answers: "The notebook works fine for us.",
    },
  ],

  "Trades & Contractors": [
    {
      id: "missed_call_text_back",
      why: "A homeowner with a leak rings four trades in ten minutes and books the first one who answers, so a missed ring is the whole job.",
      answers: "I call people back in the evening.",
    },
    {
      id: "quote_followup",
      why: "Most quotes a trade sends are never answered either way, and chasing them is the cheapest work you will ever win.",
      answers: "If they want it, they will call.",
    },
    {
      id: "speed_to_lead",
      why: "You are up a ladder when the enquiry lands, and by the time you are down somebody else has already replied to it.",
      answers: "I cannot answer the phone on a job.",
    },
    {
      id: "online_booking",
      why: "The quoting visit is the appointment that actually matters, and letting someone pick a slot themselves saves a whole round of phone tag.",
      answers: "I sort out times over the phone.",
    },
    {
      id: "review_requests",
      why: "Nobody lets a stranger into their house on a hunch, so the reviews do the qualifying before you ever speak to them.",
      answers: "All of my work is word of mouth.",
    },
    {
      id: "invoice_chasing",
      why: "Unpaid invoices in a trade get chased in the evening after a full day on site, which means mostly they are not chased at all.",
      answers: "People pay me eventually anyway.",
    },
    {
      id: "front_desk_agent",
      why: "A one van business has nobody to answer the phone, and every call missed during the working day is money.",
      answers: "I would rather they got hold of me.",
    },
  ],

  "Professional Services": [
    {
      id: "speed_to_lead",
      why: "A client with a problem contacts several firms at once, and the first substantive reply usually gets the instruction.",
      answers: "We respond within a day or two.",
    },
    {
      id: "online_booking",
      why: "A consultation is the entire point of the website, and asking somebody to phone in to arrange one loses most of them at that step.",
      answers: "Our clients just ring the office.",
    },
    {
      id: "quote_followup",
      why: "A fee proposal sits with a client for weeks while they decide, and the firm that stays present through that is the one they instruct.",
      answers: "It would look pushy to chase them.",
    },
    {
      id: "appointment_reminders",
      why: "A missed consultation is billable time that cannot be recovered and a diary slot somebody else would have taken.",
      answers: "Clients keep their appointments.",
    },
    {
      id: "review_requests",
      why: "Professional services are chosen almost entirely on reputation, and a firm with no recent reviews reads as less established than it is.",
      answers: "Our client work is confidential.",
    },
    {
      id: "intake_documents",
      why: "Client onboarding paperwork is chased by hand and is reliably the slowest part of starting any new matter.",
      answers: "We send the forms out ourselves.",
    },
    {
      id: "front_desk_agent",
      why: "Fee earners cannot take enquiry calls, and an enquiry that reaches a voicemail rarely turns into a client.",
      answers: "We already have a receptionist.",
    },
  ],

  // The fallback. `industry` is nullable on WebLead, and JARVIS's long-tail
  // buckets can produce a value this table has not seen yet. A rep mid-call
  // gets these and never knows the difference; an empty panel is the failure.
  [GENERAL_KEY]: [
    {
      id: "missed_call_text_back",
      why: "Whatever the trade, a call that rings out is a customer who had already decided to buy and is now looking at somebody else.",
      answers: "I get back to people when I can.",
    },
    {
      id: "speed_to_lead",
      why: "The business that replies first wins the enquiry far more often than the business with the better offer does.",
      answers: "We answer everything eventually.",
    },
    {
      id: "online_booking",
      why: "Letting a customer pick their own time removes the back and forth that kills most enquiries before they ever become appointments.",
      answers: "We arrange times over the phone.",
    },
    {
      id: "review_requests",
      why: "Almost every local business is now chosen off a list of star ratings before anybody picks up a phone.",
      answers: "We do not really do the reviews thing.",
    },
    {
      id: "quote_followup",
      why: "Most quotes go unanswered in both directions, and a short chase turns a meaningful share of them into actual work.",
      answers: "They will call if they want it.",
    },
    {
      id: "front_desk_agent",
      why: "Every small business loses calls during the hours it is busiest, and those are the calls worth the most money.",
      answers: "We cope with the phone as it is.",
    },
  ],
};

// ───────────────────────────────────────────────────────────────────────────
// Selection
// ───────────────────────────────────────────────────────────────────────────

/**
 * Industry lookup that survives the trip through Turso.
 *
 * `industry` is free text inside a JSON blob, not a typed enum -- the same
 * reason lib/web-leads/data.ts treats territory and city as free text. A
 * leading space or a lowercased spelling must not drop a rep onto the general
 * set while a perfectly good industry set sits right there.
 */
const BY_NORMALISED = new Map<string, string>(
  Object.keys(INDUSTRY_AUTOMATIONS).map((k) => [k.trim().toLowerCase().replace(/\s+/g, " "), k]),
);

/**
 * The check codes this audit recorded as ABSENT.
 *
 * Only ever populated from a `scored` result. The other three states mean
 * nothing was measured, and marking a card "they do not have this" on the
 * strength of a crawl that never happened is a fabricated finding read aloud
 * to a stranger -- the worst thing this feature can produce.
 */
function absentCodes(audit: AuditResult): Set<string> {
  const absent = new Set<string>();
  if (audit.state !== "scored") return absent;
  for (const dim of audit.dimensions) {
    for (const check of dim.checks) {
      if (!check.has) absent.add(check.code);
    }
  }
  return absent;
}

/**
 * The cards for one lead, in the order a rep should work them.
 *
 * Ordering is the ONLY per-lead behaviour in this feature, and it is driven
 * entirely by the audit we already ran. Cards proven missing on this specific
 * site come first; everything else keeps its hand-authored order, which is the
 * priority Adon and Cece set for that industry.
 */
export function selectAutomations(industry: string | null | undefined, audit: AuditResult): SelectedAutomations {
  const key = BY_NORMALISED.get((industry || "").trim().toLowerCase().replace(/\s+/g, " "));
  const industryLabel = key || GENERAL_KEY;
  const entries = INDUSTRY_AUTOMATIONS[industryLabel];
  const absent = absentCodes(audit);

  const decorated = entries
    .filter((e) => isDeliverable(CAPABILITIES[e.id]))
    .map((e, i) => {
      const cap = CAPABILITIES[e.id];
      return {
        ...cap,
        ...e,
        missingHere: cap.provenBy.some((code) => absent.has(code)),
        // Declaration order, kept explicitly rather than relying on sort
        // stability, so the hand-authored priority cannot be reshuffled by an
        // engine detail.
        __order: i,
      };
    });

  const rank = (a: (typeof decorated)[number], b: (typeof decorated)[number]) =>
    a.missingHere === b.missingHere ? a.__order - b.__order : a.missingHere ? -1 : 1;

  const strip = ({ __order, ...rest }: (typeof decorated)[number]): SelectedAutomation => rest;

  return {
    industryLabel,
    isFallback: !key,
    attached: decorated.filter((c) => c.group === "attached").sort(rank).map(strip),
    later: decorated.filter((c) => c.group === "later").sort(rank).map(strip),
  };
}
