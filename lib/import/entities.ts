/**
 * Import-entity registry.
 *
 * All importable entities land in `tenant_records` with their
 * `entity_type` discriminating the kind (lead / lender / application /
 * funded_deal). The registry centralizes:
 *
 *   - Which entity_type a row gets stored as
 *   - The set of canonical fields the importer extracts
 *   - The column-mapping rules (normalized CSV header → canonical field)
 *   - Per-entity dedup keys + sample CSV + UI label
 *
 * Add a new entity by appending a definition here. The API route at
 * /api/import/[entity] and the ImportWizard UI both consume this same
 * registry — no other file changes required.
 */

export type DedupStrategy = "email" | "phone" | "business" | "name" | "lender_name";

export type EntityDefinition = {
  /** URL slug used as the [entity] segment in /api/import/[entity]. */
  key: string;
  /** Display name in the picker / wizard headers. */
  label: string;
  /** One-line UX hint shown next to the entity in the picker. */
  description: string;
  /** Lucide icon name — picker uses to render a glyph. */
  icon: "user" | "building-2" | "file-text" | "trophy" | "users";
  /** Value written to tenant_records.entity_type. */
  entity_type: string;
  /** Default dedup keys; UI exposes toggles for each. */
  defaultDedupBy: DedupStrategy[];
  /** Canonical fields the import recognises. Order = UI preview column order. */
  canonicalFields: ReadonlyArray<{
    key: string;
    label: string;
    /** "required" = malformed row if missing; "optional" = OK if absent. */
    requirement: "required" | "one-of-required" | "optional";
    /** When parsing, run the value through this normalizer. */
    type: "text" | "email" | "phone" | "money" | "url" | "date" | "tag-list" | "json";
    /** Max length for text fields. Ignored for non-text. */
    maxLen?: number;
  }>;
  /**
   * Header→canonical-field mapping. Keys are normalized headers
   * (lowercase, alphanumeric only — see normalizeHeader()).
   */
  headerAliases: Readonly<Record<string, string>>;
  /** First row of the inline sample CSV (with realistic data). */
  sampleCsv: string;
};

/** Lowercase + strip non-alphanumeric to give a stable header lookup key. */
export function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// ============================================================================
// LEADS — basic CRM contact + qualification data
// ============================================================================
const LEADS: EntityDefinition = {
  key: "leads",
  label: "Leads",
  description: "Inbound prospects you want to qualify and route through the pipeline.",
  icon: "user",
  entity_type: "lead",
  defaultDedupBy: ["email", "phone", "business"],
  canonicalFields: [
    { key: "name", label: "Name", requirement: "one-of-required", type: "text", maxLen: 200 },
    { key: "business_name", label: "Business", requirement: "one-of-required", type: "text", maxLen: 200 },
    { key: "email", label: "Email", requirement: "one-of-required", type: "email" },
    { key: "phone", label: "Phone", requirement: "one-of-required", type: "phone" },
    { key: "contact_name", label: "Contact name", requirement: "optional", type: "text", maxLen: 200 },
    { key: "source", label: "Source", requirement: "optional", type: "text", maxLen: 64 },
    { key: "stage", label: "Stage", requirement: "optional", type: "text", maxLen: 80 },
    { key: "state", label: "State", requirement: "optional", type: "text", maxLen: 80 },
    { key: "monthly_revenue", label: "Monthly revenue", requirement: "optional", type: "money" },
    { key: "notes", label: "Notes", requirement: "optional", type: "text", maxLen: 2000 },
    { key: "tags", label: "Tags", requirement: "optional", type: "tag-list" },
  ],
  headerAliases: {
    name: "name", fullname: "name",
    business: "business_name", businessname: "business_name", legal: "business_name",
    legalname: "business_name", legalbusinessname: "business_name", company: "business_name",
    companyname: "business_name", dba: "business_name",
    contact: "contact_name", contactname: "contact_name", owner: "contact_name",
    ownername: "contact_name", merchant: "contact_name", signer: "contact_name",
    primarycontact: "contact_name",
    email: "email", emailaddress: "email", eaddress: "email",
    phone: "phone", phonenumber: "phone", businessphone: "phone", cell: "phone",
    mobile: "phone", tel: "phone",
    source: "source", leadsource: "source", channel: "source",
    stage: "stage", pipelinestage: "stage", leadstage: "stage", phase: "stage", status: "stage",
    state: "state", region: "state", province: "state",
    monthlyrevenue: "monthly_revenue", mrr: "monthly_revenue", revenue: "monthly_revenue",
    notes: "notes", note: "notes", comment: "notes", comments: "notes",
    tags: "tags", labels: "tags",
  },
  sampleCsv:
    "Business Name,Owner,Email,Phone,State,Monthly Revenue,Stage,Source,Notes\n" +
    "Velocity Logistics LLC,Carlos Mejia,carlos@velocity-log.com,(214) 555-0118,TX,48000,Hot Lead,linkedin_outreach,Roofing co - 18 months\n" +
    "Reyes Motors,Mike Reyes,mike@reyesmotors.net,(727) 555-9911,FL,72000,Missing Info,referral,Used cars dealer\n",
};

// ============================================================================
// LENDERS — funding source registry for the shop-out workflow
// ============================================================================
const LENDERS: EntityDefinition = {
  key: "lenders",
  label: "Lenders",
  description: "Funders you shop deals out to. Powers the Lenders directory + shop-out filter.",
  icon: "building-2",
  entity_type: "lender",
  defaultDedupBy: ["lender_name"],
  canonicalFields: [
    { key: "lender_name", label: "Lender name", requirement: "required", type: "text", maxLen: 200 },
    { key: "tier", label: "Tier", requirement: "optional", type: "text", maxLen: 16 },
    { key: "paper_grades", label: "Paper grades (A/B/C)", requirement: "optional", type: "tag-list" },
    { key: "position_min", label: "Min position", requirement: "optional", type: "money" },
    { key: "position_max", label: "Max position", requirement: "optional", type: "money" },
    { key: "max_negative_days", label: "Max neg days", requirement: "optional", type: "money" },
    { key: "reverses_only", label: "Reverses only?", requirement: "optional", type: "text", maxLen: 16 },
    { key: "defaults_policy", label: "Defaults policy", requirement: "optional", type: "text", maxLen: 240 },
    { key: "contact_email", label: "Submission email", requirement: "optional", type: "email" },
    { key: "contact_phone", label: "Contact phone", requirement: "optional", type: "phone" },
    { key: "submission_url", label: "Submission URL", requirement: "optional", type: "url" },
    { key: "sla_response_days", label: "SLA days", requirement: "optional", type: "money" },
    { key: "notes", label: "Notes", requirement: "optional", type: "text", maxLen: 2000 },
  ],
  headerAliases: {
    name: "lender_name", lendername: "lender_name", funder: "lender_name",
    funderalname: "lender_name", company: "lender_name",
    tier: "tier", lendertier: "tier", grade: "tier",
    papergrades: "paper_grades", paper: "paper_grades", grades: "paper_grades", abc: "paper_grades",
    minposition: "position_min", positionmin: "position_min",
    maxposition: "position_max", positionmax: "position_max",
    position: "position_max",
    maxnegativedays: "max_negative_days", maxnegdays: "max_negative_days", negdays: "max_negative_days",
    reversesonly: "reverses_only", reverses: "reverses_only", reverseonly: "reverses_only",
    defaultspolicy: "defaults_policy", defaults: "defaults_policy",
    email: "contact_email", submissionemail: "contact_email", contactemail: "contact_email",
    phone: "contact_phone", contactphone: "contact_phone",
    url: "submission_url", submissionurl: "submission_url", website: "submission_url",
    portal: "submission_url",
    sla: "sla_response_days", slaresponsedays: "sla_response_days", slaresponse: "sla_response_days",
    responsedays: "sla_response_days",
    notes: "notes", note: "notes", comment: "notes", comments: "notes",
  },
  sampleCsv:
    "Lender Name,Tier,Paper Grades,Min Position,Max Position,Reverses Only,Submission Email,SLA Days,Notes\n" +
    "Pearl Capital,A,A;B,5000,250000,No,submissions@pearlcapital.com,3,Quick on health/dental verticals\n" +
    "Mantis Funding,B,B;C,10000,500000,Yes,deals@mantisfunding.com,5,Reverses only - paper must be 2nd+\n",
};

// ============================================================================
// APPLICATIONS — in-flight deals already past the qualification stage
// ============================================================================
const APPLICATIONS: EntityDefinition = {
  key: "applications",
  label: "Applications",
  description: "Deals already collecting documents or submitted to lenders.",
  icon: "file-text",
  entity_type: "application",
  defaultDedupBy: ["business", "email"],
  canonicalFields: [
    { key: "business_name", label: "Business", requirement: "required", type: "text", maxLen: 200 },
    { key: "contact_name", label: "Owner", requirement: "optional", type: "text", maxLen: 200 },
    { key: "email", label: "Email", requirement: "optional", type: "email" },
    { key: "phone", label: "Phone", requirement: "optional", type: "phone" },
    { key: "requested_amount", label: "Requested $", requirement: "optional", type: "money" },
    { key: "monthly_revenue", label: "Monthly revenue", requirement: "optional", type: "money" },
    { key: "annual_revenue", label: "Annual revenue", requirement: "optional", type: "money" },
    { key: "paper_grade", label: "Paper grade", requirement: "optional", type: "text", maxLen: 8 },
    { key: "stage", label: "Stage", requirement: "optional", type: "text", maxLen: 80 },
    { key: "lender_list", label: "Lender list", requirement: "optional", type: "text", maxLen: 1000 },
    { key: "application_url", label: "Application URL", requirement: "optional", type: "url" },
    { key: "bank_statement_urls", label: "Bank statement URLs", requirement: "optional", type: "text", maxLen: 2000 },
    { key: "date_submitted", label: "Date submitted", requirement: "optional", type: "date" },
    { key: "assigned_to", label: "Assigned to", requirement: "optional", type: "text", maxLen: 120 },
    { key: "notes", label: "Notes", requirement: "optional", type: "text", maxLen: 2000 },
  ],
  headerAliases: {
    business: "business_name", businessname: "business_name", company: "business_name",
    legalname: "business_name", dba: "business_name", merchant: "business_name",
    contact: "contact_name", contactname: "contact_name", owner: "contact_name",
    ownername: "contact_name",
    email: "email", emailaddress: "email",
    phone: "phone", phonenumber: "phone",
    requestedamount: "requested_amount", requested: "requested_amount", askamount: "requested_amount",
    ask: "requested_amount", amount: "requested_amount", loanamount: "requested_amount",
    monthlyrevenue: "monthly_revenue", mrr: "monthly_revenue",
    annualrevenue: "annual_revenue", arr: "annual_revenue", yearlyrevenue: "annual_revenue",
    papergrade: "paper_grade", paper: "paper_grade", grade: "paper_grade",
    stage: "stage", status: "stage", phase: "stage",
    lenderlist: "lender_list", lenders: "lender_list", shoppedto: "lender_list",
    applicationurl: "application_url", applink: "application_url",
    bankstatementurls: "bank_statement_urls", statementurls: "bank_statement_urls",
    statements: "bank_statement_urls",
    datesubmitted: "date_submitted", submitted: "date_submitted",
    assignedto: "assigned_to", assignee: "assigned_to", owner_rep: "assigned_to",
    notes: "notes", note: "notes",
  },
  sampleCsv:
    "Business,Owner,Requested Amount,Monthly Revenue,Paper Grade,Stage,Lender List,Notes\n" +
    "Velocity Logistics LLC,Carlos Mejia,75000,48000,B,Awaiting Statements,Pearl;Mantis,Deal moving fast\n" +
    "Reyes Motors,Mike Reyes,150000,72000,A,Submitted,Pearl;Slate;Velocity,Wants close by month-end\n",
};

// ============================================================================
// FUNDED DEALS — closed-and-funded for renewals + commission tracking
// ============================================================================
const FUNDED_DEALS: EntityDefinition = {
  key: "funded-deals",
  label: "Funded deals",
  description: "Closed deals — fuels the renewals + commission pipeline.",
  icon: "trophy",
  entity_type: "funded_deal",
  defaultDedupBy: ["business", "lender_name"],
  canonicalFields: [
    { key: "business_name", label: "Business", requirement: "required", type: "text", maxLen: 200 },
    { key: "funded_amount", label: "Funded $", requirement: "required", type: "money" },
    { key: "lender_name", label: "Lender", requirement: "optional", type: "text", maxLen: 200 },
    { key: "funding_date", label: "Funding date", requirement: "optional", type: "date" },
    { key: "term_months", label: "Term (months)", requirement: "optional", type: "money" },
    { key: "factor_rate", label: "Factor rate", requirement: "optional", type: "money" },
    { key: "commission_pct", label: "Commission %", requirement: "optional", type: "money" },
    { key: "payback_amount", label: "Payback $", requirement: "optional", type: "money" },
    { key: "deal_status", label: "Status", requirement: "optional", type: "text", maxLen: 32 },
    { key: "contact_email", label: "Merchant email", requirement: "optional", type: "email" },
    { key: "contact_phone", label: "Merchant phone", requirement: "optional", type: "phone" },
    { key: "assigned_to", label: "Assigned rep", requirement: "optional", type: "text", maxLen: 120 },
    { key: "notes", label: "Notes", requirement: "optional", type: "text", maxLen: 2000 },
  ],
  headerAliases: {
    business: "business_name", businessname: "business_name", merchant: "business_name",
    company: "business_name", dba: "business_name", legalname: "business_name",
    fundedamount: "funded_amount", funded: "funded_amount", amount: "funded_amount",
    fundamount: "funded_amount", advance: "funded_amount",
    lender: "lender_name", funder: "lender_name", lendername: "lender_name",
    fundingdate: "funding_date", funddate: "funding_date", closeddate: "funding_date",
    closed: "funding_date", date: "funding_date",
    term: "term_months", termmonths: "term_months", months: "term_months",
    factor: "factor_rate", factorrate: "factor_rate", rate: "factor_rate",
    commission: "commission_pct", commissionpct: "commission_pct", comm: "commission_pct",
    payback: "payback_amount", paybackamount: "payback_amount", total: "payback_amount",
    status: "deal_status", dealstatus: "deal_status",
    email: "contact_email", merchantemail: "contact_email",
    phone: "contact_phone", merchantphone: "contact_phone",
    assignedto: "assigned_to", rep: "assigned_to", assignee: "assigned_to",
    notes: "notes", note: "notes",
  },
  sampleCsv:
    "Business,Funded Amount,Lender,Funding Date,Term Months,Factor Rate,Commission %,Status\n" +
    "Velocity Logistics LLC,75000,Pearl Capital,2026-05-21,6,1.32,12,active\n" +
    "Reyes Motors,150000,Slate Advance,2026-04-08,9,1.28,10,paid_off\n",
};

// ============================================================================
// Registry export
// ============================================================================

export const IMPORT_ENTITIES: ReadonlyArray<EntityDefinition> = [
  LEADS,
  APPLICATIONS,
  LENDERS,
  FUNDED_DEALS,
];

export function getEntityDefinition(key: string): EntityDefinition | null {
  return IMPORT_ENTITIES.find((e) => e.key === key) ?? null;
}
