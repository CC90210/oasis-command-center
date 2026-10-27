/**
 * lib/ai-audit/opportunities.ts — what the research points to, as AI and
 * automation opportunities for the audit's section 5, the roadmap's order,
 * and the catalogue items a proposal may start from.
 *
 * Code decides, never a model: each opportunity has a rule over the
 * research's own findings and estimates (lib/ai-audit/research.ts), names the
 * findings and estimates it rests on, and carries fixed wording with no
 * figure in it. The only figures an opportunity shows are its estimates'
 * ranges, in its cited "expected improvement".
 *
 * PURE: no I/O.
 */
import type { DocEstimate, DocFinding, DocOpportunity, DocParagraph, DocRoadmapItem, ImpactLevel } from "@/lib/ai-audit/doc";

/** A rule's view of the research: findings and estimates by id. */
export type OpportunityInputs = { findings: readonly DocFinding[]; estimates: readonly DocEstimate[]; tools: readonly string[] };

type Rule = {
  id: string;
  title: string;
  what_it_does: string;
  problem: string;
  how_it_works: string;
  /** Always part of it; the client's own tools are added. */
  integrations: string[];
  workflow: { before: string[]; after: string[] };
  impact: ImpactLevel;
  effort: ImpactLevel;
  urgency: string;
  /** The catalogue item a proposal starts from (a suggestion: CC prices and confirms). */
  sku: string;
  /** The findings that show the problem, and the estimates that size it. */
  findings: (x: OpportunityInputs) => string[];
  estimates: (x: OpportunityInputs) => string[];
  /** Said when no estimate sizes it: what it changes, with no figure. */
  plain_improvement: string;
};

const has = (x: OpportunityInputs, id: string) => x.findings.some((f) => f.id === id);
const hasEstimate = (x: OpportunityInputs, id: string) => x.estimates.some((e) => e.id === id);
const findingIds = (x: OpportunityInputs, ids: readonly string[]) => ids.filter((id) => has(x, id));
const metric = (x: OpportunityInputs, id: string) => x.findings.find((f) => f.id === id)?.metric?.value ?? null;

/** Findings ids as lib/ai-audit/research.ts names them: fid("f", field key), fid("f-site", check), fid("h", rule). */
export const F = {
  missedCalls: "f-sales-missed-calls-per-week",
  responseTime: "f-sales-response-time-hours",
  leads: "f-sales-leads-per-month",
  leadSources: "f-sales-lead-sources",
  adminHours: "f-ops-admin-hours-per-week",
  repetitiveTasks: "f-ops-repetitive-tasks",
  manualWorkflows: "f-ops-manual-workflows",
  disconnected: "f-tech-disconnected",
  speed: "f-ps-performance",
  lcp: "f-ps-lcp",
} as const;

const RULES: readonly Rule[] = [
  {
    id: "answer-missed-calls",
    title: "Answer every missed call within minutes",
    what_it_does: "When a call goes unanswered, the caller gets a text back within a minute that answers common questions and offers a time to talk or book.",
    problem: "A caller who reaches voicemail often tries the next business on the list before anyone calls back.",
    how_it_works: "Missed calls are passed to an assistant that texts the caller, answers the usual questions in your words, and books a time on your calendar. You see every conversation and can take over at any point.",
    integrations: ["Your phone line", "Your calendar"],
    workflow: {
      before: ["A call goes to voicemail", "The caller waits, or calls someone else", "Someone calls back hours later"],
      after: ["A call goes unanswered", "The caller gets a text within a minute", "They pick a time to talk or book", "You see the booking and the conversation"],
    },
    impact: "high",
    effort: "low",
    urgency: "Every missed call today is work that may go to a competitor.",
    sku: "checkout-sales-setter-launch",
    findings: (x) => findingIds(x, [F.missedCalls]),
    estimates: (x) => (hasEstimate(x, "est-missed-calls") ? ["est-missed-calls"] : []),
    plain_improvement: "Callers who would have reached voicemail hear back at once, so fewer of them go elsewhere.",
  },
  {
    id: "fast-lead-replies",
    title: "Reply to every new enquiry within minutes",
    what_it_does: "New enquiries from the website, email and listings get a helpful first reply within minutes, day or night, and a way to book.",
    problem: "Enquiries that wait hours for a first reply go cold, and the first business to answer often wins the work.",
    how_it_works: "Each new enquiry is read as it arrives, answered in your words with the next step, and passed to you with its details. Nothing is promised that you have not approved.",
    integrations: ["Your website forms", "Your email"],
    workflow: {
      before: ["An enquiry arrives", "It waits until someone is free", "The reply goes out hours later"],
      after: ["An enquiry arrives", "A first reply goes out within minutes", "The enquirer books or asks their question", "You pick it up with the details in front of you"],
    },
    impact: "high",
    effort: "low",
    urgency: "Slow first replies cost work every day they continue.",
    sku: "checkout-sales-setter-launch",
    findings: (x) => findingIds(x, [F.responseTime, F.leads]),
    estimates: (x) => (hasEstimate(x, "est-fast-replies") ? ["est-fast-replies"] : []),
    plain_improvement: "Enquirers hear back while they are still choosing, so more of them become customers.",
  },
  {
    id: "admin-automation",
    title: "Take repetitive admin off the team",
    what_it_does: "The repetitive steps behind each job (copying details between tools, chasing confirmations, sending reminders) happen by themselves.",
    problem: "Hours go into admin that follows the same steps every time, and that time is not spent on paying work.",
    how_it_works: "We map the steps your team repeats, then automate the ones that need no judgement. People keep the decisions and the exceptions.",
    integrations: [],
    workflow: {
      before: ["A job comes in", "Someone re-types its details into each tool", "Someone chases the customer for answers", "Reminders go out by hand, when someone remembers"],
      after: ["A job comes in", "Its details reach every tool once", "Customers get confirmations and reminders by themselves", "The team handles only what needs a person"],
    },
    impact: "medium",
    effort: "medium",
    urgency: "Admin time compounds as the business grows.",
    sku: "fleet-custom-integration",
    findings: (x) => findingIds(x, [F.adminHours, F.repetitiveTasks, F.manualWorkflows]),
    estimates: (x) => ["est-admin-hours", "est-admin-cost"].filter((id) => hasEstimate(x, id)),
    plain_improvement: "The team spends less time on repeated steps and more on the work customers pay for.",
  },
  {
    id: "connect-systems",
    title: "Connect the tools that do not talk to each other",
    what_it_does: "Information entered once in one tool appears in the others, so nothing is typed twice and nothing falls between them.",
    problem: "Tools that do not share information mean double entry, mistakes, and nobody seeing the whole picture.",
    how_it_works: "We connect the tools you already use through their own secure connections, so each one keeps doing its job and they stay in step.",
    integrations: [],
    workflow: {
      before: ["Details are typed into one tool", "Then typed again into the next", "Numbers disagree between them"],
      after: ["Details are entered once", "Every tool updates by itself", "Everyone sees the same, current picture"],
    },
    impact: "medium",
    effort: "medium",
    urgency: "Every week of double entry adds to the mistakes to untangle later.",
    sku: "fleet-custom-integration",
    findings: (x) => findingIds(x, [F.disconnected]),
    estimates: () => [],
    plain_improvement: "Less double entry, fewer mistakes, and one picture of the business everyone can trust.",
  },
  {
    id: "online-booking",
    title: "Let customers book online, any time",
    what_it_does: "Customers choose a time themselves from your real availability, on the website or from a message, and get a confirmation and a reminder.",
    problem: "Booking by phone, text or email takes someone's time and stops when the business is closed.",
    how_it_works: "A booking page connected to your calendar offers only the times you choose, and every booking lands in your calendar with the customer's details.",
    integrations: ["Your calendar", "Your website"],
    workflow: {
      before: ["A customer asks for a time", "Messages go back and forth", "Someone enters the booking by hand"],
      after: ["A customer picks a time online", "They get a confirmation and a reminder", "The booking is already in your calendar"],
    },
    impact: "medium",
    effort: "low",
    urgency: "Customers who cannot book after hours often book elsewhere.",
    sku: "checkout-conversion-sprint-focused",
    findings: (x) => findingIds(x, ["h-booking-by-hand", "h-chat-without-booking"]),
    estimates: () => [],
    plain_improvement: "Bookings arrive without anyone's time, including when the business is closed.",
  },
  {
    id: "website-enquiries",
    title: "Make it easy to get in touch from the website",
    what_it_does: "Every visitor, especially on a phone, can call in one tap or send a question in seconds, and every question reaches you.",
    problem: "When getting in touch takes effort, some visitors leave without asking.",
    how_it_works: "We add tap-to-call and a short enquiry form where visitors look for them, make the pages comfortable on a phone, and send every enquiry to one place you check.",
    integrations: ["Your website", "Your email"],
    workflow: {
      before: ["A visitor has a question", "They hunt for a number or an address", "Some give up and leave"],
      after: ["A visitor has a question", "They tap to call or send it in seconds", "It reaches you with their details"],
    },
    impact: "medium",
    effort: "low",
    urgency: "Visitors who cannot reach you easily leave for a competitor's site.",
    sku: "checkout-conversion-sprint-focused",
    findings: (x) => findingIds(x, ["h-no-way-to-ask", "h-no-tap-to-call", "h-phone-unfriendly"]),
    estimates: () => [],
    plain_improvement: "More of the visitors who are ready to talk actually get in touch.",
  },
  {
    id: "website-speed",
    title: "A faster website on phones",
    what_it_does: "Pages appear quickly on a phone, so visitors see what you offer before they lose patience.",
    problem: "A slow page on a phone loses visitors before they read anything.",
    how_it_works: "We fix what slows the pages down (heavy images, scripts that load first, slow hosting) and check the result with Google's own measurement.",
    integrations: ["Your website"],
    workflow: {
      before: ["A visitor opens the page on a phone", "It loads slowly", "Some leave before it appears"],
      after: ["A visitor opens the page on a phone", "It appears quickly", "They read on and get in touch"],
    },
    impact: "medium",
    effort: "medium",
    urgency: "Search engines also favour faster pages.",
    sku: "checkout-conversion-sprint-focused",
    findings: (x) => {
      const slow = (metric(x, F.speed) ?? 100) < 50 || (metric(x, F.lcp) ?? 0) > 4;
      return slow ? findingIds(x, [F.speed, F.lcp]) : [];
    },
    estimates: () => [],
    plain_improvement: "Fewer visitors leave before the page appears.",
  },
  {
    id: "measure-website",
    title: "Know which visitors become customers",
    what_it_does: "You can see how many visitors come, where from, and which of them get in touch or book.",
    problem: "Without measurement it is hard to know which channels bring good customers and which cost money for nothing.",
    how_it_works: "We add privacy-respecting measurement to the site and a simple monthly view of visits, enquiries and bookings by channel.",
    integrations: ["Your website"],
    workflow: {
      before: ["Visitors arrive from many places", "Nobody knows which ones turn into customers"],
      after: ["Visitors arrive from many places", "Each enquiry shows where it came from", "You spend on the channels that work"],
    },
    impact: "low",
    effort: "low",
    urgency: "Every month unmeasured is a month of decisions made blind.",
    sku: "checkout-conversion-sprint-focused",
    findings: (x) => findingIds(x, ["h-unmeasured-visitors"]),
    estimates: () => [],
    plain_improvement: "Decisions about where to spend rest on what visitors actually do.",
  },
  {
    id: "secure-site",
    title: "Remove the browser's security warning",
    what_it_does: "The site loads securely, so browsers stop warning visitors away.",
    problem: "A security warning puts some visitors off before they read anything.",
    how_it_works: "We put the whole site on a secure connection and send every old address to its secure version.",
    integrations: ["Your website"],
    workflow: {
      before: ["A visitor opens the site", "The browser warns it is not secure", "Some leave at once"],
      after: ["A visitor opens the site", "It loads securely, with no warning"],
    },
    impact: "medium",
    effort: "low",
    urgency: "The warning shows to every visitor until it is fixed.",
    sku: "checkout-conversion-sprint-focused",
    findings: (x) => findingIds(x, ["h-not-secure"]),
    estimates: () => [],
    plain_improvement: "Visitors stop seeing a warning before they see the business.",
  },
  {
    id: "own-website",
    title: "A website of your own that brings enquiries",
    what_it_does: "A fast, phone-friendly website that explains what you do, shows your work, and turns visitors into enquiries and bookings.",
    problem: "Without a website of its own, the business depends on platforms and referrals it does not control.",
    how_it_works: "We build a simple site around your services and service area, with tap-to-call, an enquiry form and booking where it fits, and connect it to your tools.",
    integrations: ["Your email", "Your calendar"],
    workflow: {
      before: ["Someone searches for the business", "They find only a social page or a listing", "Some cannot find what they need"],
      after: ["Someone searches for the business", "They find its own site", "They call, ask or book from it"],
    },
    impact: "high",
    effort: "medium",
    urgency: "A website keeps working for the business while it is closed.",
    sku: "website-starter",
    findings: (x) => findingIds(x, ["h-no-own-site"]),
    estimates: () => [],
    plain_improvement: "New customers can find the business on its own terms, and reach it at any hour.",
  },
];

export type PlannedOpportunity = DocOpportunity & { sku: string; impact: ImpactLevel; effort: ImpactLevel; urgency: string };

/** Each opportunity's catalogue item, by the opportunity's id (a Map: an id CC typed is never an object's own key). */
export const OPPORTUNITY_SKU: ReadonlyMap<string, string> = new Map(RULES.map((r) => [r.id, r.sku]));

/** A range as the audit prints it: money to the dollar, hours to the half hour. */
export function rangeWords(e: DocEstimate): string {
  const one = (n: number) => (e.unit === "$" ? `$${Math.round(n).toLocaleString("en-CA")}` : `${n.toLocaleString("en-CA", { maximumFractionDigits: 1 })} ${e.unit}`);
  return `${one(e.low)} to ${one(e.high)}${e.period ? ` ${e.period}` : ""}`;
}

/**
 * The AI sales setter's tier, by the catalogue's own words (lib/ai-audit/catalogue.ts): launch is "one lead source",
 * scale is "multi-source intake", so two or more sources the client named draft the scale tier. The complete tier
 * has no rule a figure can meet, so it is CC's choice on the draft, never the code's.
 */
export function setterSku(x: OpportunityInputs): string {
  const named = x.findings.find((f) => f.id === F.leadSources);
  const said = named && named.statement.includes(": ") ? named.statement.slice(named.statement.indexOf(": ") + 2) : "";
  const sources = said.split(/;\s*/).filter((s) => s.trim().replace(/\.$/, "")).length;
  return sources >= 2 ? "checkout-sales-setter-scale" : "checkout-sales-setter-launch";
}

/** Every opportunity the research supports, most valuable first, each citing what it rests on. */
export function planOpportunities(x: OpportunityInputs): PlannedOpportunity[] {
  // Most impact first; among equals, the least effort first.
  const impactOrder: Record<ImpactLevel, number> = { high: 0, medium: 1, low: 2 };
  const effortOrder: Record<ImpactLevel, number> = { low: 0, medium: 1, high: 2 };
  const out: PlannedOpportunity[] = [];
  for (const r of RULES) {
    const finding_ids = r.findings(x);
    const estimate_ids = r.estimates(x);
    if (!finding_ids.length && !estimate_ids.length) continue;
    const ests = estimate_ids.map((id) => x.estimates.find((e) => e.id === id)).filter((e): e is DocEstimate => !!e);
    const expected_improvement: DocParagraph = ests.length
      ? { text: `Our estimate, from the figures you gave us: ${ests.map((e) => `${e.title.toLowerCase()}, ${rangeWords(e)}`).join("; ")}.`, cites: ests.map((e) => e.id) }
      : { text: r.plain_improvement, cites: finding_ids.slice(0, 1) };
    out.push({
      id: r.id,
      title: r.title,
      what_it_does: r.what_it_does,
      problem: r.problem,
      how_it_works: r.how_it_works,
      integrations: [...new Set([...r.integrations, ...x.tools])].slice(0, 8),
      expected_improvement,
      finding_ids,
      estimate_ids,
      workflow: r.workflow,
      sku: r.sku === "checkout-sales-setter-launch" ? setterSku(x) : r.sku,
      impact: r.impact,
      effort: r.effort,
      urgency: r.urgency,
    });
  }
  return out.sort((a, b) => impactOrder[a.impact] - impactOrder[b.impact] || effortOrder[a.effort] - effortOrder[b.effort]).slice(0, 12);
}

/**
 * The roadmap: high impact for little effort now; high impact for more
 * effort, or medium for little, next; the rest later. Dependencies are the
 * opportunities that should land first (a website before its booking page).
 */
export function planRoadmap(opps: readonly PlannedOpportunity[]): { now: DocRoadmapItem[]; next: DocRoadmapItem[]; later: DocRoadmapItem[] } {
  const ids = new Set(opps.map((o) => o.id));
  const titles = new Map(opps.map((o) => [o.id, o.title]));
  const deps = (o: PlannedOpportunity): string[] => {
    const d: string[] = [];
    if (o.id !== "own-website" && ids.has("own-website") && ["online-booking", "website-enquiries", "website-speed", "measure-website", "secure-site"].includes(o.id)) d.push(titles.get("own-website") as string);
    if (o.id === "admin-automation" && ids.has("connect-systems")) d.push(titles.get("connect-systems") as string);
    return d;
  };
  const depIds = (o: PlannedOpportunity): string[] => {
    const d: string[] = [];
    if (o.id !== "own-website" && ids.has("own-website") && ["online-booking", "website-enquiries", "website-speed", "measure-website", "secure-site"].includes(o.id)) d.push("own-website");
    if (o.id === "admin-automation" && ids.has("connect-systems")) d.push("connect-systems");
    return d;
  };
  // 0 now, 1 next, 2 later, by impact and effort.
  const phase = new Map<string, number>();
  for (const o of opps) phase.set(o.id, depIds(o).length === 0 && o.impact === "high" && o.effort === "low" ? 0 : o.impact === "high" || (o.impact === "medium" && o.effort === "low") ? 1 : 2);
  // Something always starts now: the first of "next" with nothing to wait for moves up when nothing qualified.
  if (![...phase.values()].includes(0)) {
    const up = opps.find((o) => phase.get(o.id) === 1 && depIds(o).length === 0);
    if (up) phase.set(up.id, 0);
  }
  // A step never comes before what it depends on: it moves to its dependency's phase, or later (review of phase 4, F6).
  for (let moved = true; moved; ) {
    moved = false;
    for (const o of opps) {
      for (const d of depIds(o)) {
        if ((phase.get(o.id) ?? 2) < (phase.get(d) ?? 0)) {
          phase.set(o.id, phase.get(d) ?? 0);
          moved = true;
        }
      }
    }
  }
  // Within a phase, what others depend on comes first; otherwise the opportunities' own order.
  const rank = (o: PlannedOpportunity) => opps.indexOf(o) - (opps.some((x) => depIds(x).includes(o.id)) ? opps.length : 0);
  const out = { now: [] as DocRoadmapItem[], next: [] as DocRoadmapItem[], later: [] as DocRoadmapItem[] };
  for (const o of [...opps].sort((a, b) => rank(a) - rank(b))) {
    const item: DocRoadmapItem = { opportunity_id: o.id, impact: o.impact, effort: o.effort, dependencies: deps(o), urgency: o.urgency };
    (phase.get(o.id) === 0 ? out.now : phase.get(o.id) === 1 ? out.next : out.later).push(item);
  }
  return out;
}
