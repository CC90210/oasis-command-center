/**
 * lib/playbook/catalog.ts - every business document OASIS keeps, and where
 * each one's text comes from. Replaces lib/business-docs.ts (2026-09-30).
 *
 * WHY IT WAS REPLACED (audit business-docs-link-to-ai-team). The old list was
 * 21 cards that each linked to the AI Team roster, which dropped the prompt and
 * 404'd for every OASIS member who is not a founder. No document could be read,
 * copied or downloaded. Its statuses were typed literals ("drafted", "stub")
 * rather than measured, "Privacy policy" said stub while /privacy was live,
 * Terms and DMCA were missing, and its facts were wrong for OASIS: Ontario law,
 * GST/HST without QST, "Q2 2026", "$5K MRR" and a database-policy isolation
 * claim. OASIS AI Solutions is in Montreal, Quebec (GST/QST, Revenu Quebec),
 * on Turso.
 *
 * THREE KINDS OF SOURCE
 *   app_live  rendered at read time from the constants and tables the live
 *             product uses (lib/playbook/live-sources.ts). No stored body, so
 *             it cannot drift from the live copy.
 *   bundled   a Playbook markdown file (content/playbooks), compiled into the
 *             Worker (lib/playbooks.ts).
 *   stored    text in playbook_docs (bravo__194): drafted in the app from a
 *             deterministic template (lib/playbook/templates), edited and
 *             marked current by a founder, or imported from the harness once
 *             CC consents. Until then the document is Missing.
 *
 * NO STATUS HERE. A document's status is derived (lib/playbook/status.ts):
 * missing when there is no body and no live source, review due when its source
 * date plus review_every_days has passed. Never a typed literal.
 *
 * No invented facts: a fact this file does not know is not written here; the
 * templates turn it into a [[CC to confirm: ...]] placeholder, and "Mark
 * current" is refused while one remains.
 */

import type { DocOwnerPillar } from "@/lib/os/chat-href";

export type DocCategory =
  | "legal_privacy"
  | "corporate"
  | "tax_finance"
  | "sales_delivery"
  | "security"
  | "people"
  | "brand_strategy";

export type DocVisibility = "founders" | "team" | "client_safe" | "public";

export type DocKind = "policy" | "agreement" | "template" | "register" | "runbook" | "plan" | "record" | "reference";

/** Live renderers in lib/playbook/live-sources.ts. */
export type LiveSourceKey =
  | "privacy_policy"
  | "terms"
  | "dmca"
  | "subprocessors"
  | "gst_qst_status"
  | "contract_opener"
  | "contract_closer"
  | "contract_manager"
  | "contract_builder"
  | "price_book"
  | "security_model";

export type DocSource =
  | { kind: "app_live"; live: LiveSourceKey }
  | { kind: "bundled"; playbookSlug: string }
  | { kind: "stored" };

export type CatalogDoc = {
  slug: string;
  title: string;
  summary: string;
  kind: DocKind;
  category: DocCategory;
  visibility: DocVisibility;
  required: boolean;
  /** The rule that makes it required, in plain words. Null when it is good practice only. */
  requiredBy: string | null;
  owner: DocOwnerPillar;
  source: DocSource;
  reviewEveryDays: number | null;
  /** A legal document: a draft carries the "not legal advice" banner. */
  legal: boolean;
  /** What only CC can supply before this document can be current. */
  needsFromCc: string | null;
};

export const DOC_CATEGORIES: ReadonlyArray<{ key: DocCategory; label: string; blurb: string }> = [
  { key: "legal_privacy", label: "Legal and privacy", blurb: "Published policies, the Law 25 register and assessments, the client data agreement." },
  { key: "corporate", label: "Corporate", blurb: "Ownership, registration, insurance and the record of decisions." },
  { key: "tax_finance", label: "Tax and finance", blurb: "The Quebec and federal filing calendar, GST/QST, the accountant and capital policy." },
  { key: "sales_delivery", label: "Sales and delivery", blurb: "Client contracts, the offer, and how a client is sold and delivered." },
  { key: "security", label: "Security", blurb: "How client data is protected and what to do when something goes wrong." },
  { key: "people", label: "People", blurb: "Contractor agreements and how contractors are classified." },
  { key: "brand_strategy", label: "Brand and strategy", blurb: "Goals, risks, brand and the go-to-market." },
];

const YEAR = 365;
const QUARTER = 90;

const LIVE = (live: LiveSourceKey): DocSource => ({ kind: "app_live", live });
const STORED: DocSource = { kind: "stored" };

export const CATALOG: readonly CatalogDoc[] = [
  // Legal and privacy --------------------------------------------------------
  {
    slug: "privacy-policy", title: "Privacy policy", kind: "policy", category: "legal_privacy", visibility: "public",
    summary: "The policy published at /privacy: what OASIS collects, which processors receive it, and how people exercise their rights.",
    required: true, requiredBy: "Quebec private-sector privacy act (Law 25): governance published in clear terms", owner: "legal",
    source: LIVE("privacy_policy"), reviewEveryDays: YEAR, legal: true,
    needsFromCc: "A French version (Charter of the French Language) and counsel review; neither exists yet.",
  },
  {
    slug: "terms-of-service", title: "Terms of service", kind: "agreement", category: "legal_privacy", visibility: "public",
    summary: "The terms published at /terms that govern use of the Command Center.",
    required: true, requiredBy: null, owner: "legal", source: LIVE("terms"), reviewEveryDays: YEAR, legal: true,
    needsFromCc: "A French version and counsel review; neither exists yet.",
  },
  {
    slug: "dmca-policy", title: "Copyright (DMCA) policy", kind: "policy", category: "legal_privacy", visibility: "public",
    summary: "The notice-and-takedown policy published at /dmca.",
    required: true, requiredBy: "US DMCA safe harbour; Canadian notice-and-notice", owner: "legal",
    source: LIVE("dmca"), reviewEveryDays: YEAR, legal: true, needsFromCc: null,
  },
  {
    slug: "sub-processor-list", title: "Sub-processor list", kind: "reference", category: "legal_privacy", visibility: "client_safe",
    summary: "Every processor that receives personal information, what it receives, where, and whether a data processing agreement is in place.",
    required: true, requiredBy: "Law 25 s.17 (communication outside Quebec) and the client DPA annex", owner: "legal",
    source: LIVE("subprocessors"), reviewEveryDays: QUARTER, legal: false,
    needsFromCc: "Accept the DPA in each processor account the list marks as not in place.",
  },
  {
    slug: "law25-incident-register", title: "Law 25 incident register", kind: "register", category: "legal_privacy", visibility: "founders",
    summary: "The register of every confidentiality incident, kept whether or not it had to be reported, and how incidents are assessed and notified.",
    required: true, requiredBy: "Law 25 s.3.8 (register of confidentiality incidents)", owner: "legal",
    source: STORED, reviewEveryDays: YEAR, legal: true, needsFromCc: null,
  },
  {
    slug: "privacy-impact-assessments", title: "Privacy impact assessments (per processor)", kind: "record", category: "legal_privacy", visibility: "founders",
    summary: "One assessment for each processor outside Quebec that receives personal information, before it receives it.",
    required: true, requiredBy: "Law 25 s.17 (communication outside Quebec) and s.3.3 (information system projects)", owner: "legal",
    source: STORED, reviewEveryDays: YEAR, legal: true, needsFromCc: "The contractual protections each processor actually offers.",
  },
  {
    slug: "privacy-governance-policy", title: "Privacy governance and retention policy", kind: "policy", category: "legal_privacy", visibility: "team",
    summary: "Who is responsible for personal information, how long each kind is kept, how it is destroyed, and how requests and complaints are handled.",
    required: true, requiredBy: "Law 25 s.3.2 (governance policies)", owner: "legal",
    source: STORED, reviewEveryDays: YEAR, legal: true, needsFromCc: null,
  },
  {
    slug: "client-dpa", title: "Client data processing agreement", kind: "template", category: "legal_privacy", visibility: "founders",
    summary: "The agreement a client signs when OASIS processes their customers' personal information, with the s.17 assessment annex.",
    required: true, requiredBy: "Law 25: a service provider's mandate must be in writing; s.17 for processing outside Quebec", owner: "legal",
    source: STORED, reviewEveryDays: YEAR, legal: true, needsFromCc: "Counsel review before any client signs it.",
  },

  // Corporate -----------------------------------------------------------------
  {
    slug: "founders-agreement", title: "Founders' agreement", kind: "agreement", category: "corporate", visibility: "founders",
    summary: "How CC and Adon own and run OASIS AI Solutions: ownership split, decisions, vesting, exit and disputes.",
    required: true, requiredBy: null, owner: "ceo", source: STORED, reviewEveryDays: YEAR, legal: true,
    needsFromCc: "The ownership split (you said 50/50 on 2026-08-24; both Drive drafts say 60/40 and Ontario), Adon's full legal name, and the governing law.",
  },
  {
    slug: "enterprise-registration", title: "Enterprise registration (NEQ)", kind: "record", category: "corporate", visibility: "founders",
    summary: "Whether OASIS AI Solutions is registered with the Registraire des entreprises du Quebec, its NEQ, and when the annual update is due.",
    required: true, requiredBy: "Quebec: Act respecting the legal publicity of enterprises", owner: "ceo",
    source: STORED, reviewEveryDays: YEAR, legal: true, needsFromCc: "Is the business registered, and under which form (partnership or incorporation)?",
  },
  {
    slug: "ip-assignment", title: "IP assignment to OASIS", kind: "agreement", category: "corporate", visibility: "founders",
    summary: "The founders assign what they build for OASIS (code, prompts, content) to the business.",
    required: true, requiredBy: null, owner: "legal", source: STORED, reviewEveryDays: YEAR, legal: true,
    needsFromCc: "Which entity receives the IP until the business is incorporated.",
  },
  {
    slug: "insurance", title: "E&O and cyber insurance", kind: "record", category: "corporate", visibility: "founders",
    summary: "Professional liability (errors and omissions) and cyber coverage: insurer, limits, renewal date.",
    required: false, requiredBy: null, owner: "cfo", source: STORED, reviewEveryDays: YEAR, legal: false,
    needsFromCc: "Whether any policy exists today.",
  },
  {
    slug: "dmca-agent-registration", title: "DMCA agent registration", kind: "record", category: "corporate", visibility: "founders",
    summary: "The designated copyright agent filed with the US Copyright Office, which the /dmca page relies on.",
    required: true, requiredBy: "US DMCA s.512(c)(2) designated agent", owner: "legal", source: STORED, reviewEveryDays: YEAR * 3, legal: true,
    needsFromCc: "A street address, a phone number and the filing fee.",
  },
  {
    slug: "decisions-log", title: "Decisions log", kind: "record", category: "corporate", visibility: "founders",
    summary: "The big calls, the options considered and why, so they can be audited later.",
    required: false, requiredBy: null, owner: "ceo", source: STORED, reviewEveryDays: QUARTER, legal: false, needsFromCc: null,
  },
  {
    slug: "org-chart", title: "Org chart and decision rights", kind: "reference", category: "corporate", visibility: "team",
    summary: "Who owns what, human and department, and who decides the recurring calls.",
    required: false, requiredBy: null, owner: "ceo", source: STORED, reviewEveryDays: QUARTER, legal: false, needsFromCc: null,
  },

  // Tax and finance -------------------------------------------------------------
  {
    slug: "quebec-tax-calendar", title: "Tax calendar (Quebec and federal)", kind: "plan", category: "tax_finance", visibility: "founders",
    summary: "Every filing and payment date for the founders and the business: TP-1 with TP-80, T1 with T2125 per partner, instalments, and GST/QST once registered.",
    required: true, requiredBy: "Revenu Quebec and CRA filing obligations", owner: "cfo",
    source: STORED, reviewEveryDays: QUARTER, legal: false, needsFromCc: "Confirm the filing position with the accountant.",
  },
  {
    slug: "gst-qst-registration", title: "GST/QST registration status", kind: "record", category: "tax_finance", visibility: "founders",
    summary: "Whether the business is registered for GST and QST, its numbers and effective date, as recorded in Finances settings.",
    required: true, requiredBy: "GST/QST small-supplier rule", owner: "cfo",
    source: LIVE("gst_qst_status"), reviewEveryDays: QUARTER, legal: false, needsFromCc: null,
  },
  {
    slug: "accountant-engagement", title: "Accountant engagement", kind: "agreement", category: "tax_finance", visibility: "founders",
    summary: "Who the accountant is, what they file, and what they need from OASIS each year.",
    required: false, requiredBy: null, owner: "cfo", source: STORED, reviewEveryDays: YEAR, legal: false,
    needsFromCc: "The accountant's name, or that none is engaged yet.",
  },
  {
    slug: "capital-allocation-policy", title: "Capital allocation policy", kind: "policy", category: "tax_finance", visibility: "founders",
    summary: "Where each dollar of profit goes: tax reserve, operating reserve, reinvestment and owner draws.",
    required: false, requiredBy: null, owner: "cfo", source: STORED, reviewEveryDays: QUARTER, legal: false, needsFromCc: null,
  },

  // Sales and delivery ----------------------------------------------------------
  {
    slug: "msa-template", title: "Master services agreement (template)", kind: "template", category: "sales_delivery", visibility: "founders",
    summary: "The agreement OASIS signs with a client: services, fees, IP, confidentiality, liability and termination, under Quebec law.",
    required: true, requiredBy: null, owner: "legal", source: STORED, reviewEveryDays: YEAR, legal: true,
    needsFromCc: "Counsel review, and whether the 2026-06-21 Drive MSA is the current base.",
  },
  {
    slug: "mutual-nda", title: "Mutual NDA (template)", kind: "template", category: "sales_delivery", visibility: "founders",
    summary: "A two-way confidentiality agreement for discovery calls and partner talks.",
    required: false, requiredBy: null, owner: "legal", source: STORED, reviewEveryDays: YEAR, legal: true, needsFromCc: null,
  },
  {
    slug: "price-book", title: "Website offer and price book", kind: "reference", category: "sales_delivery", visibility: "team",
    summary: "The website packages, their floors and the approved automation add-ons, as the quote validator enforces them.",
    required: true, requiredBy: null, owner: "ops", source: LIVE("price_book"), reviewEveryDays: QUARTER, legal: false, needsFromCc: null,
  },
  {
    slug: "client-onboarding-sop", title: "Client onboarding SOP", kind: "runbook", category: "sales_delivery", visibility: "team",
    summary: "How a signed client's workspace is stood up, what is shared, what is per client, and what not to promise.",
    required: true, requiredBy: null, owner: "ops", source: { kind: "bundled", playbookSlug: "07-new-client-onboarding" }, reviewEveryDays: QUARTER, legal: false, needsFromCc: null,
  },
  {
    slug: "oasis-loop", title: "The OASIS Loop", kind: "runbook", category: "sales_delivery", visibility: "team",
    summary: "The closed-loop method for getting production-grade output from an AI system: prime, translate, execute, reflect.",
    required: false, requiredBy: null, owner: "ops", source: { kind: "bundled", playbookSlug: "10-oasis-loop" }, reviewEveryDays: YEAR, legal: false, needsFromCc: null,
  },
  {
    slug: "sales-enablement-guide", title: "Sales enablement guide", kind: "runbook", category: "sales_delivery", visibility: "team",
    summary: "What a rep needs to sell the website offer: the offer, qualification, objections, booking and the founder handoff.",
    required: false, requiredBy: null, owner: "cmo", source: STORED, reviewEveryDays: QUARTER, legal: false, needsFromCc: null,
  },
  {
    slug: "delivery-checklist", title: "Delivery checklist and QA gate", kind: "runbook", category: "sales_delivery", visibility: "team",
    summary: "What ships at each stage of a build, and the checks nothing passes without.",
    required: false, requiredBy: null, owner: "ops", source: STORED, reviewEveryDays: QUARTER, legal: false, needsFromCc: null,
  },

  // Security ----------------------------------------------------------------------
  {
    slug: "security-model", title: "Security model", kind: "reference", category: "security", visibility: "team",
    summary: "How workspaces are kept apart, how secrets are stored and how the desktop bridge authenticates, in words you may repeat to a client.",
    required: true, requiredBy: null, owner: "ops", source: LIVE("security_model"), reviewEveryDays: QUARTER, legal: false, needsFromCc: null,
  },
  {
    slug: "incident-response-runbook", title: "Incident response runbook", kind: "runbook", category: "security", visibility: "team",
    summary: "When something breaks or data may be exposed: who triages, who talks to the client, how a confidentiality incident is assessed and recorded.",
    required: true, requiredBy: "Law 25 (confidentiality incidents)", owner: "ops", source: STORED, reviewEveryDays: YEAR, legal: false, needsFromCc: null,
  },
  {
    slug: "vendor-registry", title: "Vendor and tool registry", kind: "reference", category: "security", visibility: "founders",
    summary: "Every paid tool, what it does for OASIS, who pays for it, and what breaks if it disappears.",
    required: false, requiredBy: null, owner: "ops", source: STORED, reviewEveryDays: QUARTER, legal: false,
    needsFromCc: "Which card or account pays each recurring cost.",
  },

  // People ----------------------------------------------------------------------------
  {
    slug: "contractor-agreement-opener", title: "Contractor agreement: opener", kind: "template", category: "people", visibility: "team",
    summary: "The appointment-setter agreement, every rate read from the payout engine.",
    required: true, requiredBy: null, owner: "legal", source: LIVE("contract_opener"), reviewEveryDays: YEAR, legal: true, needsFromCc: null,
  },
  {
    slug: "contractor-agreement-closer", title: "Contractor agreement: closer", kind: "template", category: "people", visibility: "team",
    summary: "The closer agreement, every rate read from the payout engine.",
    required: true, requiredBy: null, owner: "legal", source: LIVE("contract_closer"), reviewEveryDays: YEAR, legal: true, needsFromCc: null,
  },
  {
    slug: "contractor-agreement-manager", title: "Contractor agreement: sales manager", kind: "template", category: "people", visibility: "team",
    summary: "The sales manager agreement, override and personal production read from the payout engine.",
    required: true, requiredBy: null, owner: "legal", source: LIVE("contract_manager"), reviewEveryDays: YEAR, legal: true, needsFromCc: null,
  },
  {
    slug: "contractor-agreement-builder", title: "Contractor agreement: builder", kind: "template", category: "people", visibility: "team",
    summary: "The delivery builder agreement, fees per build read from the price book.",
    required: true, requiredBy: null, owner: "legal", source: LIVE("contract_builder"), reviewEveryDays: YEAR, legal: true, needsFromCc: null,
  },
  {
    slug: "contractor-agreement-marketing", title: "Contractor agreement: marketing", kind: "template", category: "people", visibility: "founders",
    summary: "The marketing contractor agreement. It has no pay terms until CC sets them; the generator refuses to invent a rate.",
    required: false, requiredBy: null, owner: "legal", source: STORED, reviewEveryDays: YEAR, legal: true,
    needsFromCc: "How a marketing contractor is paid: retainer, per campaign, salary or day rate.",
  },
  {
    slug: "contractor-classification-memo", title: "Contractor classification memo", kind: "record", category: "people", visibility: "founders",
    summary: "Why each role is an independent contractor and not an employee, under Revenu Quebec and CRA tests.",
    required: true, requiredBy: "Revenu Quebec and CRA worker-status tests", owner: "cfo", source: STORED, reviewEveryDays: YEAR, legal: true,
    needsFromCc: "The accountant's view of the contractor-for-all decision (2026-08-20).",
  },

  // Brand and strategy ----------------------------------------------------------------
  {
    slug: "okrs", title: "Quarterly goals (OKRs)", kind: "plan", category: "brand_strategy", visibility: "founders",
    summary: "This quarter's objectives and measurable key results, anchored on the active revenue goal.",
    required: false, requiredBy: null, owner: "ceo", source: STORED, reviewEveryDays: QUARTER, legal: false, needsFromCc: null,
  },
  {
    slug: "risk-register", title: "Risk register", kind: "record", category: "brand_strategy", visibility: "founders",
    summary: "The risks to the business, their likelihood and impact, the owner and the mitigation.",
    required: false, requiredBy: null, owner: "ceo", source: STORED, reviewEveryDays: QUARTER, legal: false, needsFromCc: null,
  },
  {
    slug: "brand-system", title: "Brand system", kind: "reference", category: "brand_strategy", visibility: "team",
    summary: "Voice, vocabulary, visual identity and what OASIS never says.",
    required: false, requiredBy: null, owner: "cmo", source: STORED, reviewEveryDays: YEAR, legal: false, needsFromCc: null,
  },
  {
    slug: "buyer-profile", title: "Buyer profile (ICP)", kind: "reference", category: "brand_strategy", visibility: "team",
    summary: "Who buys OASIS, why they buy, what stops them, and where they are found.",
    required: false, requiredBy: null, owner: "cmo", source: STORED, reviewEveryDays: QUARTER, legal: false, needsFromCc: null,
  },
  {
    slug: "content-pillars", title: "Content pillars", kind: "plan", category: "brand_strategy", visibility: "team",
    summary: "The themes every post belongs to, by platform and cadence.",
    required: false, requiredBy: null, owner: "cmo", source: STORED, reviewEveryDays: QUARTER, legal: false, needsFromCc: null,
  },
  {
    slug: "funnel-map", title: "Funnel map", kind: "plan", category: "brand_strategy", visibility: "team",
    summary: "How a lead arrives, is nurtured and books a call, with the measured conversion at each stage.",
    required: false, requiredBy: null, owner: "cmo", source: STORED, reviewEveryDays: QUARTER, legal: false, needsFromCc: null,
  },
];

const BY_SLUG = new Map(CATALOG.map((d) => [d.slug, d]));

export function catalogDoc(slug: string | null | undefined): CatalogDoc | null {
  return BY_SLUG.get((slug || "").trim().toLowerCase()) ?? null;
}

export function categoryLabel(key: DocCategory): string {
  return DOC_CATEGORIES.find((c) => c.key === key)?.label ?? key;
}

/** What "Ask <department>" hands the department, built from the row's own facts. */
export function askPromptFor(doc: CatalogDoc): string {
  const need = doc.needsFromCc ? ` Still needed from CC: ${doc.needsFromCc}` : "";
  return (
    `Help me with OASIS AI Solutions' "${doc.title}" (Playbook > Business documentation). ` +
    `It covers: ${doc.summary}${need} ` +
    "OASIS is in Montreal, Quebec. Use only facts I confirm or that are in the document; " +
    "write [[CC to confirm: ...]] for anything you do not know, and never invent a name, email, amount, date or legal rule."
  );
}
