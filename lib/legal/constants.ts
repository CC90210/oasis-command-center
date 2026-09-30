/**
 * Single source of truth for public legal copy (/privacy, /terms, /dmca) and
 * the machine-readable docs/compliance/PRIVACY_NUTRITION_LABEL.json.
 *
 * Everything here is derived from what the codebase ACTUALLY does, first
 * verified 2026-07-27 and re-verified 2026-09-28 after the Turso + Cloudflare
 * cutover:
 *   - Collected fields come from the funnel form schema (app/api/forms/*).
 *   - Subprocessors come from the deployed stack and the real outbound calls
 *     found in app/ + lib/ (the libSQL client and backend-mode default,
 *     wrangler.jsonc + lib/r2-storage.ts, the model hosts in lib/providers.ts,
 *     the Gmail/Calendar APIs, api.stripe.com, api.twilio.com,
 *     api.telegram.org), NOT from a boilerplate list. Supabase and Vercel were
 *     removed on 2026-09-28: the app no longer runs on either.
 *     tests/legal-compliance-drift.test.ts pins each processor to the code
 *     that proves it is used, in both directions.
 *   - Tenant isolation is application-level (tenant-scoped tables carry
 *     tenant_id and application queries filter on it). Turso/libSQL has no
 *     per-row database policies, so the legal pages must never describe the
 *     isolation as database-enforced; the drift test (npm run test:legal)
 *     fails if they do.
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

/**
 * Date the privacy policy's content last changed. Shown on /privacy only.
 *
 * Separate from LEGAL_EFFECTIVE_DATE on purpose: that date is rendered on
 * /terms and /dmca as well, and moving it would tell readers those documents
 * changed when they did not. /privacy promises to update this date whenever
 * it changes, so bump it in the same commit as any edit to the policy.
 */
export const PRIVACY_LAST_UPDATED = "September 30, 2026";

/**
 * Every address the legal pages publish. Each one must be a mailbox a person
 * actually reads, listed in config/verified-mailboxes.json;
 * tests/verified-mailboxes.test.ts fails the build otherwise.
 *
 * Until 2026-09-30 these were four role aliases (privacy@, legal@, dmca@,
 * support@) that had never been created: CC confirmed privacy@ did not exist,
 * the Gmail send-as list held only conaugh@, and no mail had ever reached any of
 * the four. A privacy request, a legal notice or a DMCA takedown sent to them
 * went nowhere, while the policy promised a 30-day answer. They now point at
 * the one verified inbox. To bring a role address back, create it as a Google
 * Workspace alias, send it a test message, add it to verified-mailboxes.json,
 * and only then change it here.
 */
const VERIFIED_INBOX = "conaugh@oasisai.work";

export const LEGAL_CONTACTS = {
  privacy: VERIFIED_INBOX,
  legal: VERIFIED_INBOX,
  dmca: VERIFIED_INBOX,
  support: VERIFIED_INBOX,
} as const;

/**
 * The person in charge of the protection of personal information, which
 * Quebec's Law 25 (Act respecting the protection of personal information in
 * the private sector, ss. 3.1-3.2) requires an enterprise to designate and to
 * publish on its website by title and contact information.
 *
 * By default the role belongs to the person with the highest authority in the
 * enterprise; CC holds it (decision recorded in docs/os-revamp/PLAN.md,
 * "Privacy officer"). If it is delegated, change it HERE — /privacy renders
 * from this object, so the published name cannot drift from the designation.
 *
 * `title` carries both languages so the French version of the policy (Charter
 * of the French Language) reuses the statutory French title rather than a
 * retranslation.
 */
export const PRIVACY_OFFICER = {
  name: "Conaugh McKenna",
  title: {
    en: "Person in charge of the protection of personal information",
    fr: "Responsable de la protection des renseignements personnels",
  },
  email: LEGAL_CONTACTS.privacy,
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
   * styling choice — each one is listed under `openGaps` in
   * docs/compliance/PRIVACY_NUTRITION_LABEL.json. Only mark `true` when the
   * provider's standard customer terms incorporate a DPA for the account this
   * app actually uses, or one has been signed.
   */
  dpaInPlace: boolean;
  /** Rendered under the processor's name on /privacy. Public copy. */
  note?: string;
};

/**
 * Every processor that receives personal information from this app, in the
 * order /privacy lists them.
 *
 * tests/legal-compliance-drift.test.ts ties each entry to the code that proves
 * it is in use (a dependency, a deploy config, or an outbound API host) and
 * fails in both directions: a provider the code calls that is missing here,
 * and an entry here with no code behind it. Add or remove an integration and
 * the test tells you to update this list — and the JSON manifest — with it.
 *
 * Deliberately NOT listed: providers wired only for the retired SunBiz tenant
 * (TextTorrent, Kixie, Constant Contact, Smartlead) and the address-lookup
 * fallbacks (Mapbox, Photon) on the SunBiz merchant application form. They
 * leave with the SunBiz retirement track; if any is re-enabled for a live
 * tenant it must be added.
 */
export const SUBPROCESSORS: Subprocessor[] = [
  {
    name: "Turso",
    role: "Primary database (libSQL)",
    dataReceived:
      "All account data, lead and application records, messages, and the audit log",
    region: "United States",
    dpaInPlace: false,
  },
  {
    name: "Cloudflare, Inc.",
    role: "Application hosting (Workers), file storage (R2), and edge delivery",
    dataReceived:
      "Every request to the application, including IP address and request logs, and uploaded documents and attachments",
    region: "Global edge network",
    dpaInPlace: true,
  },
  {
    name: "Anthropic PBC",
    role: "Large language model inference (Claude)",
    dataReceived:
      "Chat messages, agent prompts, lead context used to draft or classify messages, and the contents of uploaded application documents submitted for field extraction",
    region: "United States",
    dpaInPlace: false,
    note:
      "Some automated tasks run through Anthropic's Claude Code tool on an OASIS " +
      "subscription account rather than under a commercial API agreement. Subscription " +
      "terms differ materially from Anthropic's Commercial Terms and data processing addendum.",
  },
  {
    name: "OpenAI, L.L.C.",
    role: "Large language model inference (GPT), when a workspace or agent is configured to use it",
    dataReceived: "Chat messages and agent prompts sent to that model",
    region: "United States",
    dpaInPlace: false,
  },
  {
    name: "OpenRouter",
    role: "Model routing, when a workspace is configured to use it",
    dataReceived:
      "Chat messages and agent prompts, forwarded to the model provider the workspace selects",
    region: "United States; forwarded to the host of the selected model",
    dpaInPlace: false,
  },
  {
    name: "Google LLC",
    role:
      "Google Workspace APIs (Gmail sending and inbox monitoring, Calendar events) and Gemini model inference when a workspace selects it",
    dataReceived:
      "Outbound email content and recipient addresses, connected inbox messages, meeting details and attendee addresses, and prompts sent to Gemini",
    region: "United States",
    dpaInPlace: false,
  },
  {
    name: "Stripe",
    role: "Payments and billing",
    dataReceived:
      "Customer name, email address, and payment details. Card numbers are entered directly with Stripe and never reach our servers.",
    region: "United States",
    dpaInPlace: true,
  },
  {
    name: "Twilio Inc.",
    role: "SMS messaging",
    dataReceived: "Recipient phone numbers and message content (for example, meeting reminders and replies)",
    region: "United States",
    dpaInPlace: true,
  },
  {
    name: "Telegram",
    role: "Operational alerts to staff",
    dataReceived:
      "Contact details (name, email address, phone number) and form answers included in new-lead, booking, and support alerts",
    region: "Global",
    dpaInPlace: false,
    note: "No data processing agreement currently covers these alerts.",
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
    sharedWith:
      "Turso (storage); the workspace's model provider when included in agent context; Google (email and calendar invitations); Twilio (SMS); Telegram (staff alerts)",
    sensitive: false,
    retention: "Life of the account, then 24 months",
  },
  {
    category: "Business identifiers",
    examples: "company, address, city, state, zip, revenue",
    purpose: "Qualifying and routing an application to the correct workflow",
    sharedWith:
      "Turso (storage); the workspace's model provider when included in agent context; and the tenant whose form was submitted",
    sensitive: false,
    retention: "Life of the account, then 24 months",
  },
  {
    category: "Government and financial identifiers",
    examples: "ssn, dob, ein, tax_id",
    purpose:
      "Completing a funding application on behalf of the submitting business",
    sharedWith:
      "Turso (storage), and Anthropic when present in an uploaded document submitted for extraction",
    sensitive: true,
    retention:
      "Retained only as long as the application is active, then deleted on request",
  },
  {
    category: "Uploaded documents",
    examples:
      "Bank statements, signed applications, and other files submitted through the form dropzone",
    purpose: "Automated field extraction and application assembly",
    sharedWith: "Cloudflare R2 (storage), Anthropic (extraction)",
    sensitive: true,
    retention: "Deleted on request; otherwise retained with the application",
  },
  {
    category: "Usage and diagnostic data",
    examples: "IP address, request paths, timestamps, error logs",
    purpose: "Security, abuse prevention, and debugging",
    sharedWith: "Cloudflare (hosting logs)",
    sensitive: false,
    retention:
      "Up to 30 days (platform logs). Request logs from before September 2026 remain with our former hosting provider until that account is closed (section 6).",
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
