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

export type AutomationAddOn = { id: AutomationAddOnId; name: string; diagnostic: string };
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

export const AUTOMATION_ADD_ONS: AutomationAddOn[] = [
  { id: "google_reviews", name: "Google review follow-up", diagnostic: "Are happy customers consistently asked for a review?" },
  { id: "lead_routing", name: "Lead capture and CRM routing", diagnostic: "What happens after a website form arrives?" },
  { id: "gmail_classifier", name: "Gmail inbound classification", diagnostic: "Who sorts and routes the shared inbox?" },
  { id: "missed_call_recovery", name: "Missed-call recovery", diagnostic: "What happens to missed and after-hours calls?" },
  { id: "quote_followup", name: "Quote follow-up", diagnostic: "Who follows up after an estimate is sent?" },
  { id: "appointment_reminders", name: "Appointment reminders", diagnostic: "How much do no-shows cost each month?" },
  { id: "lead_reactivation", name: "Dormant-lead reactivation", diagnostic: "How many old leads are sitting untouched?" },
  { id: "document_generation", name: "Document generation", diagnostic: "Which invoices, estimates, or documents are repetitive?" },
  { id: "local_seo", name: "Local SEO reporting", diagnostic: "Can the owner see which local searches create calls?" },
];

export const WEBSITE_SALES_STAGES = [
  "researched", "assigned", "attempting_contact", "connected", "qualified",
  "founder_meeting_booked", "demo_completed", "proposal_sent", "won", "lost",
  "onboarding", "in_build", "client_review", "launched",
] as const;

export function calculateCommission(collectedSetupAmount: number) {
  const rate = collectedSetupAmount >= 5_000 ? 0.15 : collectedSetupAmount >= 3_500 ? 0.125 : collectedSetupAmount >= 2_000 ? 0.1 : 0;
  return { rate, amount: Math.round(collectedSetupAmount * rate * 100) / 100 };
}

export function validateQuote(packageId: WebsitePackageId, setupAmount: number, monthlyAmount: number, founderOverride: boolean) {
  if (founderOverride) return { ok: true as const };
  const offer = WEBSITE_PACKAGES[packageId];
  if (setupAmount < offer.setupFloor) return { ok: false as const, error: `Setup price is below the ${offer.name} floor of ${offer.setupFloor}` };
  if (monthlyAmount < offer.monthlyFloor) return { ok: false as const, error: `Monthly price is below the ${offer.name} floor of ${offer.monthlyFloor}` };
  return { ok: true as const };
}
