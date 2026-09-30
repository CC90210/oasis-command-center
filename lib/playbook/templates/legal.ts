/**
 * Legal and privacy document templates (Law 25 register, assessments,
 * governance, client DPA, MSA, NDA, IP assignment, DMCA agent). Facts come only
 * from TemplateContext; every unknown is a [[CC to confirm: ...]] placeholder.
 * These are drafts, not legal advice: the page shows the counsel banner on
 * every legal draft.
 */

import { confirm, type TemplateContext } from "./context";
import { doc, entityLine, header, processorsOutsideQuebec, section, type DocTemplate } from "./shared";

export const law25IncidentRegister: DocTemplate = (ctx) =>
  doc(
    header(
      "Law 25 incident register",
      ctx,
      `The register of confidentiality incidents ${ctx.legal.entity} keeps under section 3.8 of Quebec's Act respecting the protection of personal information in the private sector (Law 25). Every incident is recorded, including one that did not have to be reported.`,
    ),
    section(
      "Who keeps it",
      `- ${ctx.legal.privacyOfficer.name}, ${ctx.legal.privacyOfficer.titleEn} (${ctx.legal.privacyOfficer.titleFr}), ${ctx.legal.privacyOfficer.email}.`,
      "- Entries are recorded in the app, below this document, by a founder. The register is append-only: an entry is never edited or deleted; a correction is a new entry that points at the one it corrects.",
    ),
    section(
      "What counts as a confidentiality incident",
      "- Access to, use of or communication of personal information that the law does not authorize.",
      "- The loss of personal information, or any other breach of its protection.",
    ),
    section(
      "What each entry records",
      "1. The personal information concerned.",
      "2. A brief description of the circumstances.",
      "3. When the incident happened (a date or a period).",
      "4. When OASIS became aware of it.",
      "5. How many people are concerned, or that it is not yet known.",
      "6. What the assessment of the risk of serious injury rests on (how sensitive the information is, the likely consequences, how likely misuse is).",
      "7. When the Commission d'acces a l'information and the people concerned were notified, when the risk is serious.",
      "8. The measures taken to reduce the risk of injury.",
    ),
    section(
      "When there is a risk of serious injury",
      "- Notify the Commission d'acces a l'information and every person concerned promptly.",
      `- Notification wording and channel: ${confirm("who drafts the notice and who approves it before it is sent")}`,
    ),
    section(
      "Retention",
      "- Each entry is kept for at least five years after the date OASIS became aware of the incident. The app has no delete path for the register.",
    ),
    section("Counsel review", `- ${confirm("the lawyer who reviews this register process, or that it is published as not counsel-reviewed")}`),
  );

export const privacyImpactAssessments: DocTemplate = (ctx) => {
  const outside = processorsOutsideQuebec(ctx);
  const rows = outside.map(
    (s) =>
      `| ${s.name} | ${s.role} | ${s.dataReceived} | ${s.region} | ${s.dpaInPlace ? "In place" : "Not yet"} | ${confirm(`the protection ${s.name}'s contract actually gives, and whether it is adequate`)} |`,
  );
  return doc(
    header(
      "Privacy impact assessments (per processor)",
      ctx,
      `Before personal information is communicated outside Quebec, Law 25 s.17 requires an assessment that takes into account the sensitivity of the information, the purpose, the protection measures (including contractual ones) and the legal framework where it goes. One row per processor on the published list (privacy policy, last updated ${ctx.legal.privacyLastUpdated}).`,
    ),
    section(
      "Processors outside Quebec",
      "| Processor | Role | Information received | Where | Data processing agreement | Assessment |",
      "|---|---|---|---|---|---|",
      ...rows,
    ),
    section(
      "Conclusion",
      `- ${confirm("for each processor, whether the information will receive adequate protection, and who signed off")}`,
      "- A processor whose agreement is not yet in place is a gap to close before relying on this assessment.",
    ),
  );
};

export const privacyGovernancePolicy: DocTemplate = (ctx) =>
  doc(
    header(
      "Privacy governance and retention policy",
      ctx,
      `How ${ctx.legal.entity} governs the personal information it holds (Law 25 s.3.2). The public summary of this policy is the privacy policy at /privacy.`,
    ),
    section(
      "Roles",
      `- Person in charge of the protection of personal information: ${ctx.legal.privacyOfficer.name} (${ctx.legal.privacyOfficer.email}).`,
      `- Who else may access personal information, and why: ${confirm("the roles (founders, sales, builders) and what each may see")}`,
    ),
    section(
      "Retention, as published",
      "| Category | Retention |",
      "|---|---|",
      ...ctx.legal.dataMatrix.map((d) => `| ${d.category} | ${d.retention} |`),
    ),
    section(
      "Destruction",
      `- How information is destroyed or anonymised when its retention ends: ${confirm("the destruction method and who runs it")}`,
    ),
    section(
      "Requests and complaints",
      `- Access, correction and deletion requests go to ${ctx.legal.privacyOfficer.email}.`,
      `- Response time commitment: ${confirm("the response time OASIS commits to")}`,
    ),
    section(
      "Training and review",
      `- ${confirm("how team members are trained on this policy, and how often the policy is reviewed")}`,
    ),
  );

export const clientDpa: DocTemplate = (ctx) =>
  doc(
    header(
      "Client data processing agreement",
      ctx,
      `The agreement between a client (the controller of its customers' information) and ${ctx.legal.entity} (the service provider that processes it for the client).`,
    ),
    section("Parties", `- Service provider: ${entityLine(ctx)}.`, "- Client: [Client legal name and address]."),
    section(
      "Processing",
      "- OASIS processes the client's personal information only to provide the services the client ordered, on the client's documented instructions.",
      "- Categories of information and people: [from the client's order].",
    ),
    section(
      "Sub-processors",
      `- The processors listed in OASIS's privacy policy (last updated ${ctx.legal.privacyLastUpdated}): ${ctx.legal.subprocessors.map((s) => s.name).join(", ")}.`,
      `- How the client is told of a new processor, and how long it has to object: ${confirm("the notice period for a new sub-processor")}`,
    ),
    section(
      "Security and incidents",
      "- Workspaces are isolated by the application (every record carries the workspace's id and every query filters on it); files are stored in Cloudflare R2.",
      `- OASIS notifies the client of a confidentiality incident affecting its information within ${confirm("the notification deadline")}.`,
    ),
    section(
      "Annex: assessment for communication outside Quebec (Law 25 s.17)",
      "- Attach the per-processor assessments (Playbook > Business documentation > Privacy impact assessments).",
    ),
    section("Term, return and deletion", `- ${confirm("what happens to the client's information when the agreement ends, and within how many days")}`),
    section("Governing law", `- The laws of the ${ctx.legal.jurisdiction}.`),
  );

export const msaTemplate: DocTemplate = (ctx) =>
  doc(
    header(
      "Master services agreement (template)",
      ctx,
      `The agreement ${ctx.legal.entity} signs with a business client. Order-specific terms (scope, price, dates) go in a statement of work under it.`,
    ),
    section("Parties", `- ${entityLine(ctx)} ("OASIS").`, "- [Client legal name and address] (the \"Client\")."),
    section("Services", "- OASIS provides the services described in each signed statement of work. A change of scope is a new or amended statement of work."),
    section(
      "Fees and payment",
      "- Fees are set in each statement of work.",
      `- Payment terms and late fees: ${confirm("payment terms, late-payment interest, and whether work pauses on non-payment")}`,
      `- Taxes: ${ctx.finance.ok ? (ctx.finance.value.registered ? "GST and QST are added to every invoice." : "OASIS is not registered for GST or QST; none is charged until it is.") : confirm(`GST/QST registration (${ctx.finance.why})`)}`,
    ),
    section(
      "Intellectual property",
      `- ${confirm("who owns the client's deliverables and when ownership passes (for example on full payment), and what OASIS keeps (its tools, templates and know-how)")}`,
    ),
    section("Confidentiality", "- Each party keeps the other's confidential information confidential and uses it only for this agreement."),
    section(
      "Personal information",
      "- Where OASIS processes personal information for the Client, the client data processing agreement applies.",
    ),
    section(
      "Warranties and liability",
      "- The services use artificial intelligence; AI output can be inaccurate and is reviewed before it is relied on.",
      `- Limitation of liability: ${confirm("the liability cap (for example fees paid in the last 12 months) and its exclusions")}`,
    ),
    section("Term and termination", `- ${confirm("the term, renewal, and the notice either party gives to end it")}`),
    section("Governing law", `- The laws of the ${ctx.legal.jurisdiction}.`, `- Forum for disputes: ${confirm("the court or arbitration forum")}`),
    section("Counsel review", `- ${confirm("whether the 2026-06-21 Drive MSA is the base, and the lawyer who reviews this template")}`),
  );

export const mutualNda: DocTemplate = (ctx) =>
  doc(
    header("Mutual NDA (template)", ctx, `A two-way confidentiality agreement between ${ctx.legal.entity} and another business.`),
    section("Parties", `- ${entityLine(ctx)}.`, "- [Other party legal name and address]."),
    section("Purpose", "- [Why information is being shared, for example evaluating a project together]."),
    section(
      "Confidential information",
      "- Anything one party discloses to the other that is marked confidential or would reasonably be understood to be confidential.",
      "- Excluded: information that is public, already known, independently developed, or received lawfully from someone else.",
    ),
    section("Obligations", "- Use it only for the purpose above, share it only with people who need it and are bound to keep it confidential, and protect it with reasonable care."),
    section("Term", `- ${confirm("how long the obligations last (for example two years after the last disclosure)")}`),
    section("Governing law", `- The laws of the ${ctx.legal.jurisdiction}.`),
  );

export const ipAssignment: DocTemplate = (ctx) =>
  doc(
    header("IP assignment to OASIS", ctx, `The founders assign to the business what they create for ${ctx.legal.entity}.`),
    section("Parties", `- ${ctx.legal.privacyOfficer.name}.`, `- ${confirm("Adon's full legal name")}`, `- The receiving entity: ${confirm("which entity receives the IP until the business is incorporated")}`),
    section(
      "What is assigned",
      "- Code, prompts, agent configurations, documents, designs and content created for OASIS, from the start of the business.",
      `- Start date: ${confirm("the date from which work counts as OASIS work")}`,
    ),
    section("What is not assigned", `- ${confirm("pre-existing work each founder keeps, listed")}`),
    section("Governing law", `- The laws of the ${ctx.legal.jurisdiction}.`),
  );

export const dmcaAgentRegistration: DocTemplate = (ctx) =>
  doc(
    header(
      "DMCA agent registration",
      ctx,
      "The /dmca page names a designated agent. US safe harbour needs that agent registered with the US Copyright Office, and the designation renewed every three years.",
    ),
    section(
      "Designation",
      `- Service provider: ${ctx.legal.entity}.`,
      `- Agent contact email: ${ctx.legal.contacts.dmca}.`,
      `- Street address: ${confirm("the street address for the filing")}`,
      `- Phone: ${confirm("the phone number for the filing")}`,
    ),
    section(
      "Filing",
      `- Filed on: ${confirm("the filing date and confirmation number, once filed")}`,
      "- Renew three years after the filing date.",
    ),
  );

export const LEGAL_TEMPLATES: Readonly<Record<string, DocTemplate>> = {
  "law25-incident-register": law25IncidentRegister,
  "privacy-impact-assessments": privacyImpactAssessments,
  "privacy-governance-policy": privacyGovernancePolicy,
  "client-dpa": clientDpa,
  "msa-template": msaTemplate,
  "mutual-nda": mutualNda,
  "ip-assignment": ipAssignment,
  "dmca-agent-registration": dmcaAgentRegistration,
};

export type { TemplateContext };
