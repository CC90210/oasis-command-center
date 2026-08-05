/**
 * Single source of truth for public legal copy (/privacy, /terms, /dmca) and
 * the machine-readable docs/compliance/PRIVACY_NUTRITION_LABEL.json.
 *
 * Everything here is derived from what the codebase ACTUALLY does, verified
 * 2026-07-27:
 *   - Collected fields come from the funnel form schema (app/api/forms/*).
 *   - Subprocessors come from real outbound calls found in app/ + lib/
 *     (api.anthropic.com, api.openai.com, generativelanguage.googleapis.com)
 *     and package.json (@supabase/*), NOT from a boilerplate list.
 *   - There is currently NO third-party analytics/pixel SDK in this app.
 *     Do not add one to this file speculatively — if you wire GA/PostHog/Meta,
 *     add it HERE in the same commit or the nutrition label goes stale and
 *     the privacy page becomes a false statement.
 *
 * If you change what the app collects or who it sends data to, change this
 * file. The pages render from it, so the pages cannot drift from it.
 *
 * The JSON manifest at docs/compliance/PRIVACY_NUTRITION_LABEL.json is a
 * SECOND copy of these facts (app stores want a static file, not a React
 * page). Nothing in the type system keeps the two in step, so
 * tests/legal-compliance-drift.test.ts asserts they agree and fails the build
 * if an analytics package appears while the policy still claims there is none.
 * A stale legal page is a false statement, not a cosmetic bug — that test is
 * the reason this duplication is safe to keep.
 */

export const LEGAL_ENTITY = "OASIS AI Solutions";
export const LEGAL_JURISDICTION = "Province of Quebec, Canada";
export const LEGAL_PRINCIPAL_PLACE = "Montreal, Quebec, Canada";

/** Effective date shown on all three legal pages. */
export const LEGAL_EFFECTIVE_DATE = "July 27, 2026";

export const LEGAL_CONTACTS = {
  privacy: "privacy@oasisai.work",
  legal: "legal@oasisai.work",
  dmca: "dmca@oasisai.work",
  support: "support@oasisai.work",
} as const;

/**
 * FTC-facing AI disclosure. Rendered in the public footer, on the signup
 * consent line, and at the top of /privacy. Kept as one exported constant so
 * the wording is identical everywhere — inconsistent disclosures are worse
 * than none, because they suggest the disclosure is decorative.
 */
export const AI_DISCLOSURE_NOTICE =
  "Notice: This application uses artificial intelligence (AI), automated algorithms, " +
  "and large language models (LLMs) to process data, generate content, and execute workflows. " +
  "AI output can be inaccurate and is not professional, legal, financial, or medical advice.";

export type Subprocessor = {
  name: string;
  role: string;
  dataReceived: string;
  region: string;
  /**
   * Whether a Data Processing Agreement / commercial terms are known to be in
   * place for THIS data path. `false` here is a live compliance gap, not a
   * styling choice — see docs/compliance/LEGAL_COMPLIANCE_AUDIT.md.
   */
  dpaInPlace: boolean;
  note?: string;
};

export const SUBPROCESSORS: Subprocessor[] = [
  {
    name: "Supabase, Inc.",
    role: "Database, authentication, and file storage",
    dataReceived:
      "All account data, lead/application records, and uploaded documents",
    region: "United States",
    dpaInPlace: true,
  },
  {
    name: "Vercel, Inc.",
    role: "Application hosting and edge delivery",
    dataReceived: "Request metadata, IP address, and server logs",
    region: "United States / global edge",
    dpaInPlace: true,
  },
  {
    name: "Anthropic PBC",
    role: "Large language model inference (Claude)",
    dataReceived:
      "Chat messages, agent prompts, and the contents of uploaded application documents submitted for field extraction",
    region: "United States",
    dpaInPlace: false,
    note:
      "Document extraction currently runs through the Claude CLI on an individual " +
      "subscription rather than a commercial API account. Consumer subscription terms " +
      "differ materially from Anthropic's Commercial Terms and DPA. See the audit doc.",
  },
  {
    name: "OpenAI, L.L.C.",
    role: "Large language model inference (GPT), used for delegated code and review tasks",
    dataReceived: "Prompt content routed to the secondary model provider",
    region: "United States",
    dpaInPlace: false,
  },
  {
    name: "Google LLC",
    role: "Large language model inference (Gemini), used as a fallback provider",
    dataReceived: "Prompt content routed to the fallback model provider",
    region: "United States",
    dpaInPlace: false,
  },
];

export type DataCategory = {
  category: string;
  /** Concrete field names, so the page is auditable against the schema. */
  examples: string;
  purpose: string;
  sharedWith: string;
  sensitive: boolean;
  retention: string;
};

/**
 * The Privacy Data Matrix rendered on /privacy and mirrored into the
 * App-Store-style nutrition label.
 *
 * The `sensitive: true` rows are the ones that carry real statutory weight:
 * SSN / date of birth / EIN are collected by the funding-application funnel
 * (app/f/[tenant_slug]/[form_slug]) and are "sensitive personal information"
 * under Quebec's Law 25 and CPRA, which changes the consent standard.
 */
export const DATA_MATRIX: DataCategory[] = [
  {
    category: "Contact identifiers",
    examples: "first_name, last_name, email, phone",
    purpose: "Account creation, service delivery, and operator communication",
    sharedWith: "Supabase (storage), Anthropic (when included in agent context)",
    sensitive: false,
    retention: "Life of the account, then 24 months",
  },
  {
    category: "Business identifiers",
    examples: "company, address, city, state, zip, revenue",
    purpose: "Qualifying and routing an application to the correct workflow",
    sharedWith: "Supabase, and the tenant whose form was submitted",
    sensitive: false,
    retention: "Life of the account, then 24 months",
  },
  {
    category: "Government and financial identifiers",
    examples: "ssn, dob, ein, tax_id",
    purpose:
      "Completing a funding application on behalf of the submitting business",
    sharedWith:
      "Supabase (encrypted at rest), and Anthropic when present in an uploaded document submitted for extraction",
    sensitive: true,
    retention:
      "Retained only as long as the application is active, then deleted on request",
  },
  {
    category: "Uploaded documents",
    examples:
      "Bank statements, signed applications, and other files submitted through the form dropzone",
    purpose: "Automated field extraction and application assembly",
    sharedWith: "Supabase Storage, Anthropic (extraction)",
    sensitive: true,
    retention: "Deleted on request; otherwise retained with the application",
  },
  {
    category: "Usage and diagnostic data",
    examples: "IP address, request paths, timestamps, error logs",
    purpose: "Security, abuse prevention, and debugging",
    sharedWith: "Vercel, Supabase",
    sensitive: false,
    retention: "30 days (platform logs)",
  },
];

/**
 * Jurisdictions where a pre-dispute consumer arbitration clause and/or a
 * class-action waiver is void or unenforceable. The /terms arbitration section
 * carves these out explicitly.
 *
 * This is not defensive boilerplate — OASIS AI Solutions is domiciled in
 * Quebec, so the carve-out covers the operator's OWN home forum. A clause with
 * no carve-out is not merely unenforceable there; under CCQ art. 1437 an
 * abusive clause in a consumer contract of adhesion can be struck on its own
 * terms, which weakens the rest of the agreement.
 */
export const ARBITRATION_CARVE_OUTS = [
  "Quebec — Consumer Protection Act, s. 11.1 (arbitration clauses are unenforceable against consumers)",
  "Ontario and other Canadian provinces with equivalent consumer-protection statutes",
  "Any jurisdiction where a pre-dispute arbitration agreement or class-action waiver is void as a matter of law",
];
