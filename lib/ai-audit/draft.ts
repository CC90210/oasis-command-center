/**
 * lib/ai-audit/draft.ts — the first draft of a Free AI Audit and its
 * proposal, built by code from the stored research (lib/ai-audit/research.ts)
 * and the authorized profile. CC reviews and edits every word before Gate 2.
 *
 * What it writes, and from where:
 *   - findings, sources and gaps: the research's own, labels as the evidence
 *     rules decided them; nothing internal reaches the client (no line
 *     numbers, no call quotes, no notes of CC's, no questions written for CC);
 *   - estimates: the calculator's, with CC's current assumption ranges;
 *   - opportunities and the roadmap: lib/ai-audit/opportunities.ts rules;
 *   - every paragraph: fixed wording that states a figure only from a cited
 *     finding or estimate (lib/ai-audit/doc.ts auditDocIssues holds it to
 *     that, and so does the claim check of the model's prose, phase 4b);
 *   - the proposal: one line per catalogue item the opportunities point to,
 *     priced only from a confirmed catalogue version; anything else is a
 *     "needs your price" line. Prices never come from a model.
 *
 * PURE: no I/O.
 */
import {
  AUDIT_DOC_SCHEMA,
  statesFigure,
  type AuditDoc,
  type DocEstimate,
  type DocFinding,
  type DocInefficiency,
  type DocParagraph,
  type DocSource,
  type DocSystem,
} from "@/lib/ai-audit/doc";
import type { BusinessType } from "@/lib/ai-audit/rules";
import type { ResearchPack } from "@/lib/ai-audit/research";
import { planOpportunities, planRoadmap, type PlannedOpportunity } from "@/lib/ai-audit/opportunities";
import { CATALOGUE_SEED, type CatalogueItem } from "@/lib/ai-audit/catalogue";
import {
  AUDIT_LINK_PLACEHOLDER,
  PROPOSAL_SCHEMA,
  itemPriceIn,
  withConfirmedPrice,
  type FxRate,
  type NeedsPriceLine,
  type ProposalContent,
  type ProposalLine,
  type TaxRule,
} from "@/lib/ai-audit/proposal";

export type DraftInputs = {
  business: { name: string; type: BusinessType; location?: string; website?: string };
  contactName: string;
  /** YYYY-MM-DD. */
  today: string;
  pack: ResearchPack;
  /** The calculator's estimates with CC's current ranges (estimateImpact over pack.impact_inputs). */
  estimates: DocEstimate[];
  /** The authorized profile's tools (tech.tools rows): each a name and what it is for. */
  tools: Array<{ name: string; role: string }>;
};

/** Profile groups that are the business's own story; the rest (decision makers, budget) stays internal. */
const CLIENT_FACING_PROFILE = /^f-(?:business|goals|ops|tech|sales)-|^f-finance-(?:staff|kpis)/;

/** The client's version of each likely problem: a short title, what it costs them, and how it would be checked together. */
/** A problem the client named, as section 4 frames it (no figure: the finding carries the client's own words). */
const CLIENT_PROBLEM_COPY: Readonly<Record<string, { title: string; consequence: string }>> = {
  "f-sales-lost-points": { title: "Where customers are lost", consequence: "That is work going to someone else, and it is usually the easiest revenue to win back." },
  "f-ops-delays": { title: "Where work waits", consequence: "Waiting slows cash and leaves customers unsure; most of these steps can be carried by a reminder or an automation." },
  "f-tech-disconnected": { title: "Tools that do not talk to each other", consequence: "The same details are typed again and again, which costs time and lets mistakes in." },
  "f-ops-manual-workflows": { title: "Work done by hand", consequence: "Steps copied by hand take time every week and are where details get lost." },
};

const HYPOTHESIS_COPY: Readonly<Record<string, { title: string; statement: string; consequence: string; test: string }>> = {
  "h-no-own-site": {
    title: "New customers find the business only through platforms it does not control",
    statement: "Without a website of your own, new customers likely find you only through social platforms, listings or referrals.",
    consequence: "A change on any of those platforms can cut off new enquiries overnight.",
    test: "We would look together at where new customers come from and what a search for the business shows.",
  },
  "h-booking-by-hand": {
    title: "Booking takes someone's time and stops after hours",
    statement: "Appointments are likely booked by phone, text or email, which takes someone's time and stops after hours.",
    consequence: "Requests that arrive in the evening or at the weekend wait, and some of those customers book elsewhere.",
    test: "We would look together at how bookings arrive today, who handles them, and what happens to a request at night.",
  },
  "h-no-way-to-ask": {
    title: "Website visitors have no easy way to ask a question",
    statement: "A visitor with a question may have no way to ask it on your site except by phone or email.",
    consequence: "Visitors with a question who will not phone or email simply leave.",
    test: "We would look together at how website enquiries arrive today and who follows them up.",
  },
  "h-unmeasured-visitors": {
    title: "It is hard to know which visitors become customers",
    statement: "It may be hard to tell how many website visitors become enquiries, or which channel brings your best customers.",
    consequence: "Money can go to channels that bring few customers, while the ones that work are not grown.",
    test: "We would look together at how the business knows where its customers come from.",
  },
  "h-phone-unfriendly": {
    title: "The website may be hard to use on a phone",
    statement: "The site may be hard to use on a phone, so some visitors may leave before getting in touch.",
    consequence: "Most visitors arrive on a phone, and some leave before they get in touch.",
    test: "We would look at the site on a phone together and at how enquiries arrive.",
  },
  "h-no-tap-to-call": {
    title: "Calling from the website takes extra steps on a phone",
    statement: "Phone visitors may have to copy your number to call, which can lose some calls.",
    consequence: "Some visitors who were ready to call give up before they do.",
    test: "We would look together at how most new customers first get in touch.",
  },
  "h-not-secure": {
    title: "Browsers warn visitors that the site is not secure",
    statement: "Browsers may mark the site as not secure, which can put some visitors off before they get in touch.",
    consequence: "The warning puts some visitors off before they read anything.",
    test: "We would check the site's security setting with whoever looks after it.",
  },
  "h-chat-without-booking": {
    title: "Chat questions about availability end in a manual back and forth",
    statement: "Questions in the chat about availability likely end in a back and forth to find a time.",
    consequence: "Each one takes someone's time, and slow answers lose bookings.",
    test: "We would look together at the most common chat questions and how they are answered.",
  },
  "h-past-vendor": {
    title: "Past work from a provider did not last",
    statement: "Work from a previous provider did not last, so how a change is handed over and supported may matter as much as the tool.",
    consequence: "Without a clear handover and support, the same thing can happen again.",
    test: "We would agree together how any change is handed over and who looks after it.",
  },
  "h-shelfware": {
    title: "Tools have been paid for that the team does not use",
    statement: "Tools bought before may not be in use, so getting the team to use a tool is likely the real challenge, more than its features.",
    consequence: "Adding another tool will not help unless the team actually uses it.",
    test: "We would look together at which tools are used and why others were dropped.",
  },
  "h-half-built": {
    title: "Something built in-house only half works",
    statement: "Something built in-house may already half work, and could be a starting point rather than something to replace.",
    consequence: "Replacing it outright may throw away what already works.",
    test: "We would look together at what it does well and where it breaks.",
  },
};

/** The client's own sources, one each: the call, the form, and what CC confirmed with them. */
const CLIENT_SOURCES = {
  call: { id: "src-call", kind: "client", title: "Our discovery call with you" },
  form: { id: "src-form", kind: "client", title: "Your answers on the audit form" },
  confirmed: { id: "src-confirmed", kind: "other", title: "Confirmed with you" },
} as const satisfies Record<string, DocSource>;

/** Which of the client's own sources a research source is, or null for a page or a measurement. */
function clientSourceOf(s: ResearchPack["sources"][number]): DocSource | null {
  if (s.url) return null;
  if (s.kind === "other" && s.confirmed_note) return CLIENT_SOURCES.confirmed;
  if (s.kind !== "client" && s.kind !== "other") return null;
  return /audit form/i.test(s.title) ? CLIENT_SOURCES.form : CLIENT_SOURCES.call;
}

/** A page or a measurement as the client may read it. */
function clientSource(s: ResearchPack["sources"][number]): DocSource {
  const host = (() => {
    try {
      return s.url ? new URL(s.url).hostname.replace(/^www\./, "") : undefined;
    } catch {
      return undefined;
    }
  })();
  const title = s.title.replace(/, read by the Command Center$/i, "").slice(0, 200) || host || "Source";
  return {
    id: s.id,
    kind: s.kind,
    title: s.kind === "measurement" && host && s.id.startsWith("s-site") ? `Your website: ${title}` : title,
    ...(host && s.kind !== "measurement" ? { publisher: host } : {}),
    ...(s.url ? { url: s.url } : {}),
    retrieved_at: s.retrieved_at,
    ...(s.published_at ? { published_at: s.published_at } : {}),
  };
}

const lower = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
/** The client's own figures as they would say them; a Map, never an object lookup (review of phase 2b). */
const FIGURE_PHRASES = new Map<string, (v: string) => string>([
  ["f-sales-missed-calls-per-week", (v) => `you miss about ${v} calls a week`],
  ["f-sales-close-rate-pct", (v) => `about ${v}% of your leads become customers`],
  ["f-sales-avg-job-value", (v) => `an average job or order is worth about ${v}`],
  ["f-sales-leads-per-month", (v) => `about ${v} new leads come in each month`],
  ["f-sales-response-time-hours", (v) => `a new lead waits about ${v} hours for a reply`],
  ["f-ops-admin-hours-per-week", (v) => `admin takes about ${v} hours a week`],
  ["f-finance-staff-hourly-cost", (v) => `an hour of staff time costs about ${v}`],
]);

/** A finding's figure as a phrase: "you miss about 10 calls a week", or "missed calls per week: 10" for any other. */
function figurePhrase(f: DocFinding): string | null {
  if (!f.metric) return null;
  const number = f.metric.value.toLocaleString("en-CA");
  const said = FIGURE_PHRASES.get(f.id);
  if (said) return said(f.metric.unit === "$" ? `$${number}` : number);
  const v = f.metric.unit === "$" ? `$${number}` : `${number}${f.metric.unit ? ` ${f.metric.unit}` : ""}`;
  return `${lower(f.title)}: ${v}`;
}

/** A site check's words as the client reads them: our checks, never the Command Center (review of phase 4, N5). */
const clientWording = (text: string) => text.replace(/the Command Center's servers/gi, "our servers").replace(/the Command Center/gi, "our checks");
const joinList = (xs: readonly string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join("; ")}; and ${xs[xs.length - 1]}`);

/**
 * The research's gaps as the client may read them. The research writes them
 * for CC ("No AI-audit form answers are on file", "the web search on the Mac
 * failed"); the client reads what is unknown, never how the Command Center
 * works, nor anything internal (a budget, a decision-maker). One line per
 * kind of gap (review of phase 4, F5).
 */
function clientGaps(gaps: ResearchPack["gaps"]): Array<{ topic: string; why: string }> {
  const out: Array<{ topic: string; why: string }> = [];
  const once = (topic: string, why: string) => {
    if (!out.some((g) => g.topic === topic)) out.push({ topic, why });
  };
  for (const g of gaps) {
    if (/^To estimate this, the audit needs:/i.test(g.why)) {
      out.push({ topic: g.topic, why: g.why.replace(/^To estimate this, the audit needs:/i, "To size this, we would need:") });
    } else if (g.why === "The discovery profile does not have it.") {
      if (!/budget|decision|\(/i.test(g.topic)) out.push({ topic: g.topic, why: "We do not have this yet from our conversation." });
    } else if (g.topic === "Website speed") {
      once("Website speed", "We could not measure how fast your website loads on a phone.");
    } else if (g.topic === "Web search") {
      once("Public listings", "We could not check every public listing and review page for the business.");
    } else if (g.topic === "Website" && /no website is known|not a website/i.test(g.why)) {
      once("Website", "We did not find a website for the business, so none was reviewed.");
    } else if (g.topic === "Website" && !/form answers/i.test(g.why)) {
      once("Website", "Some of your website could not be read, so what those pages show is not in this audit.");
    }
  }
  return out;
}

/** The audit's first draft. Run validateAuditDoc and auditDocIssues on it before it is saved. */
export function draftAuditDoc(input: DraftInputs): { doc: AuditDoc; opportunities: PlannedOpportunity[] } {
  const pack = input.pack;
  const name = input.business.name || "the business";
  // No line numbers, no call quotes, no notes of CC's: the client's own sources collapse into one each.
  const remap = new Map<string, string>();
  const sources: DocSource[] = [];
  const added = new Set<string>();
  for (const s of pack.sources) {
    const own = clientSourceOf(s);
    const out = own ?? clientSource(s);
    remap.set(s.id, out.id);
    if (added.has(out.id)) continue;
    added.add(out.id);
    sources.push(out);
  }
  const sourceIds = new Set(sources.map((s) => s.id));
  const cite = (ids: readonly string[]) => [...new Set(ids.map((id) => remap.get(id) ?? id).filter((id) => sourceIds.has(id)))];
  const estimates: DocEstimate[] = input.estimates.map((e) => ({ ...e, inputs: e.inputs.map((x) => (x.basis && remap.has(x.basis) ? { ...x, basis: remap.get(x.basis) } : x)) }));

  // Findings: the research's, minus what is internal; hypotheses in the client's words.
  const findings: DocFinding[] = [];
  for (const f of pack.findings) {
    const fromProfile = f.source_ids.some((id) => id.startsWith("s-client-"));
    if (fromProfile && f.id.startsWith("f-") && !CLIENT_FACING_PROFILE.test(f.id)) continue;
    const copy = HYPOTHESIS_COPY[f.id];
    // A likely problem reads in the client's words, or stays out: the research writes them for CC ("Ask how ..."),
    // and a page's claim nothing proved is no finding of ours (review of phase 4, F5).
    if (f.label === "hypothesis" && (f.id.startsWith("h-") ? !copy : !fromProfile)) continue;
    findings.push({
      ...f,
      statement: f.label === "hypothesis" && copy ? copy.statement : clientWording(f.statement),
      source_ids: cite(f.source_ids),
      ...(f.label === "hypothesis" ? { how_to_test: copy?.test ?? "We would confirm this with you before any work starts." } : {}),
    });
  }
  const byId = new Map(findings.map((f) => [f.id, f]));
  const tools = input.tools.map((t) => t.name).filter(Boolean);
  const opportunities = planOpportunities({ findings, estimates, tools });

  const clientFigures = findings.filter((f) => f.label === "client_reported" && f.metric).slice(0, 5);
  const measured = findings.filter((f) => f.label === "verified" && (f.id.startsWith("f-site") || f.id.startsWith("f-ps"))).slice(0, 5);
  const fromWeb = findings.filter((f) => f.label === "verified" && f.id.startsWith("f-web")).slice(0, 4);
  const hypotheses = findings.filter((f) => f.label === "hypothesis");

  // What the audit drew on, as it did: never a website review or listings it did not read (review of phase 4, F5).
  const drew: string[] = [];
  if (sources.some((x) => x.id === CLIENT_SOURCES.call.id)) drew.push("our call with you");
  if (sources.some((x) => x.id === CLIENT_SOURCES.form.id)) drew.push("your answers on the audit form");
  if (pack.plan.some((m) => m.module === "site" && (m.status === "done" || m.status === "partial"))) drew.push("a review of your website");
  if (pack.plan.some((m) => m.module === "pagespeed" && m.status === "done")) drew.push("Google's speed test of your home page");
  if (findings.some((x) => x.id.startsWith("f-web") && x.label === "verified")) drew.push("what is publicly listed about the business");
  const overview: DocParagraph[] = [
    {
      text: `This audit looks at how ${name} finds, wins and serves its customers today, and where AI and automation can save time or win back work.${drew.length ? ` It draws on ${drew.length === 1 ? drew[0] : `${drew.slice(0, -1).join(", ")} and ${drew[drew.length - 1]}`}.` : ""}`,
      cites: [],
    },
  ];
  if (opportunities.length) {
    overview.push({
      text: `The clearest opportunities: ${joinList(opportunities.slice(0, 4).map((o) => lower(o.title)))}. Where your figures allow, each is sized as a range under Estimated Business Impact.`,
      cites: [],
    });
  }
  const shownGaps = clientGaps(pack.gaps).filter((g) => !statesFigure(g.topic) && !statesFigure(g.why)).slice(0, 15);
  if (shownGaps.length) overview.push({ text: "Some things could not be checked. They are listed at the end, under what we could not verify, rather than guessed.", cites: [] });

  const assessment: DocParagraph[] = [];
  const said = clientFigures.map(figurePhrase).filter((x): x is string => !!x);
  if (said.length) assessment.push({ text: `What you told us: ${joinList(said)}.`, cites: clientFigures.map((f) => f.id) });
  if (measured.length) assessment.push({ text: `What we found on your website: ${joinList(measured.map((f) => lower(f.statement.replace(/\.$/, ""))))}.`, cites: measured.map((f) => f.id) });
  if (fromWeb.length) assessment.push({ text: `What is publicly listed about the business: ${joinList(fromWeb.map((f) => f.statement.replace(/\.$/, "")))}.`, cites: fromWeb.map((f) => f.id) });
  if (!assessment.length) assessment.push({ text: `This assessment rests on what you told us about ${name}; the findings below list each fact with its label.`, cites: [] });

  const systems: DocSystem[] = input.tools.slice(0, 20).map((t) => {
    const cites = byId.has("f-tech-tools") ? ["f-tech-tools"] : [];
    return { name: t.name.slice(0, 200), role: (t.role || "In use").slice(0, 200), label: "client_reported", cites };
  });

  const inefficiencies: DocInefficiency[] = hypotheses.slice(0, 15).map((h) => {
    const copy = HYPOTHESIS_COPY[h.id];
    return {
      title: copy?.title ?? "A likely problem to confirm",
      why_it_matters: { text: copy?.statement ?? h.statement, cites: [h.id] },
      consequence: { text: copy?.consequence ?? "We would confirm it with you before any work starts.", cites: [h.id] },
      finding_ids: [h.id],
    };
  });

  // The problems the client named on the call are inefficiencies too, after the website's likely ones. Without them
  // a business with no website got section 4 as a bare heading (self-test, 2026-10-27). Their consequence is fixed
  // copy with no figure; the finding itself is the client's words.
  for (const [id, copy] of Object.entries(CLIENT_PROBLEM_COPY)) {
    const f = byId.get(id);
    if (!f || f.label !== "client_reported" || inefficiencies.length >= 15) continue;
    inefficiencies.push({ title: copy.title, why_it_matters: { text: f.statement, cites: [f.id] }, consequence: { text: copy.consequence, cites: [f.id] }, finding_ids: [f.id] });
  }

  const keyFindings = [...measured, ...fromWeb, ...clientFigures, ...findings.filter((f) => f.label !== "hypothesis" && !measured.includes(f) && !fromWeb.includes(f) && !clientFigures.includes(f))]
    .slice(0, 15)
    .map((f) => f.id);

  // A gap the client reads names what is unknown, in words written for the client, never a figure.
  const gaps = shownGaps;

  const doc: AuditDoc = {
    schema: AUDIT_DOC_SCHEMA,
    business: input.business,
    prepared_for: { name: input.contactName || name },
    prepared_on: input.today,
    sections: {
      executive_overview: { paragraphs: overview },
      current_assessment: { paragraphs: assessment, systems },
      key_findings: {
        intro: {
          text: "Every finding carries one label: Verified fact (we checked it, or it is publicly stated where we cite), Client-reported (you told us), or Hypothesis (likely, to confirm with you).",
          cites: [],
        },
        finding_ids: keyFindings,
      },
      inefficiencies: { items: inefficiencies },
      opportunities: {
        items: opportunities.map(({ sku: _sku, impact: _impact, effort: _effort, urgency: _urgency, ...o }) => o),
      },
      roadmap: planRoadmap(opportunities),
      impact: {
        intro: { text: "Each estimate is a range, worked out from the figures you gave us and the assumptions listed with it.", cites: [] },
        estimate_ids: estimates.map((e) => e.id),
        limitations: estimates.length
          ? [
              "These are ranges, not promises: real results depend on how the changes are used.",
              "Each range rests on the figures you gave us; where a figure changes, so does the range.",
              "Nothing here counts costs you would pay others, such as software subscriptions.",
            ]
          : [],
      },
      next_steps: {
        steps: [
          "Read the proposal above: what we would build first, and what it costs.",
          "Pay securely through Stripe to start. Work begins once Stripe confirms the payment.",
          "We book a kickoff call and send a short form for what the work needs.",
          "Access to your tools is granted through secure connections, never by sharing a password.",
        ],
      },
    },
    findings,
    estimates,
    sources,
    gaps,
  };
  return { doc, opportunities };
}

/** A date plus some days, as YYYY-MM-DD. */
function plusDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The proposal's first draft: one line per catalogue item the opportunities
 * point to, in roadmap order. A line is priced only from a confirmed
 * catalogue version in the proposal's currency; otherwise it is a "needs
 * your price" line, and the proposal cannot be submitted until CC prices it.
 */
export function draftProposal(input: {
  opportunities: readonly PlannedOpportunity[];
  roadmap: AuditDoc["sections"]["roadmap"];
  confirmed: readonly CatalogueItem[];
  currency: "CAD" | "USD";
  /** CC's rate: an item in the other currency is priced converted at it (USD core, CAD on request). */
  fx: FxRate | null;
  tax: TaxRule | null;
  depositBps: number | null;
  to: string;
  businessName: string;
  contactName: string;
  today: string;
}): ProposalContent {
  const lines: ProposalLine[] = [];
  const lineOfSku = new Map<string, string>();
  for (const o of input.opportunities) {
    if (lineOfSku.has(o.sku)) continue;
    const lineId = `l-${o.sku}`.slice(0, 32).replace(/-+$/, "");
    lineOfSku.set(o.sku, lineId);
    // The SKU's confirmed version, in the proposal's currency or convertible into it at CC's rate.
    const item = input.confirmed
      .filter((i) => i.sku === o.sku && i.status === "confirmed" && i.price_cents !== null && itemPriceIn(i, input.currency, input.fx) !== null)
      .sort((a, b) => (a.currency === input.currency ? 0 : 1) - (b.currency === input.currency ? 0 : 1) || b.item_version - a.item_version)[0];
    const price = item ? itemPriceIn(item, input.currency, input.fx) : null;
    const seed = CATALOGUE_SEED.find((s) => s.sku === o.sku);
    const base = {
      line_id: lineId,
      name: (item?.name ?? seed?.name ?? o.title).slice(0, 200),
      description: (item?.description ?? seed?.description ?? o.what_it_does).slice(0, 2_000),
      category: item?.category ?? seed?.category ?? "implementation",
      unit: item?.unit ?? seed?.unit ?? "fixed",
      ...((item?.unit_label ?? seed?.unit_label) ? { unit_label: item?.unit_label ?? seed?.unit_label } : {}),
      quantity: 1,
      optional: false,
      deliverables: [...(item?.deliverables ?? seed?.deliverables ?? [])],
      onboarding_requirements: [...(item?.onboarding_requirements ?? seed?.onboarding_requirements ?? [])],
    };
    if (item && price) {
      lines.push(withConfirmedPrice({ ...base, kind: "needs_owner_price" }, item, price, input.currency));
    } else {
      const needs: NeedsPriceLine = { ...base, kind: "needs_owner_price", suggested_sku: o.sku };
      lines.push(needs);
    }
  }
  const skuOf = new Map(input.opportunities.map((o) => [o.id, o.sku]));
  const phase = (key: "now" | "next" | "later", label: string, description: string) => {
    const ids = [...new Set(input.roadmap[key].map((r) => lineOfSku.get(skuOf.get(r.opportunity_id) ?? "")).filter((x): x is string => !!x))];
    return ids.length ? [{ name: label, description, line_ids: ids }] : [];
  };
  const seen = new Set<string>();
  const phases = [
    ...phase("now", "Start now", "The changes that pay back first, for the least effort."),
    ...phase("next", "Next", "The changes that build on the first ones."),
    ...phase("later", "Later", "Worth doing once the first changes are working."),
  ]
    .map((p) => ({ ...p, line_ids: p.line_ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true))) }))
    .filter((p) => p.line_ids.length);
  const greeting = input.contactName ? `Hi ${input.contactName.split(/\s+/)[0]},` : "Hi,";
  return {
    schema: PROPOSAL_SCHEMA,
    currency: input.currency,
    lines,
    phases,
    payment_terms: input.depositBps ? { kind: "deposit", deposit_bps: input.depositBps, balance_due: "On launch" } : { kind: "full" },
    tax: input.tax,
    exclusions: ["Software subscriptions the business pays for directly, such as its phone, calendar or booking tools", "Work not listed in this proposal"],
    terms: ["Work starts once Stripe confirms the payment.", "Access to your tools is granted through secure connections, never by sharing a password."],
    valid_until: plusDays(input.today, 30),
    delivery_email: {
      to: input.to,
      subject: `Your free AI audit for ${input.businessName}`.slice(0, 200),
      body: `${greeting}\n\nThank you for walking me through ${input.businessName}. Your free AI audit is ready. It covers what we found, why it matters, and what we would build, with a proposal at the end.\n\n${AUDIT_LINK_PLACEHOLDER}\n\nThe link is private to you. Take your time with it, and reply here with any questions.`,
    },
  };
}
