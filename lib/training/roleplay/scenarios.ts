/**
 * The businesses a rep practises against.
 *
 * 🚨 EVERY ONE IS INVENTED, and that is a fence rather than laziness. A role-play
 * built on a real lead would put a real business's name, trade and website
 * defects into a model prompt, and this estate's rule is that merchant-bearing
 * work does not go to third parties. Synthetic scenarios remove the question
 * entirely, and they train better: a rep practises a SITUATION they will meet
 * many times rather than burning one real lead they could have called.
 *
 * None of these names, towns or numbers belong to anybody. They are written to
 * be typical, not to resemble a particular customer.
 *
 * WHAT EACH ONE CARRIES, and why. The disposition is what makes two scenarios
 * with the same defect feel different: the same broken booking page is a
 * different call with a curious owner than with one who has been sold to three
 * times this week. `opensWith` ties the scenario to the live objection catalog,
 * so what a rep drilled in Objections is what the owner actually says.
 */

export type Disposition = "busy" | "skeptical" | "curious" | "burned";

export type RoleplayScenario = {
  id: string;
  /** The invented business. */
  business: string;
  trade: string;
  /** What the rep can see before the call, as the battle card would show it. */
  visible: string[];
  disposition: Disposition;
  /** How the owner behaves, in the persona prompt's own words. */
  temperament: string;
  /** The objection they lead with. Matches a slug in the live catalog so the
   *  drill and the call teach the same thing. */
  opensWith: string;
  /** What the rep has to get to for this call to have gone anywhere. */
  winsIf: string;
  difficulty: "starter" | "harder" | "hardest";
};

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  busy: "Busy, half listening",
  skeptical: "Skeptical, has heard it before",
  curious: "Curious, but cautious",
  burned: "Burned by an agency before",
};

export const SCENARIOS: RoleplayScenario[] = [
  {
    id: "roofer-busy",
    business: "Crestline Roofing",
    trade: "Roofing, two crews, small town",
    visible: [
      "No way to contact them except a phone number in an image",
      "Site last updated several years ago",
      "No service area listed anywhere",
    ],
    disposition: "busy",
    temperament:
      "You are on a job site and genuinely busy. You are not rude, but you answer in short sentences and you will hang up on anything that sounds like a script. You warm up slightly if the rep says something specific about YOUR site rather than a generic pitch.",
    opensWith: "not-interested",
    winsIf: "You agree to a short call later, at a named time, or you ask one real question about the problem.",
    difficulty: "starter",
  },
  {
    id: "salon-word-of-mouth",
    business: "Ruby Lane Hair",
    trade: "Hair salon, three chairs",
    visible: [
      "Facebook page is active, website has not been touched in years",
      "No online booking",
      "Opening hours only listed on the social page",
    ],
    disposition: "curious",
    temperament:
      "You are proud that almost all your work comes from regulars and referrals, and you will say so early. You are not hostile and you will talk, but you genuinely believe you do not need this. You respond well to being asked about your own customers and badly to being told your business is missing out.",
    opensWith: "word-of-mouth",
    winsIf: "You admit that somebody new might look you up first, or you ask what that would change.",
    difficulty: "starter",
  },
  {
    id: "plumber-nephew",
    business: "Dalton and Sons Plumbing",
    trade: "Plumbing, family run",
    visible: [
      "Site was built by a relative",
      "Contact form goes nowhere",
      "Loads slowly on a phone",
    ],
    disposition: "skeptical",
    temperament:
      "Your nephew built the site and you are quietly protective of that. You will not say so outright, but you get shorter if the rep criticises the work. You respond well to a rep who does not insult it and talks about what the site DOES rather than who made it.",
    opensWith: "nephew-built-website",
    winsIf: "You let the rep tell you the one thing they noticed, without defending the site.",
    difficulty: "harder",
  },
  {
    id: "clinic-budget",
    business: "Northfield Physio",
    trade: "Physiotherapy clinic",
    visible: [
      "No online booking, phone only",
      "No pricing or service detail",
      "Reviews exist on a third-party site but nowhere on the page",
    ],
    disposition: "skeptical",
    temperament:
      "You raise cost early and often, before hearing what anything is. You are testing whether the rep will blurt a number. If they do, you push on it and lose interest. If they refuse to guess and ask about your process instead, you engage.",
    opensWith: "no-budget",
    winsIf: "The rep gets you talking about what happens when somebody calls and nobody picks up, WITHOUT quoting a price.",
    difficulty: "harder",
  },
  {
    id: "electrician-burned",
    business: "Halloway Electrical",
    trade: "Electrical contractor",
    visible: [
      "Site exists but has no service pages",
      "Not findable for the work they actually do",
      "Contact form present, unclear if monitored",
    ],
    disposition: "burned",
    temperament:
      "You paid an agency a lot two years ago and got very little. You are cynical and you will say so. You interrupt. You are not looking for a fight, you are looking for a reason to believe this is different. Specifics earn you; promises lose you instantly.",
    opensWith: "just-send-email",
    winsIf: "You agree to something small and concrete rather than a proposal, or you ask a direct question about what would be different.",
    difficulty: "hardest",
  },
];

export function scenarioById(id: string): RoleplayScenario | null {
  return SCENARIOS.find((s) => s.id === id) ?? null;
}
