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
 * TASK SEQUENCING NOTE (2026-09-11, Task 1 of the build): this file is
 * structure only. `whatItIs`, `howYouSayIt` and `whatWeDeliver` are left
 * empty here on purpose — Task 2 writes that copy in both registers (owner
 * language vs. the rep's spoken words) and its own tests enforce that none
 * of the three stay empty. `title`, `summary`, `stage`, `stageReason` and
 * `codes` are rep-facing today and are final as of this file, not
 * placeholders.
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
    whatItIs: "",
    howYouSayIt: "",
    whatWeDeliver: [],
    stage: "today",
    codes: ["tel_link", "phone_in_header"],
  },
  {
    id: "reach-without-phoning",
    title: "Let people reach you without phoning",
    summary: "Anyone who would rather message than call has no way to do it, so they leave instead.",
    whatItIs: "",
    howYouSayIt: "",
    whatWeDeliver: [],
    stage: "today",
    codes: ["contact_form", "short_form", "email_route", "chat", "multi_route"],
  },
  {
    id: "book-themselves-in",
    title: "Let them book themselves in",
    summary: "A customer deciding at night has no way to lock in a time, so they have booked with someone else by morning.",
    whatItIs: "",
    howYouSayIt: "",
    whatWeDeliver: [],
    stage: "today",
    codes: ["booking"],
  },
  {
    id: "tell-them-what-to-do-next",
    title: "Tell them what to do next",
    summary: "A visitor can read the whole page and still not know what you want, so they do nothing.",
    whatItIs: "",
    howYouSayIt: "",
    whatWeDeliver: [],
    stage: "today",
    codes: ["cta_present"],
  },
  {
    id: "look-established",
    title: "Look like a real, established business",
    summary: "Nothing on the page proves you're legit, local or experienced, so a stranger has to take your word for it.",
    whatItIs: "",
    howYouSayIt: "",
    whatWeDeliver: [],
    stage: "today",
    codes: ["testimonials", "review_platform", "credentials", "real_photos", "address", "map", "years_trading", "guarantee"],
  },
  {
    id: "look-current",
    title: "Look current, not dated",
    summary: "The site reads as unfinished or years old, which undercuts the trust the rest of the page is trying to build.",
    whatItIs: "",
    howYouSayIt: "",
    whatWeDeliver: [],
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
    whatItIs: "",
    howYouSayIt: "",
    whatWeDeliver: [],
    stage: "today",
    codes: ["viewport", "responsive_css", "no_fixed_width", "tap_targets"],
  },
  {
    id: "say-what-you-do",
    title: "Say what you actually do, and where",
    summary: "A visitor can't tell what you handle or whether you cover their area, so they can't decide to call.",
    whatItIs: "",
    howYouSayIt: "",
    whatWeDeliver: [],
    stage: "today",
    codes: ["substantial", "service_detail", "headings", "service_area", "pricing_signal"],
  },
  {
    id: "load-fast-enough-to-stay",
    title: "Load fast enough that they stay",
    summary: "The page is slow enough that some visitors give up before it even appears.",
    whatItIs: "",
    howYouSayIt: "",
    whatWeDeliver: [],
    stage: "today",
    codes: ["fast_ttfb", "lean_html", "few_blocking"],
  },
  {
    id: "findable-and-safe-to-click",
    title: "Be findable, and safe to click",
    summary: "Search engines and shared links undersell you, and a security warning can chase a visitor off before they read a word.",
    whatItIs: "",
    howYouSayIt: "",
    whatWeDeliver: [],
    stage: "today",
    codes: ["https", "title", "meta_desc", "local_schema", "og_tags", "h1"],
  },

  // ---- the ladder: OASIS_UNDENIABLE_OFFER_STRATEGY.md §5 ------------------
  {
    id: "missed-call-text-back",
    title: "Missed-call text-back",
    summary: "When you can't pick up, the caller gets an automatic text instead of silence, so they don't hang up and dial the next name on the list.",
    whatItIs: "",
    howYouSayIt: "",
    whatWeDeliver: [],
    stage: "after_evidence",
    stageReason:
      "This is a plan change on a website you already trust, not a new sale from a stranger, so we wait until two monthly evidence reports have landed and you've seen the site working before offering it.",
    codes: [],
  },
  {
    id: "speed-to-lead",
    title: "Speed-to-lead",
    summary: "The moment someone fills out your form, they get a reply in seconds instead of waiting on you to notice it and moving on to a competitor.",
    whatItIs: "",
    howYouSayIt: "",
    whatWeDeliver: [],
    stage: "after_evidence",
    stageReason:
      "Same reason as missed-call text-back: it only replies to someone who already reached out, and it waits for two evidence reports so it lands as an upgrade to a working relationship, not a cold pitch.",
    codes: [],
  },
  {
    id: "ai-front-desk",
    title: "AI front desk",
    summary: "Calls get answered and questions get handled even when nobody's free to pick up.",
    whatItIs: "",
    howYouSayIt: "",
    whatWeDeliver: [],
    stage: "month_six_plus",
    stageReason:
      "This touches your bookings and customer records, which is a bigger ask than a website, so it waits until month six or later and comes with a written page on exactly where that data lives and who's accountable for it.",
    codes: [],
  },
  {
    id: "booking-agent",
    title: "Booking agent",
    summary: "Customers book themselves in around the clock, checked against your real calendar instead of a guess.",
    whatItIs: "",
    howYouSayIt: "",
    whatWeDeliver: [],
    stage: "month_six_plus",
    stageReason:
      "Same reason as the front desk: it's inside your bookings and customer data, so it's a month-six-plus conversation with the data-custody page in hand, not a first-call add-on.",
    codes: [],
  },
  {
    id: "custom-agentic-software",
    title: "Custom agentic software",
    summary: "Once the website and the automations before it are proven, we build the specific system that runs a repeatable part of your business.",
    whatItIs: "",
    howYouSayIt: "",
    whatWeDeliver: [],
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
