/**
 * Public OASIS checkout catalogue.
 *
 * The browser sends two opaque ids. The server resolves both ids here and
 * sends the amount to Stripe; a visitor can never choose an arbitrary amount
 * by editing the request body.
 */

export type CheckoutOption = {
  id: string;
  label: string;
  amountCents: number;
  description: string;
};

export type CheckoutOffer = {
  id: string;
  name: string;
  shortName: string;
  rangeLabel: string;
  summary: string;
  featured?: boolean;
  options: readonly CheckoutOption[];
  includes: readonly string[];
};

export const CHECKOUT_OFFERS: readonly CheckoutOffer[] = [
  {
    id: "audit-sprint",
    name: "Conversion Audit & Optimization Sprint",
    shortName: "Audit sprint",
    rangeLabel: "$1,500-$2,500 CAD",
    summary: "Find the leaks, rank the fixes, and ship the highest-impact improvements first.",
    options: [
      { id: "focused", label: "Focused", amountCents: 150_000, description: "One conversion path and a prioritized repair plan." },
      { id: "growth", label: "Growth", amountCents: 200_000, description: "Two conversion paths plus implementation support." },
      { id: "intensive", label: "Intensive", amountCents: 250_000, description: "Full-funnel review, fixes, and measurement handoff." },
    ],
    includes: ["Funnel and analytics audit", "Prioritized repair backlog", "Conversion tracking validation"],
  },
  {
    id: "sales-setter",
    name: "Autonomous AI Sales Setter & Speed-to-Lead System",
    shortName: "AI sales setter",
    rangeLabel: "$3,500-$5,000 CAD",
    summary: "Respond while intent is hot, qualify consistently, and keep every lead moving.",
    featured: true,
    options: [
      { id: "launch", label: "Launch", amountCents: 350_000, description: "One lead source, qualification, and booking workflow." },
      { id: "scale", label: "Scale", amountCents: 425_000, description: "Multi-source intake with follow-up and CRM routing." },
      { id: "complete", label: "Complete", amountCents: 500_000, description: "End-to-end setter system with reporting and tuning." },
    ],
    includes: ["Instant lead response", "Qualification and booking", "CRM handoff and follow-up"],
  },
  {
    id: "enterprise-fleet",
    name: "Custom Enterprise AI Operating System / Agent Fleet",
    shortName: "Enterprise fleet",
    rangeLabel: "$7,500-$15,000+ CAD",
    summary: "A coordinated agent team with approvals, memory, reporting, and the operating layer beneath it.",
    options: [
      { id: "foundation", label: "Foundation", amountCents: 750_000, description: "Command center plus the first production agent seat." },
      { id: "scale", label: "Scale", amountCents: 1_000_000, description: "A multi-agent department with shared context and controls." },
      { id: "enterprise", label: "Enterprise", amountCents: 1_500_000, description: "A cross-department fleet; larger scopes continue by proposal." },
    ],
    includes: ["Custom command center", "Coordinated agent roster", "Governance, approvals, and observability"],
  },
] as const;

export type ResolvedCheckoutOffer = {
  offer: CheckoutOffer;
  option: CheckoutOption;
};

export function resolveCheckoutOffer(offerId: unknown, optionId: unknown): ResolvedCheckoutOffer | null {
  if (typeof offerId !== "string" || typeof optionId !== "string") return null;
  const offer = CHECKOUT_OFFERS.find((candidate) => candidate.id === offerId);
  const option = offer?.options.find((candidate) => candidate.id === optionId);
  return offer && option ? { offer, option } : null;
}

export function cad(amountCents: number): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  }).format(amountCents / 100);
}
