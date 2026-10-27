/**
 * Corporate, tax/finance, people, security-operations and strategy document
 * templates. Facts come only from TemplateContext; every unknown is a
 * [[CC to confirm: ...]] placeholder. Public tax dates written here are the
 * standard CRA and Revenu Quebec deadlines; the calendar still carries a
 * placeholder asking the accountant to confirm the filing position, so it
 * cannot be marked current unchecked.
 */

import { PROJECT_STAGES, PROJECT_STAGE_LABELS } from "@/lib/delivery/rules";
import { ENTERPRISE_REGISTRATION_RULE, SMALL_SUPPLIER_RULE } from "../regulatory";
import { confirm, money, type TemplateContext } from "./context";
import { doc, entityLine, header, section, type DocTemplate } from "./shared";

function gstLine(ctx: TemplateContext): string {
  if (!ctx.finance.ok) return confirm(`GST/QST registration status (${ctx.finance.why})`);
  const f = ctx.finance.value;
  if (!f.registered) return "Not registered for GST or QST (Finances settings). No GST/QST return is due while unregistered.";
  return `Registered: GST ${f.gstNumber || confirm("the GST number")}, QST ${f.qstNumber || confirm("the QST number")}, effective ${f.effectiveDate || confirm("the effective date")}.`;
}

// Corporate ----------------------------------------------------------------------

export const foundersAgreement: DocTemplate = (ctx) =>
  doc(
    header("Sole proprietor ownership and continuity record", ctx, `How CC owns, controls and continues ${ctx.legal.entity}.`),
    section("Owner", `- Conaugh McKenna ("CC") is the sole proprietor and sole owner of ${ctx.legal.entity} as of 2026-10-21.`),
    section(
      "Registration",
      `- Legal form and registration details: ${confirm("the accountant-confirmed sole-proprietorship registration, business-number and NEQ details")}`,
      "- No former owner, contractor or agent has ownership authority by virtue of historical access, work or records.",
    ),
    section(
      "Owner-reserved decisions",
      "- CC alone may take on debt, hire or dismiss people, sell the business, grant equity, change ownership, or authorize access to company systems.",
      `- Delegations: ${confirm("any written delegation CC wants recorded, including its scope and expiry")}`,
    ),
    section("Money", `- Owner draws and reinvestment: see the capital allocation policy. ${confirm("any owner-specific draw or reinvestment rule")}`),
    section("Continuity", `- ${confirm("who may act if CC is temporarily unable to work, where the authority is documented, and how it expires")}`, `- ${confirm("the succession or estate plan if CC dies or permanently cannot operate the business")}`),
    section("Intellectual property", "- CC records and assigns business IP to the operating business or its future successor entity (see the IP assignment)."),
    section("Governing law", "- Province of Ontario, Canada (CC confirmed 2026-10-27)."),
  );

export const enterpriseRegistration: DocTemplate = (ctx) =>
  doc(
    header(
      "Enterprise registration (NEQ)",
      ctx,
      `Whether ${ctx.legal.entity} is registered with the Registraire des entreprises du Quebec. ${ENTERPRISE_REGISTRATION_RULE}`,
    ),
    section(
      "Status",
      `- Registered: ${confirm("yes or no")}`,
      `- Legal form: ${confirm("partnership, sole proprietorship or corporation (Quebec or federal)")}`,
      `- NEQ: ${confirm("the Quebec enterprise number, once registered")}`,
    ),
    section("Annual update", `- ${confirm("the annual updating declaration date")}`),
    section("Incorporation", `- ${confirm("whether incorporation is planned, and when")}`),
  );

export const insurance: DocTemplate = (ctx) =>
  doc(
    header("E&O and cyber insurance", ctx, `The insurance ${ctx.legal.entity} carries for professional errors and for cyber incidents.`),
    section("Professional liability (E&O)", `- ${confirm("insurer, policy number, limit, deductible and renewal date, or that there is no policy")}`),
    section("Cyber", `- ${confirm("insurer, policy number, limit, deductible and renewal date, or that there is no policy")}`),
    section("Client requirements", `- ${confirm("any client contract that requires a minimum coverage")}`),
  );

export const decisionsLog: DocTemplate = (ctx) =>
  doc(
    header("Decisions log", ctx, "The calls that shape OASIS, written down so they can be audited later. Newest first."),
    section(
      "How to record a decision",
      "- Date, decision, options considered, the choice and why, the expected outcome, and the date to review it.",
    ),
    section(
      "Decisions",
      "| Date | Decision | Options considered | Why | Review on |",
      "|---|---|---|---|---|",
      `| ${ctx.today} | ${confirm("the first decision to record")} | | | |`,
    ),
  );

export const orgChart: DocTemplate = (ctx) =>
  doc(
    header("Org chart and decision rights", ctx, `Who owns what at ${ctx.legal.entity}.`),
    section(
      "Departments",
      "- Chief of Staff, Sales, Marketing, Client Success, Finance and Operations each have a channel in the app (Team).",
      `- The human accountable for each: ${confirm("one name per department")}`,
    ),
    section("Decision rights", `- ${confirm("for the ten most frequent decisions: who decides, who is consulted, who is told")}`),
  );

// Tax and finance --------------------------------------------------------------------

export const quebecTaxCalendar: DocTemplate = (ctx) =>
  doc(
    header(
      "Tax calendar (federal and provincial)",
      ctx,
      `Every filing and payment date for ${ctx.legal.entity} and its owner. OASIS is in ${ctx.legal.principalPlace}. CC's provincial return for a year follows where he lived on December 31 of that year: ${confirm("the province for 2026 (Ontario after the October 2026 move from Quebec) and whether any 2026 business income is still taxed in Quebec, from the accountant")}.`,
    ),
    section(
      "Filing position",
      `- Structure: ${confirm("sole proprietorship owned by Conaugh McKenna; the accountant's confirmation and registration details")}`,
      `- Partnership information returns (federal and Quebec): ${confirm("whether they apply to OASIS this year")}`,
    ),
    section(
      "Owner, every year (self-employed individual)",
      "- Federal: T1 return with form T2125 (statement of business or professional activities) for OASIS income.",
      "- A year CC lived in Ontario on December 31: Ontario tax is calculated on the same T1 and filed with the CRA only, and Canada Pension Plan contributions on self-employment income are calculated on the T1.",
      "- A year CC lived in Quebec on December 31: also a TP-1 return with form TP-80 (business or professional income) to Revenu Quebec, and Quebec Pension Plan contributions and QPIP premiums are calculated on the TP-1.",
      "- Filing deadline: June 15. Any balance owing is due April 30.",
    ),
    section(
      "Instalments",
      "- When required, instalments are due March 15, June 15, September 15 and December 15, to the CRA, and also to Revenu Quebec for a year CC lived in Quebec.",
      `- Whether CC must pay instalments this year: ${confirm("the accountant's answer, from prior years' tax owing")}`,
    ),
    section(
      "GST/QST",
      `- ${gstLine(ctx)}`,
      `- ${SMALL_SUPPLIER_RULE} Record the registration in Finances settings the day it is made, then add the filing dates here.`,
    ),
    section("Set aside", `- ${confirm("the share of each payment received that is set aside for tax, as the accountant recommends")}`),
  );

export const accountantEngagement: DocTemplate = (ctx) =>
  doc(
    header("Accountant engagement", ctx, `The accountant ${ctx.legal.entity} works with, and what they need.`),
    section("Accountant", `- ${confirm("name, firm and contact, or that none is engaged yet")}`),
    section("Scope", `- ${confirm("which returns they prepare (TP-1, T1, partnership returns, GST/QST) and the fee")}`),
    section(
      "What OASIS sends each year",
      "- The business ledger export from Finances, receipts, the GST/QST status, and the owner's business income.",
      `- By: ${confirm("the date the accountant needs it")}`,
    ),
  );

export const capitalAllocationPolicy: DocTemplate = (ctx) =>
  doc(
    header("Capital allocation policy", ctx, "Where each dollar of profit goes, decided once so it is not decided under pressure."),
    section("Tax reserve", `- ${confirm("the share of revenue set aside for tax, from the accountant")}`),
    section("Operating reserve", `- ${confirm("how many months of costs are kept in reserve")}`),
    section("Reinvestment", `- ${confirm("the share reinvested, and in what")}`),
    section("Owner draws", `- ${confirm("when and how CC takes owner draws")}`),
    section(
      "Current goal",
      ctx.goal.ok
        ? ctx.goal.value
          ? `- Active revenue goal: ${ctx.goal.value.label}, ${money(ctx.goal.value.targetCents, ctx.goal.value.currency)} collected between ${ctx.goal.value.periodStart} and ${ctx.goal.value.periodEnd}.`
          : "- No active revenue goal is recorded."
        : `- ${confirm(`the active revenue goal (${ctx.goal.why})`)}`,
    ),
  );

// People --------------------------------------------------------------------------------

export const marketingContractorAgreement: DocTemplate = (ctx) =>
  doc(
    header(
      "Contractor agreement: marketing",
      ctx,
      "The four other contractor agreements read every rate from the payout engine. Marketing has no agreed pay structure, so this draft has none: a number nobody approved never goes into a document someone signs.",
    ),
    section("Parties", `- ${entityLine(ctx)}.`, "- [Contractor legal name and email]."),
    section("The role", `- ${confirm("what the marketing contractor delivers (content, campaigns, ads) and how it is measured")}`),
    section("Pay", `- ${confirm("the pay structure: retainer, per campaign, salary or day rate, with the amount and when it is paid")}`),
    section(
      "Common terms",
      `- The same clauses as the other contractor agreements: independent contractor status, confidentiality and non-solicitation, IP assigned to OASIS on creation, 14 days' notice, governed by the laws of the ${ctx.legal.jurisdiction}.`,
    ),
  );

export const contractorClassificationMemo: DocTemplate = (ctx) =>
  doc(
    header(
      "Contractor classification memo",
      ctx,
      `Why each role at ${ctx.legal.entity} is an independent contractor and not an employee. CC chose contractor-for-all on 2026-08-20; the contractor agreements state it, and this memo records the reasoning for Revenu Quebec and the CRA.`,
    ),
    section(
      "Roles",
      "- Opener, closer, sales manager, builder: commission or per-build, own hours, own tools, invoice OASIS (see their agreements).",
      "- Marketing: no agreement yet.",
    ),
    section(
      "The tests",
      "- Control over how and when the work is done, ownership of tools, chance of profit and risk of loss, and integration into the business.",
      `- The assessment for each role: ${confirm("the accountant's view, role by role")}`,
    ),
    section("Review", `- ${confirm("what change in a role would trigger a new assessment")}`),
  );

// Security and operations -------------------------------------------------------------------

export const incidentResponseRunbook: DocTemplate = (ctx) =>
  doc(
    header("Incident response runbook", ctx, "What happens when something breaks or client data may be exposed."),
    section(
      "Severity",
      "- Severity 1: a client's service is down, or personal information may have been exposed.",
      "- Severity 2: a workflow is degraded, with a workaround.",
      "- Severity 3: cosmetic.",
    ),
    section(
      "Who does what",
      `- Triage: ${confirm("who is paged first, and how")}`,
      `- Talks to the client: ${confirm("who")}`,
      `- Privacy decisions: ${ctx.legal.privacyOfficer.name}, ${ctx.legal.privacyOfficer.titleEn}.`,
    ),
    section(
      "Possible exposure of personal information",
      "1. Contain it first: revoke the key, pause the job, disconnect the account.",
      "2. Record it in the Law 25 incident register the same day, even if it turns out not to be reportable.",
      "3. Assess the risk of serious injury; if it is serious, notify the Commission d'acces a l'information and the people concerned promptly.",
      "4. Tell the affected client, as the client data processing agreement requires.",
    ),
    section("After", `- ${confirm("the post-mortem template and where post-mortems are kept")}`),
  );

export const vendorRegistry: DocTemplate = (ctx) =>
  doc(
    header("Vendor and tool registry", ctx, "Every paid tool OASIS relies on. Processors that receive personal information are also on the sub-processor list."),
    section(
      "Processors (from the privacy policy)",
      "| Vendor | What it does for OASIS | Paid from | Monthly cost | If it disappears |",
      "|---|---|---|---|---|",
      ...ctx.legal.subprocessors.map((s) => `| ${s.name} | ${s.role} | ${confirm("card or account")} | ${confirm("cost")} | ${confirm("impact")} |`),
    ),
    section("Other tools", `- ${confirm("every other paid tool, with the same columns")}`),
  );

// Strategy and brand ------------------------------------------------------------------------

export const okrs: DocTemplate = (ctx) => {
  const g = ctx.goal;
  const kr1 = g.ok
    ? g.value
      ? `- KR1: ${money(g.value.targetCents, g.value.currency)} collected between ${g.value.periodStart} and ${g.value.periodEnd} (${g.value.label}, the active revenue goal; progress is on Today).`
      : `- KR1: ${confirm("the revenue key result (no active revenue goal is recorded)")}`
    : `- KR1: ${confirm(`the revenue key result (${g.why})`)}`;
  return doc(
    header("Quarterly goals (OKRs)", ctx, "At most three objectives, each with measurable key results: a baseline, a target, an owner and a weekly check."),
    section("Objective 1: revenue", kr1, `- KR2: ${confirm("a second key result for this objective")}`),
    section("Objective 2", `- ${confirm("the objective and its key results")}`),
    section("Objective 3", `- ${confirm("the objective and its key results, or remove this section")}`),
  );
};

export const riskRegister: DocTemplate = (ctx) =>
  doc(
    header("Risk register", ctx, "The risks to the business, reviewed every quarter."),
    section(
      "Risks",
      "| Risk | Likelihood | Impact | Owner | Mitigation |",
      "|---|---|---|---|---|",
      ...ctx.legal.subprocessors
        .filter((s) => !s.dpaInPlace)
        .map((s) => `| No data processing agreement with ${s.name} | ${confirm("likelihood")} | ${confirm("impact")} | ${confirm("owner")} | Accept the provider's data processing terms |`),
      `| ${confirm("the other risks (key person, concentration of revenue, platform dependence)")} | | | | |`,
    ),
  );

export const brandSystem: DocTemplate = (ctx) =>
  doc(
    header("Brand system", ctx, `How ${ctx.legal.entity} sounds and looks.`),
    section("Voice", `- ${confirm("tone words, signature phrases, and what OASIS never says (the Marketing brand bible can be imported here once CC consents)")}`),
    section("Visual identity", `- ${confirm("logo files, colours and type")}`),
  );

export const buyerProfile: DocTemplate = (ctx) =>
  doc(
    header("Buyer profile (ICP)", ctx, "Who buys OASIS and why."),
    section("Who", `- ${confirm("the business type, size and the decision-maker")}`),
    section("Trigger and objection", `- ${confirm("what makes them look, and the objection that most often ends the deal")}`),
    section("Where they are found", `- ${confirm("channels, from the funnel data")}`),
  );

export const contentPillars: DocTemplate = (ctx) =>
  doc(
    header("Content pillars", ctx, "The themes every post belongs to."),
    section("Pillars", `- ${confirm("three to five themes, what each is about and why it lands")}`),
    section("Cadence", `- ${confirm("platforms and posts per week for each pillar")}`),
  );

export const funnelMap: DocTemplate = (ctx) =>
  doc(
    header("Funnel map", ctx, "OASIS sells inbound first: leads arrive through the funnel, direct messages and content, are nurtured, and book a call. Cold outreach happens only on demand and with operator approval."),
    section("Stages", `- ${confirm("each stage from first touch to signed client, with the measured conversion over the last 90 days")}`),
    section("Biggest leak", `- ${confirm("the stage with the largest drop, from the data")}`),
  );

export const salesEnablementGuide: DocTemplate = (ctx) =>
  doc(
    header("Sales enablement guide", ctx, "What a rep needs to sell the website offer."),
    section(
      "Where the pieces already live",
      "- The offer and floors: Business documentation > Website offer and price book.",
      "- The call guide: Playbook > Sales Rep Script. Objections: Objections.",
      "- Commission terms: each rep's contractor agreement.",
    ),
    section("Qualification", `- ${confirm("the questions that qualify a lead and the answers that disqualify one")}`),
    section("Owner handoff", `- ${confirm("when a rep hands a deal to CC, and what they send with it")}`),
  );

export const deliveryChecklist: DocTemplate = (ctx) =>
  doc(
    header("Delivery checklist and QA gate", ctx, "What ships at each stage of a website build, and the checks nothing passes without."),
    // The stages Projects actually tracks (lib/delivery/rules.ts), never a
    // list typed here that the product does not use.
    section("Stages", `- ${PROJECT_STAGES.map((s) => PROJECT_STAGE_LABELS[s]).join(", ")} (the stages Projects tracks).`),
    section("Each stage", `- ${confirm("the checklist for each stage")}`),
    section("QA gate", `- ${confirm("the checks a build must pass before the client sees it (forms deliver, mobile layout, analytics, SEO basics)")}`),
  );

export const BUSINESS_TEMPLATES: Readonly<Record<string, DocTemplate>> = {
  "founders-agreement": foundersAgreement,
  "enterprise-registration": enterpriseRegistration,
  insurance,
  "decisions-log": decisionsLog,
  "org-chart": orgChart,
  "quebec-tax-calendar": quebecTaxCalendar,
  "accountant-engagement": accountantEngagement,
  "capital-allocation-policy": capitalAllocationPolicy,
  "contractor-agreement-marketing": marketingContractorAgreement,
  "contractor-classification-memo": contractorClassificationMemo,
  "incident-response-runbook": incidentResponseRunbook,
  "vendor-registry": vendorRegistry,
  okrs,
  "risk-register": riskRegister,
  "brand-system": brandSystem,
  "buyer-profile": buyerProfile,
  "content-pillars": contentPillars,
  "funnel-map": funnelMap,
  "sales-enablement-guide": salesEnablementGuide,
  "delivery-checklist": deliveryChecklist,
};
