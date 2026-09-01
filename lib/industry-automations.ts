export type AutomationBuildType = "Website" | "Website + workflow" | "Custom build";

export type IndustryAutomation = {
  name: string;
  outcome: string;
  discovery: string;
  buildType: AutomationBuildType;
};

export type IndustryAutomationGroup = {
  id: string;
  label: string;
  aliases: readonly string[];
  automations: readonly IndustryAutomation[];
};

const a = (
  name: string,
  outcome: string,
  discovery: string,
  buildType: AutomationBuildType,
): IndustryAutomation => ({ name, outcome, discovery, buildType });

/**
 * The rep-facing automation menu. This is intentionally fixed, reviewed copy:
 * the battle card must never invent a capability or promise feasibility on a
 * live call. Reps discover the leak; CC or Adon confirms scope and price.
 */
export const INDUSTRY_AUTOMATIONS: readonly IndustryAutomationGroup[] = [
  {
    id: "restaurants-bars",
    label: "Restaurants & Bars",
    aliases: ["restaurant", "bar", "pub", "cafe", "coffee", "food", "bakery", "catering"],
    automations: [
      a("Reservation capture", "Turn website and Google traffic into confirmed bookings with reminders.", "How are reservations handled when the phone is busy?", "Website + workflow"),
      a("Missed-call text-back", "Text callers instantly with hours, booking, menu, or catering links.", "What happens when nobody can answer during a rush?", "Website + workflow"),
      a("Private-event lead flow", "Qualify party size, date, budget, and menu needs before staff follows up.", "How many event inquiries arrive without enough detail to quote?", "Website + workflow"),
      a("Review recovery", "Ask happy guests for a review and route poor experiences to a manager first.", "Do you consistently ask satisfied guests for reviews?", "Custom build"),
      a("Lapsed-guest reactivation", "Bring past guests back with permission-based offers and occasion campaigns.", "Do you have a guest list you can actually market to?", "Custom build"),
      a("Waitlist and table-ready alerts", "Collect the party once and text status updates without repeated calls.", "How does the host manage waitlist updates on a busy night?", "Custom build"),
      a("Catering quote intake", "Capture headcount, date, location, dietary needs, and budget in one guided form.", "How much staff time goes into chasing catering details?", "Website"),
      a("Menu and hours assistant", "Answer approved questions from current menu, allergen, parking, and hours data.", "Which basic questions interrupt the team most often?", "Website"),
    ],
  },
  {
    id: "home-services",
    label: "Home Services & Trades",
    aliases: ["hvac", "plumb", "electric", "roof", "landscap", "contractor", "cleaning", "pest", "handyman", "renovation"],
    automations: [
      a("Estimate intake", "Collect job type, address, urgency, photos, and preferred time before dispatch.", "What information does the office chase before it can price or schedule?", "Website + workflow"),
      a("Missed-call text-back", "Recover after-hours and on-job calls with immediate qualification and booking.", "How many calls hit voicemail while the crew is working?", "Website + workflow"),
      a("Lead-to-estimate follow-up", "Nudge unbooked inquiries and open estimates until the customer decides.", "Who follows every estimate that goes quiet?", "Custom build"),
      a("Appointment reminders", "Reduce no-shows with confirmation, arrival-window, and reschedule messages.", "How often does a crew arrive and nobody is available?", "Custom build"),
      a("Maintenance reminders", "Trigger seasonal service, filter, inspection, or warranty reminders.", "Do past customers reliably return for maintenance?", "Custom build"),
      a("Review and referral request", "Ask after completed work, then make referral sharing one tap.", "Is every successful job producing a review or referral ask?", "Custom build"),
      a("Service-area qualifier", "Confirm postal code, property type, and service fit before a rep spends time.", "How often are inquiries outside your service area or scope?", "Website"),
      a("Emergency triage", "Route urgent, routine, and unsafe situations to the correct next step.", "Does every emergency inquiry reach the right person quickly?", "Custom build"),
    ],
  },
  {
    id: "health-wellness",
    label: "Health, Dental & Wellness",
    aliases: ["clinic", "dental", "dentist", "chiro", "physio", "therapy", "medical", "wellness", "spa", "massage", "optom"],
    automations: [
      a("Consultation booking", "Match the visitor to the right service and collect non-clinical intake before booking.", "How many inquiries need staff help just to choose an appointment type?", "Website + workflow"),
      a("Appointment reminders", "Confirm attendance and make rescheduling easy to reduce empty slots.", "What does one no-show cost the practice?", "Custom build"),
      a("Waitlist fill", "Offer cancelled slots to an approved waitlist in order and stop once filled.", "How quickly can you refill a same-day cancellation?", "Custom build"),
      a("Recall and rebooking", "Prompt overdue hygiene, follow-up, or recurring wellness appointments.", "How are patients reminded when they are due to return?", "Custom build"),
      a("FAQ and coverage guide", "Answer approved administrative questions without giving medical advice.", "Which insurance, parking, pricing, or prep questions repeat all day?", "Website"),
      a("Review request", "Request feedback after completed visits with a private recovery path.", "Is feedback requested consistently after a good visit?", "Custom build"),
      a("Referral intake", "Capture referral source, service need, preferred location, and documents securely.", "Where do incomplete referrals slow the front desk down?", "Website + workflow"),
      a("Post-visit instructions", "Send clinic-approved instructions and next-step reminders after a visit.", "How often do patients call back for instructions already explained?", "Custom build"),
    ],
  },
  {
    id: "professional-services",
    label: "Professional Services",
    aliases: ["law", "legal", "account", "bookkeep", "consult", "agency", "insurance", "financial", "architect", "engineer"],
    automations: [
      a("Qualified consultation intake", "Capture matter type, urgency, budget, and conflicts-safe contact details.", "How many consultations are booked before fit is known?", "Website + workflow"),
      a("Document collection", "Request the right files, acknowledge receipt, and chase only what is missing.", "How much time goes into asking clients for the same missing documents?", "Custom build"),
      a("Proposal follow-up", "Follow open proposals with useful reminders and a clear booking or acceptance path.", "Who owns follow-up when a proposal goes quiet?", "Custom build"),
      a("Client onboarding", "Move a signed client through payment, forms, scheduling, and kickoff automatically.", "What has to be copied and pasted every time a client says yes?", "Custom build"),
      a("Meeting preparation", "Collect agenda items and send approved preparation material before the meeting.", "How often does a meeting start without the information you need?", "Website + workflow"),
      a("Status update workflow", "Send milestone updates and collect approvals without repetitive check-in emails.", "How many 'just checking status' messages does the team answer?", "Custom build"),
      a("Knowledge-base assistant", "Answer from firm-approved services, process, and policy content with a handoff.", "Which pre-sales questions does your team answer repeatedly?", "Website"),
      a("Referral partner follow-up", "Acknowledge referrals, track their stage, and close the loop with the source.", "Do referral partners know what happened after they introduced someone?", "Custom build"),
    ],
  },
  {
    id: "real-estate",
    label: "Real Estate & Property",
    aliases: ["real estate", "realtor", "brokerage", "property", "mortgage", "leasing", "apartment", "condo"],
    automations: [
      a("Buyer or seller qualifier", "Separate intent, timing, area, financing, and property needs before assignment.", "How quickly can you tell which new leads deserve an immediate call?", "Website + workflow"),
      a("Listing inquiry response", "Reply instantly with listing details and a showing path while routing the lead.", "What happens to an inquiry that arrives while an agent is showing a home?", "Website + workflow"),
      a("Showing reminders", "Confirm attendance, share access instructions, and collect post-showing feedback.", "How much time is lost coordinating and chasing showing feedback?", "Custom build"),
      a("Long-term nurture", "Keep permissioned buyers and sellers warm by timeline and neighbourhood interest.", "What happens to someone who says they are six months away?", "Custom build"),
      a("Open-house follow-up", "Capture visitors once, segment intent, and trigger the right next conversation.", "How are open-house sign-ins followed up the same day?", "Website + workflow"),
      a("Valuation request flow", "Collect property facts and book the pricing conversation without promising a value.", "Does your home-value form produce enough context for a useful call?", "Website"),
      a("Document and milestone updates", "Guide clients through conditions, signatures, inspection, and closing milestones.", "Which transaction updates are repeatedly sent by hand?", "Custom build"),
      a("Review and referral request", "Ask at possession or closing and keep the relationship warm afterward.", "Is every successful closing producing a review and referral conversation?", "Custom build"),
    ],
  },
  {
    id: "retail-ecommerce",
    label: "Retail & E-commerce",
    aliases: ["retail", "shop", "store", "ecommerce", "e-commerce", "boutique", "jewel", "fashion"],
    automations: [
      a("Product finder", "Guide shoppers to the right product by need, fit, budget, or compatibility.", "Where do shoppers get stuck choosing between products?", "Website"),
      a("Abandoned-cart recovery", "Bring permissioned shoppers back with product-aware reminders.", "How much checkout intent disappears without a follow-up?", "Website + workflow"),
      a("Back-in-stock alerts", "Capture demand and notify shoppers automatically when inventory returns.", "Do out-of-stock visitors have a reason to come back?", "Website + workflow"),
      a("Post-purchase education", "Send setup, care, replenishment, and complementary-product guidance.", "Which after-purchase questions create the most support work?", "Custom build"),
      a("Review and UGC request", "Ask verified buyers for a review or photo at the right point after delivery.", "Is every happy buyer asked for proof future shoppers can trust?", "Custom build"),
      a("Win-back campaigns", "Reactivate customers based on last purchase and replenishment timing.", "Do past buyers hear from you when it is actually time to buy again?", "Custom build"),
      a("Order-status assistant", "Answer from real order data or route exceptions to support.", "How many support contacts are simply 'where is my order'?", "Custom build"),
      a("Wholesale inquiry intake", "Qualify retailer type, volume, territory, and product interest before follow-up.", "How are wholesale inquiries separated from ordinary customer questions?", "Website + workflow"),
    ],
  },
  {
    id: "automotive",
    label: "Automotive",
    aliases: ["auto", "car", "vehicle", "mechanic", "tire", "collision", "dealership", "detailing", "garage"],
    automations: [
      a("Service booking intake", "Collect vehicle, issue, urgency, mileage, and preferred time before confirmation.", "How much time does the desk spend gathering vehicle details by phone?", "Website + workflow"),
      a("Estimate follow-up", "Follow unsold repair or body-work estimates until the customer decides.", "What happens to a quote when the customer says they need to think?", "Custom build"),
      a("Maintenance reminders", "Trigger service by date, mileage estimate, season, or prior work.", "How reliably do customers return for their next service?", "Custom build"),
      a("Repair status updates", "Send approved milestone updates without customers repeatedly calling the shop.", "How many inbound calls are just asking whether the vehicle is ready?", "Custom build"),
      a("Trade-in qualifier", "Collect vehicle condition, mileage, photos, and purchase timing before appraisal.", "Do trade-in leads arrive with enough information to act on?", "Website + workflow"),
      a("Test-drive scheduling", "Match vehicle interest with availability, assigned rep, and reminders.", "How quickly does an online vehicle inquiry become a confirmed visit?", "Website + workflow"),
      a("Review request", "Ask after pickup and route service issues privately for recovery.", "Is every successful pickup followed by a review ask?", "Custom build"),
      a("Seasonal tire flow", "Coordinate storage status, swap bookings, and seasonal reminders.", "What does tire season do to your phone and front desk?", "Custom build"),
    ],
  },
  {
    id: "fitness-beauty",
    label: "Fitness, Beauty & Personal Care",
    aliases: ["gym", "fitness", "salon", "beauty", "barber", "nail", "lash", "tattoo", "personal training", "yoga"],
    automations: [
      a("Service or membership matcher", "Guide visitors to the right service, provider, class, or membership.", "How often do prospects need help deciding what to book?", "Website"),
      a("Consultation and booking flow", "Collect goals, preferences, availability, and consent before scheduling.", "What information do you need before accepting a new client?", "Website + workflow"),
      a("No-show reduction", "Confirm appointments and provide a simple reschedule path.", "What do late cancellations and no-shows cost each week?", "Custom build"),
      a("Waitlist fill", "Offer openings to interested clients and stop messaging once the slot is filled.", "Can you refill a cancellation without calling down a list?", "Custom build"),
      a("Membership lead nurture", "Follow trials and inquiries with approved proof, offers, and booking prompts.", "What happens after someone downloads a pass but does not visit?", "Custom build"),
      a("Rebooking reminder", "Prompt the next appointment based on service cadence or provider recommendation.", "How many good clients leave without their next visit booked?", "Custom build"),
      a("Review and referral request", "Ask happy clients for public proof and make referrals easy.", "Is every strong client experience turned into a review or introduction?", "Custom build"),
      a("Aftercare delivery", "Send provider-approved care instructions and product reminders after service.", "Which aftercare questions get repeated after every appointment?", "Custom build"),
    ],
  },
  {
    id: "education-childcare",
    label: "Education & Childcare",
    aliases: ["school", "education", "tutor", "childcare", "daycare", "academy", "course", "training", "camp"],
    automations: [
      a("Program matcher", "Guide families or learners to the right age, level, schedule, and program.", "How much staff time goes into explaining which program fits?", "Website"),
      a("Tour or assessment booking", "Collect learner needs and confirm the right next appointment.", "How quickly does an inquiry become a booked tour or assessment?", "Website + workflow"),
      a("Enrollment follow-up", "Nurture incomplete applications and remind families what is still needed.", "Where do prospective enrollments most often stall?", "Custom build"),
      a("Document collection", "Request forms and records, confirm receipt, and chase only missing items.", "How often does staff manually ask for missing enrollment documents?", "Custom build"),
      a("Attendance and schedule alerts", "Send approved reminders for classes, closures, and schedule changes.", "Which schedule updates generate the most inbound calls?", "Custom build"),
      a("Waitlist workflow", "Maintain position, confirm continued interest, and offer openings fairly.", "How is the waitlist kept accurate today?", "Custom build"),
      a("Parent or learner FAQ", "Answer from approved program, policy, fee, and calendar information.", "Which administrative questions repeat every week?", "Website"),
      a("Renewal and re-enrollment", "Prompt returning families or learners before a term or program ends.", "Are good students systematically invited back?", "Custom build"),
    ],
  },
];

export function matchIndustryAutomationGroup(industry?: string | null): IndustryAutomationGroup {
  const value = (industry || "").trim().toLowerCase();
  if (!value) return INDUSTRY_AUTOMATIONS[0];
  return INDUSTRY_AUTOMATIONS.find((group) =>
    group.aliases.some((alias) => value.includes(alias) || alias.includes(value)),
  ) ?? INDUSTRY_AUTOMATIONS[0];
}
