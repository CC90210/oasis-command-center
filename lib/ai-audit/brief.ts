/**
 * lib/ai-audit/brief.ts — the pre-call research brief, put together by code.
 *
 * What CC reads before the discovery call: what the client said on the
 * AI-audit form, what their website shows (lib/ai-audit/site-checks.ts), the
 * likely problems to test on the call, the facts to confirm, and which
 * questions to spend time on. No AI writes any of it.
 *
 * The labels follow the audit's evidence rules:
 *   - Verified: our own measurement of the website, with the page and date;
 *   - Client-reported: an answer on the form, in the client's words or option;
 *   - Hypothesis: a likely problem, with how to test it on the call. A
 *     hypothesis carries no number of its own (a test pins this).
 * Nothing here is a finding of the audit yet: the audit's findings come from
 * the call and from research after Gate 1.
 *
 * Internal only. The client never sees a brief.
 *
 * PURE.
 */
import { AI_AUDIT_STEPS } from "@/lib/forms/oasis-ai-audit-seed";
import { DISCOVERY_QUESTIONS } from "@/lib/ai-audit/framework";
import type { BusinessType } from "@/lib/ai-audit/rules";
import { CHECK_TITLES, type CheckKey, type SiteCheck } from "@/lib/ai-audit/site-checks";
import type { SiteTarget } from "@/lib/ai-audit/site-url";

export const BRIEF_SCHEMA = "ai_audit_brief/v1" as const;

export type BriefFact = {
  id: string;
  statement: string;
  label: "verified" | "client_reported";
  source: { kind: "site"; check: CheckKey; url: string | null } | { kind: "form"; field: string };
};

export type BriefHypothesis = {
  id: string;
  statement: string;
  /** How to test it on the call. */
  test: string;
  /** Framework questions that test it. */
  questions: string[];
};

export type PreCallBrief = {
  schema: typeof BRIEF_SCHEMA;
  built_at: string;
  business_name: string;
  site: { kind: "site" | "social" | "none"; url: string | null; platform: string | null; pages_read: number };
  facts: BriefFact[];
  hypotheses: BriefHypothesis[];
  /** Facts from the form to confirm in the client's words, with the question that does it. */
  confirm: Array<{ statement: string; question_id: string }>;
  /** Questions to spend time on, and why. */
  weight: Array<{ question_id: string; why: string }>;
  /** What could not be checked or is missing, so nobody fills it in by guessing. */
  gaps: string[];
};

const QUESTION_IDS = new Set(DISCOVERY_QUESTIONS.map((q) => q.id));
const FORM_FIELDS = new Map(AI_AUDIT_STEPS.flatMap((s) => s.fields).map((f) => [f.name, f]));

/** Form answers worth a line in the brief, in the order CC reads them; contact details are on the lead already. */
const FORM_ORDER = ["automation_goal", "bottleneck_detail", "tried_before", "current_tools", "team_size", "monthly_revenue", "budget", "timeframe", "wants_call"] as const;

/** Which call question confirms each form answer. */
const CONFIRM_WITH: Readonly<Record<string, string>> = {
  automation_goal: "dec-first-fix",
  bottleneck_detail: "ops-repetitive",
  tried_before: "dec-past",
  current_tools: "tech-tools",
  team_size: "biz-size",
  monthly_revenue: "biz-services",
  budget: "dec-budget",
  timeframe: "dec-who",
};

/** The questions to weight for what the client most wants taken off their plate. */
const GOAL_WEIGHT: Readonly<Record<string, readonly string[]>> = {
  sales_leadgen: ["sales-sources", "sales-handling", "sales-conversion", "sales-lost"],
  customer_support: ["ops-repetitive", "sales-handling", "tech-frustrations"],
  workflow_automation: ["ops-manual", "ops-delays", "tech-silos"],
  agent_fleet: ["dec-first-fix", "ops-repetitive", "tech-tools"],
};

function answerText(field: string, raw: unknown): string | null {
  const def = FORM_FIELDS.get(field);
  const values = Array.isArray(raw) ? raw : [raw];
  const words = values
    .map((v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : ""))
    .filter(Boolean)
    .map((v) => def?.options?.find((o) => o.value === v)?.label ?? v);
  const text = words.join(", ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 400) : null;
}

function fieldLabel(field: string): string {
  return (FORM_FIELDS.get(field)?.label ?? field.replace(/_/g, " ")).replace(/\?$/, "");
}

type Rule = { id: string; when: (c: Map<CheckKey, SiteCheck>, ctx: { type: BusinessType | null; form: Record<string, unknown> | null; site: SiteTarget["kind"] }) => boolean } & Omit<BriefHypothesis, "id">;

const yes = (c: Map<CheckKey, SiteCheck>, k: CheckKey) => c.get(k)?.status === "yes";
const no = (c: Map<CheckKey, SiteCheck>, k: CheckKey) => c.get(k)?.status === "no";
const serviceLike = (t: BusinessType | null) => t === null || t === "local_service" || t === "professional_services";

/** Likely problems: each needs evidence from the checks or the form, carries no number, and says how to test it. */
const RULES: readonly Rule[] = [
  {
    id: "no-own-site",
    when: (_c, ctx) => ctx.site !== "site",
    statement: "Without a website of their own, new customers probably find them through social platforms, listings or referrals only.",
    test: "Ask where new customers find them, and what happens when someone searches for the business by name.",
    questions: ["sales-sources", "biz-goals"],
  },
  {
    id: "booking-by-hand",
    when: (c, ctx) => no(c, "online_booking") && serviceLike(ctx.type),
    statement: "Appointments are probably booked by phone, text or email, which takes someone's time and stops after hours.",
    test: "Ask how a new customer books today, who answers, and what happens to a request that comes in at night.",
    questions: ["ops-manual", "sales-handling"],
  },
  {
    id: "no-way-to-ask",
    when: (c) => no(c, "contact_form") && no(c, "live_chat"),
    statement: "A visitor with a question has no way to ask it on the site except by phone or email.",
    test: "Ask how website enquiries arrive and who follows them up.",
    questions: ["sales-sources", "sales-handling"],
  },
  {
    id: "unmeasured-visitors",
    when: (c) => no(c, "analytics"),
    statement: "They may not know how many website visitors become enquiries, or which channel brings the best customers.",
    test: "Ask how they know where their customers come from.",
    questions: ["sales-sources", "fin-kpis"],
  },
  {
    id: "phone-unfriendly",
    when: (c) => no(c, "mobile_viewport"),
    statement: "The site may be hard to use on a phone, so some visitors may leave before getting in touch.",
    test: "Look at the site on a phone together, and ask how most enquiries arrive.",
    questions: ["sales-sources"],
  },
  {
    id: "no-tap-to-call",
    when: (c, ctx) => no(c, "click_to_call") && ctx.type !== "ecommerce" && ctx.type !== "individual_productivity",
    statement: "Phone visitors have to copy the number to call, which can lose some calls.",
    test: "Ask how most new customers first get in touch.",
    questions: ["sales-sources", "sales-lost"],
  },
  {
    id: "not-secure",
    when: (c) => no(c, "https"),
    statement: "Browsers mark the site as not secure, which can put some visitors off before they get in touch.",
    test: "Ask who looks after the website and whether anyone has mentioned a warning.",
    questions: ["tech-tools"],
  },
  {
    id: "chat-without-booking",
    when: (c, ctx) => yes(c, "live_chat") && no(c, "online_booking") && serviceLike(ctx.type),
    statement: "Chat questions about availability probably end in a manual back and forth to find a time.",
    test: "Ask what the most common chat question is and how it gets answered.",
    questions: ["ops-repetitive", "sales-handling"],
  },
  {
    id: "past-vendor",
    when: (_c, ctx) => ctx.form?.tried_before === "hired",
    statement: "Work from a previous provider did not last, so how a change is handed over and supported will matter as much as the tool.",
    test: "Ask what went wrong last time, and who looked after it once it was set up.",
    questions: ["dec-past", "dec-who"],
  },
  {
    id: "shelfware",
    when: (_c, ctx) => ctx.form?.tried_before === "tools",
    statement: "They have paid for tools nobody uses, so getting the team to use something is likely the real problem, not features.",
    test: "Ask which tools they bought and why the team stopped using them.",
    questions: ["dec-past", "tech-tools", "tech-frustrations"],
  },
  {
    id: "half-built",
    when: (_c, ctx) => ctx.form?.tried_before === "diy",
    statement: "Something they built themselves half-works; it may be a starting point rather than something to replace.",
    test: "Ask what they built, what it does well, and where it breaks.",
    questions: ["dec-past", "tech-tools"],
  },
];

export function assembleBrief(input: {
  builtAt: string;
  business: { name: string; type: BusinessType | null };
  form: { answers: Record<string, unknown>; at: string | null } | null;
  site: { target: SiteTarget; checks: SiteCheck[]; pagesRead: number; notes: string[] } ;
}): PreCallBrief {
  const facts: BriefFact[] = [];
  const confirm: PreCallBrief["confirm"] = [];
  const gaps: string[] = [];
  const checks = new Map(input.site.checks.map((c) => [c.key, c]));

  // What the website shows: our own measurement.
  const t = input.site.target;
  if (t.kind === "site") {
    for (const c of input.site.checks) {
      if (c.status === "unknown") {
        gaps.push(`${CHECK_TITLES[c.key]}: ${c.detail}`);
        continue;
      }
      facts.push({ id: `site:${c.key}`, statement: c.detail, label: "verified", source: { kind: "site", check: c.key, url: c.evidence?.url ?? t.start } });
    }
    gaps.push(...input.site.notes);
    if (input.site.pagesRead === 0) gaps.push("The website could not be read, so none of its checks are known.");
  } else if (t.kind === "social") {
    gaps.push(`The website answer is a ${t.platform} profile${t.url ? ` (${t.url})` : ""}, which is not fetched (it needs a login). Look at it by hand before the call.`);
  } else {
    gaps.push(t.reason === "empty" ? "The lead has no website on file." : "The lead's website answer is not a public web address, so it was not checked.");
  }

  // What the client said on the form.
  const form = input.form?.answers ?? null;
  if (!form) gaps.push("No AI-audit form answers are on file for this lead.");
  else {
    for (const field of FORM_ORDER) {
      const text = answerText(field, form[field]);
      if (!text) continue;
      const statement = field === "bottleneck_detail" ? `On a bad week, in their words: "${text}"` : `${fieldLabel(field)}: ${text}`;
      facts.push({ id: `form:${field}`, statement, label: "client_reported", source: { kind: "form", field } });
      const q = CONFIRM_WITH[field];
      if (q && QUESTION_IDS.has(q)) confirm.push({ statement: `${fieldLabel(field)}: ${text}`, question_id: q });
    }
  }

  // Likely problems to test.
  const ctx = { type: input.business.type, form, site: t.kind };
  const hypotheses = RULES.filter((r) => r.when(checks, ctx)).map(({ id, statement, test, questions }) => ({ id, statement, test, questions: questions.filter((q) => QUESTION_IDS.has(q)) }));

  // Questions to weight: the client's own goal first, then what the hypotheses test.
  const weight: PreCallBrief["weight"] = [];
  const add = (question_id: string, why: string) => {
    if (QUESTION_IDS.has(question_id) && !weight.some((w) => w.question_id === question_id) && weight.length < 6) weight.push({ question_id, why });
  };
  const goal = typeof form?.automation_goal === "string" ? form.automation_goal : null;
  for (const q of goal ? GOAL_WEIGHT[goal] ?? [] : []) add(q, `It is what they most want taken off their plate (${answerText("automation_goal", goal) ?? goal}).`);
  for (const h of hypotheses) for (const q of h.questions) add(q, `It tests a likely problem: ${h.statement}`);

  return {
    schema: BRIEF_SCHEMA,
    built_at: input.builtAt,
    business_name: input.business.name,
    site: { kind: t.kind, url: t.kind === "site" ? t.start : t.kind === "social" ? t.url : null, platform: t.kind === "social" ? t.platform : null, pages_read: input.site.pagesRead },
    facts,
    hypotheses,
    confirm,
    weight,
    gaps: [...new Set(gaps)].slice(0, 30),
  };
}

/** Is a stored brief well formed (for reading one back)? */
export function isBrief(v: unknown): v is PreCallBrief {
  if (!v || typeof v !== "object") return false;
  const b = v as Partial<PreCallBrief>;
  return b.schema === BRIEF_SCHEMA && Array.isArray(b.facts) && Array.isArray(b.hypotheses) && Array.isArray(b.confirm) && Array.isArray(b.weight) && Array.isArray(b.gaps);
}
