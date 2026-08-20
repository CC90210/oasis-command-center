export type WebsitePackageId = "essential" | "growth" | "authority";
export type AutomationAddOnId =
  | "google_reviews"
  | "lead_routing"
  | "gmail_classifier"
  | "missed_call_recovery"
  | "quote_followup"
  | "appointment_reminders"
  | "lead_reactivation"
  | "document_generation"
  | "local_seo";

export type WebsitePackage = {
  id: WebsitePackageId;
  name: string;
  setupFloor: number;
  monthlyFloor: number;
  includedAutomationCount: number;
  features: string[];
};

export type AutomationAddOn = {
  id: AutomationAddOnId;
  name: string;
  diagnostic: string;
  /** What the client actually receives. Shown to reps so nobody improvises scope. */
  delivers: string;
};
export type WebsiteSalesStage = (typeof WEBSITE_SALES_STAGES)[number];
export type ProposalStatus = "not_started" | "draft" | "sent" | "accepted" | "declined";
export type CommissionStatus = "accrued" | "approved" | "paid" | "offset" | "voided";

export type SalesQualification = {
  authorityConfirmed: boolean;
  websiteProblemConfirmed: boolean;
  timingConfirmed: boolean;
  minimumInvestmentConfirmed: boolean;
  notes: string;
};

export type FounderHandoff = {
  founderUserId: string;
  meetingAt: string;
  promisedDemo: string;
  repUserId: string;
};

export type WebsiteDeal = {
  leadId: string;
  packageId: WebsitePackageId;
  automationIds: AutomationAddOnId[];
  setupAmount: number;
  monthlyAmount: number;
  currency: "CAD" | "USD";
  proposalStatus: ProposalStatus;
};

export type CommissionAccrual = {
  id: string;
  dealId: string;
  repUserId: string;
  collectedSetupAmount: number;
  rate: number;
  amount: number;
  status: CommissionStatus;
};

export const WEBSITE_PACKAGES: Record<WebsitePackageId, WebsitePackage> = {
  essential: {
    id: "essential", name: "Essential", setupFloor: 2_000, monthlyFloor: 250, includedAutomationCount: 0,
    features: ["Conversion-focused website", "Lead form", "Hosting and maintenance", "Analytics", "Basic SEO"],
  },
  growth: {
    id: "growth", name: "Growth", setupFloor: 3_500, monthlyFloor: 350, includedAutomationCount: 1,
    features: ["Everything in Essential", "Additional pages", "Copy support", "Booking or review integration", "One standard automation"],
  },
  authority: {
    id: "authority", name: "Authority", setupFloor: 5_000, monthlyFloor: 500, includedAutomationCount: 2,
    features: ["Everything in Growth", "Advanced SEO", "Custom integrations", "Two standard automations"],
  },
};

/**
 * The sellable menu (v2, 2026-08-20 — operator-refined).
 *
 * Every item here is text/email based and runs on OASIS-owned infrastructure:
 * we hold the sending address and the app passwords, so onboarding never waits
 * on a client's credentials. NOTHING on this menu answers a phone call — OASIS
 * does not sell AI voice agents, and "missed-call recovery" means an instant
 * SMS text-back, never a voice bot. A rep who cannot point at the line below
 * has left the approved menu and must route the ask to CC or Adon.
 */
export const AUTOMATION_ADD_ONS: AutomationAddOn[] = [
  {
    id: "lead_routing",
    name: "Website lead capture and routing",
    diagnostic: "When a form comes in at 9pm, who sees it and how fast?",
    delivers: "Form submissions hit our agent instantly: the customer gets an answer, the owner gets a notification, and the lead lands in their CRM — with the owner's inbox copied on every reply.",
  },
  {
    id: "gmail_classifier",
    name: "Inbound email auto-reply and sorting",
    diagnostic: "Who is answering the info@ inbox, and how long do people wait?",
    delivers: "Our agent reads every inbound email, sorts real customers from noise, and sends a first reply in the business's own voice — with the owner copied so nothing happens behind their back.",
  },
  {
    id: "missed_call_recovery",
    name: "Missed-call text-back",
    diagnostic: "How many calls go to voicemail in a week, and what happens next?",
    delivers: "A missed call triggers an immediate SMS so the customer is engaged before they dial a competitor. Text only — no voice agent, no phone tree, nobody's call gets answered by a robot.",
  },
  {
    id: "quote_followup",
    name: "Quote and estimate follow-up",
    diagnostic: "After you send an estimate, who chases it — and when do you stop?",
    delivers: "A timed follow-up sequence on every quote until the customer replies or the sequence ends, so estimates stop dying in silence.",
  },
  {
    id: "appointment_reminders",
    name: "Appointment reminders",
    diagnostic: "What does a no-show cost you, and how often does it happen?",
    delivers: "Automatic reminders before each booking, with a simple confirm-or-reschedule reply.",
  },
  {
    id: "google_reviews",
    name: "Google review requests",
    diagnostic: "Are happy customers actually being asked for the review?",
    delivers: "A review request goes out after each completed job, timed so it lands while the customer is still pleased.",
  },
  {
    id: "lead_reactivation",
    name: "Dormant-lead reactivation",
    diagnostic: "How many old leads are sitting in your phone or inbox untouched?",
    delivers: "A one-time campaign across the existing list to restart conversations with people who already know the business.",
  },
];

/**
 * Retired from the sell sheet, kept resolvable forever: deals closed before
 * 2026-08-20 carry these ids in website_deals.automation_ids, and a name lookup
 * that returns blank would make a signed contract render as an empty row.
 * Retired because they confused the pitch, not because they were bad work:
 * document generation varies too much per client to quote from a menu, and
 * local SEO reporting is already inside the website packages' SEO scope.
 */
export const RETIRED_AUTOMATION_ADD_ONS: AutomationAddOn[] = [
  {
    id: "document_generation",
    name: "Document generation (retired)",
    diagnostic: "Which invoices, estimates, or documents are repetitive?",
    delivers: "Retired from the menu — quote as custom scope through CC or Adon.",
  },
  {
    id: "local_seo",
    name: "Local SEO reporting (retired)",
    diagnostic: "Can the owner see which local searches create calls?",
    delivers: "Retired as a separate add-on — SEO is included in the website packages.",
  },
];

const AUTOMATION_ADD_ON_BY_ID: Record<AutomationAddOnId, AutomationAddOn> = Object.fromEntries(
  [...AUTOMATION_ADD_ONS, ...RETIRED_AUTOMATION_ADD_ONS].map((a) => [a.id, a]),
) as Record<AutomationAddOnId, AutomationAddOn>;

/** Resolve any id — active or retired — for rendering historical deals. */
export function automationAddOn(id: AutomationAddOnId): AutomationAddOn | undefined {
  return AUTOMATION_ADD_ON_BY_ID[id];
}

/** Only active ids may be attached to a NEW quote. */
export function isSellableAutomation(id: string): id is AutomationAddOnId {
  return AUTOMATION_ADD_ONS.some((a) => a.id === id);
}

export const WEBSITE_SALES_STAGES = [
  "researched", "assigned", "attempting_contact", "connected", "qualified",
  "founder_meeting_booked", "demo_completed", "proposal_sent", "won", "lost",
  "onboarding", "in_build", "client_review", "launched",
] as const;

/**
 * Comp model v2 (2026-08-19, operator-approved) — REPLACES the deal-size tiers.
 * Commission is on collected setup revenue only, never recurring. Who closed
 * decides the rate, not the deal size. Rep-closed deals still accrue only —
 * founder approval gates payout (accrued → approved → paid), never auto-approve.
 */
export const COMMISSION_MODEL = {
  opener: 0.2,        // rep opened (booked the founder meeting); founder closed
  openerCloser: 0.3,  // rep opened AND closed the deal themselves
  floorSetup: 2000,   // below this collected setup: no deal, no commission
} as const;

export function calculateCommission(collectedSetupAmount: number, repClosed: boolean): { rate: number; amount: number } {
  if (collectedSetupAmount < COMMISSION_MODEL.floorSetup) return { rate: 0, amount: 0 };
  const rate = repClosed ? COMMISSION_MODEL.openerCloser : COMMISSION_MODEL.opener;
  return { rate, amount: Math.round(collectedSetupAmount * rate * 100) / 100 };
}

export function validateQuote(packageId: WebsitePackageId, setupAmount: number, monthlyAmount: number, founderOverride: boolean) {
  if (founderOverride) return { ok: true as const };
  const offer = WEBSITE_PACKAGES[packageId];
  if (setupAmount < offer.setupFloor) return { ok: false as const, error: `Setup price is below the ${offer.name} floor of ${offer.setupFloor}` };
  if (monthlyAmount < offer.monthlyFloor) return { ok: false as const, error: `Monthly price is below the ${offer.name} floor of ${offer.monthlyFloor}` };
  return { ok: true as const };
}
