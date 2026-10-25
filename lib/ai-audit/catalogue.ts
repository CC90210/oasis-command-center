/**
 * lib/ai-audit/catalogue.ts — the one service catalogue proposals price from.
 *
 * CC's decision (2026-10-25): "One new catalogue I confirm." The seed below is
 * copied, line for line, from the four places prices lived before this
 * existed, and every item starts PROPOSED. A proposed item cannot be put on a
 * proposal. Only CC (the workspace owner) confirms an item, and a confirmed
 * price never changes: editing makes a new proposed version, and confirming
 * that version retires the old one.
 *
 * The four sources disagree (USD versus CAD, different numbers for similar
 * work); docs/training/CONTENT_CONFLICTS.md records why. The seed keeps each
 * as its own item with its file and line, so the catalogue screen can show CC
 * exactly where a number came from instead of picking one silently.
 *
 * PURE: the catalogue screen validates drafts with the same code as the server.
 */
import {
  CATALOGUE_CATEGORIES,
  CATALOGUE_UNITS,
  CURRENCIES,
  isOneOf,
  type CatalogueCategory,
  type CatalogueStatus,
  type CatalogueUnit,
  type Currency,
} from "@/lib/ai-audit/rules";

export type CatalogueSourceRef = { file: string; line?: number; note?: string };

export type CatalogueDraft = {
  sku: string;
  name: string;
  description: string;
  category: CatalogueCategory;
  unit: CatalogueUnit;
  unit_label?: string;
  /** null: no price proposed yet. Such an item can never be confirmed. */
  price_cents: number | null;
  currency: Currency;
  deliverables: string[];
  onboarding_requirements: string[];
  source_ref: CatalogueSourceRef;
};

export type CatalogueItem = CatalogueDraft & {
  id: string;
  tenant_id: string;
  item_version: number;
  status: CatalogueStatus;
  is_fixture: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  retired_by: string | null;
  retired_at: string | null;
};

const SKU_RE = /^[a-z][a-z0-9-]{1,47}$/;
export const PRICE_MAX_CENTS = 100_000_000; // $1,000,000: anything above is a typo, not a quote.

const COMMON_ACCESS = [
  "Owner contact for decisions during the build",
  "Access to the systems this connects, granted through Connections (never by sharing a password)",
];

/** The seed, from the files that held prices on 2026-10-25. Every item is proposed. */
export const CATALOGUE_SEED: readonly CatalogueDraft[] = [
  // content/offers/oasis/fleet.json, "One audit, then only what pays back" (USD).
  {
    sku: "fleet-custom-integration",
    name: "Custom integration",
    description: "Connect the software the business already runs and retire the manual re-keying between it.",
    category: "implementation",
    unit: "fixed",
    price_cents: 500_000,
    currency: "USD",
    deliverables: ["Integration between the named systems", "Testing on the client's real data", "Handover notes"],
    onboarding_requirements: COMMON_ACCESS,
    source_ref: { file: "content/offers/oasis/fleet.json", line: 241, note: "Offer page tier, 'one-time build'." },
  },
  {
    sku: "fleet-agent-fleet",
    name: "Agent fleet",
    description: "A command center plus the first production agent seat.",
    category: "implementation",
    unit: "fixed",
    price_cents: 750_000,
    currency: "USD",
    deliverables: ["Command center set up for the business", "First production agent", "Owner training session"],
    onboarding_requirements: COMMON_ACCESS,
    source_ref: { file: "content/offers/oasis/fleet.json", line: 252, note: "Same work is CA$7,500 'Foundation' in lib/checkout/catalog.ts." },
  },
  {
    sku: "fleet-enterprise-fleet",
    name: "Enterprise fleet",
    description: "A coordinated roster of agents across teams or locations. Larger fleets are scoped by proposal.",
    category: "implementation",
    unit: "fixed",
    price_cents: 1_500_000,
    currency: "USD",
    deliverables: ["Agents across the named teams or locations", "Shared context and controls", "Rollout plan"],
    onboarding_requirements: COMMON_ACCESS,
    source_ref: { file: "content/offers/oasis/fleet.json", line: 265, note: "Same work is CA$15,000 'Enterprise' in lib/checkout/catalog.ts." },
  },
  {
    sku: "fleet-ai-security-audit",
    name: "AI and security audit (paid, enterprise)",
    description: "A paid statement of work and roadmap for larger organisations, credited in full to the build.",
    category: "implementation",
    unit: "fixed",
    price_cents: 250_000,
    currency: "USD",
    deliverables: ["Statement of work", "Roadmap"],
    onboarding_requirements: [],
    source_ref: { file: "content/offers/oasis/fleet.json", line: 228, note: "Not the Free AI Audit. Retire it if the free audit replaces it." },
  },
  // content/offers/oasis/command.json, "Set up for you, or by you" (USD).
  {
    sku: "command-os-diy",
    name: "Command Center, do it yourself",
    description: "The Command Center, provisioned for the business. The client configures it.",
    category: "monthly",
    unit: "per_month",
    price_cents: 49_700,
    currency: "USD",
    deliverables: ["Command Center provisioned for the business"],
    onboarding_requirements: [],
    source_ref: { file: "content/offers/oasis/command.json", line: 196, note: "'a month, no setup fee'." },
  },
  {
    sku: "command-os-turnkey-setup",
    name: "Command Center turnkey setup",
    description: "OASIS configures the Command Center around how the business already runs.",
    category: "implementation",
    unit: "fixed",
    price_cents: 250_000,
    currency: "USD",
    deliverables: ["Configuration around the current process", "One onboarding vault for logins, documents and channels"],
    onboarding_requirements: ["Complete the onboarding vault (setup starts when it is complete)", ...COMMON_ACCESS],
    source_ref: { file: "content/offers/oasis/command.json", line: 208, note: "'$2,500 setup', or two payments of $1,400." },
  },
  {
    sku: "command-os-turnkey-monthly",
    name: "Command Center turnkey, monthly",
    description: "The turnkey Command Center subscription.",
    category: "monthly",
    unit: "per_month",
    price_cents: 99_700,
    currency: "USD",
    deliverables: ["Command Center subscription"],
    onboarding_requirements: [],
    source_ref: { file: "content/offers/oasis/command.json", line: 207 },
  },
  {
    sku: "command-managed-setup",
    name: "Managed operating partner setup",
    description: "Setup for established businesses where a dedicated team runs the system with the owner.",
    category: "implementation",
    unit: "fixed",
    price_cents: 500_000,
    currency: "USD",
    deliverables: ["Everything in turnkey setup", "Dedicated operations set up"],
    onboarding_requirements: COMMON_ACCESS,
    source_ref: { file: "content/offers/oasis/command.json", line: 221, note: "'a month + $5,000 setup'." },
  },
  {
    sku: "command-managed-monthly",
    name: "Managed operating partner, monthly",
    description: "A dedicated team runs the system with the owner, with a weekly audit of what ran and what stalled.",
    category: "monthly",
    unit: "per_month",
    price_cents: 300_000,
    currency: "USD",
    deliverables: ["Dedicated fleet operations", "Weekly audit of what ran and what stalled"],
    onboarding_requirements: [],
    source_ref: { file: "content/offers/oasis/command.json", line: 220 },
  },
  // lib/checkout/catalog.ts CHECKOUT_OFFERS (CAD, public checkout).
  {
    sku: "checkout-conversion-sprint-focused",
    name: "Conversion audit and optimisation sprint, focused",
    description: "One conversion path and a prioritised repair plan.",
    category: "implementation",
    unit: "fixed",
    price_cents: 150_000,
    currency: "CAD",
    deliverables: ["One conversion path reviewed", "Prioritised repair plan"],
    onboarding_requirements: COMMON_ACCESS,
    source_ref: { file: "lib/checkout/catalog.ts", line: 35 },
  },
  {
    sku: "checkout-conversion-sprint-growth",
    name: "Conversion audit and optimisation sprint, growth",
    description: "Two conversion paths plus implementation support.",
    category: "implementation",
    unit: "fixed",
    price_cents: 200_000,
    currency: "CAD",
    deliverables: ["Two conversion paths reviewed", "Implementation support"],
    onboarding_requirements: COMMON_ACCESS,
    source_ref: { file: "lib/checkout/catalog.ts", line: 36 },
  },
  {
    sku: "checkout-conversion-sprint-intensive",
    name: "Conversion audit and optimisation sprint, intensive",
    description: "Full-funnel review, fixes, and measurement handoff.",
    category: "implementation",
    unit: "fixed",
    price_cents: 250_000,
    currency: "CAD",
    deliverables: ["Full-funnel review", "Fixes", "Measurement handoff"],
    onboarding_requirements: COMMON_ACCESS,
    source_ref: { file: "lib/checkout/catalog.ts", line: 37 },
  },
  {
    sku: "checkout-sales-setter-launch",
    name: "AI sales setter and speed-to-lead, launch",
    description: "One lead source, qualification, and booking workflow.",
    category: "implementation",
    unit: "fixed",
    price_cents: 350_000,
    currency: "CAD",
    deliverables: ["One lead source connected", "Qualification and booking workflow"],
    onboarding_requirements: ["Calendar connected through Connections", ...COMMON_ACCESS],
    source_ref: { file: "lib/checkout/catalog.ts", line: 49 },
  },
  {
    sku: "checkout-sales-setter-scale",
    name: "AI sales setter and speed-to-lead, scale",
    description: "Multi-source intake with follow-up and CRM routing.",
    category: "implementation",
    unit: "fixed",
    price_cents: 425_000,
    currency: "CAD",
    deliverables: ["Several lead sources connected", "Follow-up and CRM routing"],
    onboarding_requirements: ["Calendar and CRM connected through Connections", ...COMMON_ACCESS],
    source_ref: { file: "lib/checkout/catalog.ts", line: 50 },
  },
  {
    sku: "checkout-sales-setter-complete",
    name: "AI sales setter and speed-to-lead, complete",
    description: "End-to-end setter system with reporting and tuning.",
    category: "implementation",
    unit: "fixed",
    price_cents: 500_000,
    currency: "CAD",
    deliverables: ["End-to-end setter system", "Reporting and tuning"],
    onboarding_requirements: ["Calendar and CRM connected through Connections", ...COMMON_ACCESS],
    source_ref: { file: "lib/checkout/catalog.ts", line: 51 },
  },
  // lib/website-sales.ts WEBSITE_PACKAGES floors (the deal's currency, CAD by
  // default) and lib/website-sales-comp.ts PRICE_BOOK book prices.
  {
    sku: "website-starter",
    name: "Website, Starter",
    description: "A conversion-first website, Starter package.",
    category: "website",
    unit: "fixed",
    price_cents: 50_000,
    currency: "CAD",
    deliverables: ["Starter website"],
    onboarding_requirements: ["Logo, photos and service list", "Domain access through Connections"],
    source_ref: { file: "lib/website-sales.ts", line: 71, note: "Setup floor $500, monthly floor $150; book price $500 (lib/website-sales-comp.ts:166)." },
  },
  {
    sku: "website-essential",
    name: "Website, Essential",
    description: "A conversion-first website, Essential package.",
    category: "website",
    unit: "fixed",
    price_cents: 300_000,
    currency: "CAD",
    deliverables: ["Essential website"],
    onboarding_requirements: ["Logo, photos and service list", "Domain access through Connections"],
    source_ref: { file: "lib/website-sales-comp.ts", line: 167, note: "Book price $3,000; floor $2,000 (lib/website-sales.ts:75); monthly floor $250." },
  },
  {
    sku: "website-growth",
    name: "Website, Growth",
    description: "A conversion-first website with booking or review integration and one standard automation.",
    category: "website",
    unit: "fixed",
    price_cents: 500_000,
    currency: "CAD",
    deliverables: ["Growth website", "Booking or review integration", "One standard automation"],
    onboarding_requirements: ["Logo, photos and service list", "Domain access through Connections"],
    source_ref: { file: "lib/website-sales-comp.ts", line: 168, note: "Book price $5,000; floor $3,500 (lib/website-sales.ts:79); monthly floor $350." },
  },
  {
    sku: "website-authority",
    name: "Website, Authority",
    description: "A conversion-first website with advanced SEO, custom integrations and two standard automations.",
    category: "website",
    unit: "fixed",
    price_cents: 800_000,
    currency: "CAD",
    deliverables: ["Authority website", "Advanced SEO", "Two standard automations"],
    onboarding_requirements: ["Logo, photos and service list", "Domain access through Connections"],
    source_ref: { file: "lib/website-sales-comp.ts", line: 169, note: "Book price $8,000; floor $5,000 (lib/website-sales.ts:83); monthly floor $500." },
  },
];

/** The fixture-only item the permanent test prospect is priced with. Never shown to a real proposal. */
export const FIXTURE_CATALOGUE_ITEM: CatalogueDraft = {
  sku: "fixture-canary-item",
  name: "[TEST] Canary implementation",
  description: "Fixture item for the permanent test prospect. Not for sale.",
  category: "implementation",
  unit: "fixed",
  price_cents: 100,
  currency: "CAD",
  deliverables: ["Nothing: test fixture"],
  onboarding_requirements: ["Test checklist item"],
  source_ref: { file: "lib/ai-audit/catalogue.ts", note: "Fixture for the ten-check acceptance run." },
};

type V<T> = { ok: true; value: T } | { ok: false; field: string; error: string };

function text(v: unknown, field: string, max: number, required = true): V<string> {
  if (v === undefined || v === null || v === "") return required ? { ok: false, field, error: "required" } : { ok: true, value: "" };
  if (typeof v !== "string") return { ok: false, field, error: "must be text" };
  const s = v.trim();
  if (required && !s) return { ok: false, field, error: "required" };
  if (s.length > max) return { ok: false, field, error: `longer than ${max} characters` };
  return { ok: true, value: s };
}

function lines(v: unknown, field: string): V<string[]> {
  if (v === undefined || v === null) return { ok: true, value: [] };
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : null;
  if (!raw) return { ok: false, field, error: "must be a list" };
  const out = raw.map((x) => String(x ?? "").trim()).filter(Boolean);
  if (out.length > 20) return { ok: false, field, error: "more than 20 lines" };
  if (out.some((x) => x.length > 300)) return { ok: false, field, error: "a line is longer than 300 characters" };
  return { ok: true, value: out };
}

/** A catalogue draft from the browser (a new proposed version). */
export function validateCatalogueDraft(raw: unknown): V<CatalogueDraft> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, field: "", error: "not an item" };
  const r = raw as Record<string, unknown>;
  const sku = typeof r.sku === "string" ? r.sku.trim().toLowerCase() : "";
  if (!SKU_RE.test(sku)) return { ok: false, field: "sku", error: "use 2-48 lowercase letters, digits and dashes" };
  const name = text(r.name, "name", 120);
  if (!name.ok) return name;
  const description = text(r.description, "description", 1_000, false);
  if (!description.ok) return description;
  if (!isOneOf(CATALOGUE_CATEGORIES, r.category)) return { ok: false, field: "category", error: "unknown category" };
  if (!isOneOf(CATALOGUE_UNITS, r.unit)) return { ok: false, field: "unit", error: "unknown unit" };
  if (r.category === "monthly" && r.unit !== "per_month") return { ok: false, field: "unit", error: "a monthly item is priced per month" };
  if (r.category !== "monthly" && r.unit === "per_month") return { ok: false, field: "unit", error: "only a monthly item is priced per month" };
  const unitLabel = text(r.unit_label, "unit_label", 40, false);
  if (!unitLabel.ok) return unitLabel;
  if (r.unit === "per_unit" && !unitLabel.value) return { ok: false, field: "unit_label", error: "say what one unit is (for example 'integration')" };
  let price: number | null = null;
  if (r.price_cents !== null && r.price_cents !== undefined && r.price_cents !== "") {
    const n = Number(r.price_cents);
    if (!Number.isSafeInteger(n) || n <= 0 || n > PRICE_MAX_CENTS) return { ok: false, field: "price_cents", error: "must be a whole number of cents above zero" };
    price = n;
  }
  if (!isOneOf(CURRENCIES, r.currency)) return { ok: false, field: "currency", error: "CAD or USD" };
  const deliverables = lines(r.deliverables, "deliverables");
  if (!deliverables.ok) return deliverables;
  const requirements = lines(r.onboarding_requirements, "onboarding_requirements");
  if (!requirements.ok) return requirements;
  const ref = r.source_ref && typeof r.source_ref === "object" && !Array.isArray(r.source_ref) ? (r.source_ref as Record<string, unknown>) : {};
  const file = text(ref.file, "source_ref.file", 200, false);
  if (!file.ok) return file;
  const note = text(ref.note, "source_ref.note", 500, false);
  if (!note.ok) return note;
  const line = Number.isSafeInteger(ref.line) && Number(ref.line) > 0 ? Number(ref.line) : undefined;
  return {
    ok: true,
    value: {
      sku,
      name: name.value,
      description: description.value,
      category: r.category,
      unit: r.unit,
      ...(unitLabel.value ? { unit_label: unitLabel.value } : {}),
      price_cents: price,
      currency: r.currency,
      deliverables: deliverables.value,
      onboarding_requirements: requirements.value,
      source_ref: { file: file.value || "entered by the owner", ...(line ? { line } : {}), ...(note.value ? { note: note.value } : {}) },
    },
  };
}

/** Why an item cannot be confirmed yet, or null. */
export function confirmBlocker(item: Pick<CatalogueItem, "status" | "price_cents">): string | null {
  if (item.status !== "proposed") return `this version is already ${item.status}`;
  if (item.price_cents === null || item.price_cents <= 0) return "it has no price yet";
  return null;
}

export function formatMoney(cents: number, currency: Currency): string {
  return new Intl.NumberFormat(currency === "USD" ? "en-US" : "en-CA", { style: "currency", currency, minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}
