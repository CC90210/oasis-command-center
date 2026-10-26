/**
 * lib/ai-audit/framework.ts — the discovery call's question framework.
 *
 * ONE SOURCE. The live-call screen walks it, transcript extraction fills its
 * fields, and the Discovery Call Handbook (content/playbooks/
 * 11-ai-audit-discovery-handbook.md) carries every question's exact wording;
 * tests/ai-audit-rules.test.ts fails if the handbook drops or rewords one, if
 * a question fills a field the profile does not have, or if a profile field
 * has no question that fills it.
 *
 * The categories are CC's brief, section 3B, in its order, between an opening
 * (consent and agenda) and a close (what happens next). Each question says why
 * it is asked, how to follow up, and which profile fields it fills
 * (lib/ai-audit/profile.ts). Essential questions are the ones the audit cannot
 * be written without; optional ones deepen it when the call has room.
 *
 * RULES THE FRAMEWORK CARRIES (from the brief and CC's direction): no prices
 * on the call; no promised results; no statistics we cannot source; never take
 * a password or a login on a call; the business's own process comes before any
 * talk of AI.
 *
 * PURE.
 */
import type { BusinessType } from "@/lib/ai-audit/rules";

export const FRAMEWORK_VERSION = "discovery/v1" as const;

export const QUESTION_CATEGORIES = [
  "opening",
  "business_context",
  "daily_operations",
  "technology",
  "sales_marketing",
  "financial_metrics",
  "priorities_decisions",
  "close",
] as const;
export type QuestionCategory = (typeof QUESTION_CATEGORIES)[number];

export const QUESTION_CATEGORY_LABELS: Readonly<Record<QuestionCategory, string>> = {
  opening: "Opening and consent",
  business_context: "Business context",
  daily_operations: "Daily operations",
  technology: "Technology and infrastructure",
  sales_marketing: "Sales and marketing",
  financial_metrics: "Financial and performance metrics",
  priorities_decisions: "Priorities and decision-making",
  close: "Close and next steps",
};

export type DiscoveryQuestion = {
  id: string;
  category: QuestionCategory;
  essential: boolean;
  /** What CC says, in plain words. */
  ask: string;
  /** Why it matters to the audit. */
  why: string;
  /** Follow-ups for a vague or short answer. */
  follow_ups: string[];
  /** Profile fields (lib/ai-audit/profile.ts) the answer fills. */
  fills: string[];
  /** Business types it does not apply to (empty: all). */
  skip_for?: readonly BusinessType[];
};

export const DISCOVERY_QUESTIONS: readonly DiscoveryQuestion[] = [
  // Opening
  {
    id: "open-consent",
    category: "opening",
    essential: true,
    ask: "Before we start: may I record this call? We transcribe it and analyse it with AI services that work for OASIS, only to prepare your free audit.",
    why: "Recording and AI analysis need the client's clear yes. Without it, take notes instead and say so.",
    follow_ups: ["If not: that is completely fine. I will take notes as we go."],
    fills: ["consent.recording", "consent.ai_processing"],
  },
  {
    id: "open-agenda",
    category: "opening",
    essential: true,
    ask: "Here is how I would like to use our time: I will ask about how the business runs today, where time goes, and what you want to change. You get a free written audit afterwards, with no obligation. Does that work?",
    why: "Sets expectations: a conversation about their business, a free audit, no pitch on the call.",
    follow_ups: ["Is there anything you specifically want us to look at?"],
    fills: [],
  },
  // Business context
  {
    id: "biz-what",
    category: "business_context",
    essential: true,
    ask: "In your own words, what does the business do, and who is it for?",
    why: "The audit opens with our understanding of the business. It must be theirs, not ours.",
    follow_ups: ["Who is your best kind of customer?", "Which part of the work do people come to you for most?"],
    fills: ["business.description", "business.customer_segments"],
  },
  {
    id: "biz-services",
    category: "business_context",
    essential: true,
    ask: "What are the main services or products, and how does the business make its money?",
    why: "Recommendations have to fit how revenue actually arrives.",
    follow_ups: ["Is most of it one-off jobs, repeat customers, or subscriptions?"],
    fills: ["business.services", "business.revenue_model"],
  },
  {
    id: "biz-size",
    category: "business_context",
    essential: false,
    ask: "How many people work in the business, and where do you serve customers?",
    why: "Size decides which tools are realistic, and how far a saved hour goes.",
    follow_ups: ["Who does the admin side today?"],
    fills: ["business.team_size", "business.locations"],
  },
  {
    id: "biz-goals",
    category: "business_context",
    essential: true,
    ask: "What are you trying to achieve this year, and in the longer run?",
    why: "The roadmap is ordered by what they want, not by what we sell.",
    follow_ups: ["What would make this year a good one?", "Where do you want the business to be in three years?"],
    fills: ["goals.immediate", "goals.long_term"],
  },
  // Daily operations
  {
    id: "ops-repetitive",
    category: "daily_operations",
    essential: true,
    ask: "Which tasks repeat every week and eat the most time?",
    why: "Repetitive tasks are where automation pays back. Hours per task feed the estimates.",
    follow_ups: ["Roughly how many hours a week does that take?", "Who does it?", "How do you know that number: a guess, or records?"],
    fills: ["ops.repetitive_tasks", "ops.admin_hours_per_week"],
  },
  {
    id: "ops-manual",
    category: "daily_operations",
    essential: true,
    ask: "Where do you copy information from one place to another by hand?",
    why: "Re-keying between systems is the most common, most fixable waste.",
    follow_ups: ["What happens when that step is missed?"],
    fills: ["ops.manual_workflows"],
  },
  {
    id: "ops-delays",
    category: "daily_operations",
    essential: false,
    ask: "Where do things get stuck, or fall through the cracks between people?",
    why: "Delays and hand-offs are where customers feel the business.",
    follow_ups: ["Can you tell me about the last time that happened?"],
    fills: ["ops.delays"],
  },
  // Technology
  {
    id: "tech-tools",
    category: "technology",
    essential: true,
    ask: "Which software do you use to run the business day to day?",
    why: "We build on what they already pay for before suggesting anything new.",
    follow_ups: ["What does each one do for you?", "Roughly what does it cost a month? Only if you know."],
    fills: ["tech.tools"],
  },
  {
    id: "tech-silos",
    category: "technology",
    essential: true,
    ask: "Which of those talk to each other, and which do not?",
    why: "Disconnected systems are where integrations help most.",
    follow_ups: ["Where do you end up looking things up twice?"],
    fills: ["tech.disconnected"],
  },
  {
    id: "tech-frustrations",
    category: "technology",
    essential: false,
    ask: "What frustrates you most about your current tools?",
    why: "Their frustration is the clearest sign of what they would value fixing.",
    follow_ups: ["What have you put up with because changing it felt too hard?"],
    fills: ["tech.frustrations"],
  },
  // Sales and marketing
  {
    id: "sales-sources",
    category: "sales_marketing",
    essential: true,
    ask: "Where do new customers come from, and roughly how many enquiries a month?",
    why: "Lead volume is the base of most revenue estimates.",
    follow_ups: ["Which source brings the best customers?", "Is that a guess, or do you track it?"],
    fills: ["sales.lead_sources", "sales.leads_per_month"],
  },
  {
    id: "sales-handling",
    category: "sales_marketing",
    essential: true,
    ask: "Walk me through what happens when a new enquiry comes in.",
    why: "The path from enquiry to booking is where most lost customers are lost.",
    follow_ups: ["How long until the first reply, usually?", "What happens after hours or at weekends?"],
    fills: ["sales.lead_handling", "sales.response_time_hours"],
  },
  {
    id: "sales-conversion",
    category: "sales_marketing",
    essential: true,
    ask: "Out of every ten enquiries, how many become customers? And what is a typical job worth?",
    why: "Close rate and job value turn time saved and faster replies into money, as a range.",
    follow_ups: ["Is that from your records, or your best sense?"],
    fills: ["sales.close_rate_pct", "sales.avg_job_value"],
  },
  {
    id: "sales-lost",
    category: "sales_marketing",
    essential: false,
    ask: "Where do you lose people: missed calls, slow quotes, no follow-up?",
    why: "Names the leak the first recommendation should plug.",
    follow_ups: ["How many calls a week go to voicemail, roughly?"],
    fills: ["sales.lost_points", "sales.missed_calls_per_week"],
    skip_for: ["individual_productivity"],
  },
  // Financial and performance metrics
  {
    id: "fin-costs",
    category: "financial_metrics",
    essential: false,
    ask: "Which costs would you most like to bring down?",
    why: "Grounds cost savings in what they actually spend. Never guess a cost they did not give.",
    follow_ups: ["Do you know roughly what that costs a month?"],
    fills: ["finance.relevant_costs"],
  },
  {
    id: "fin-staff-time",
    category: "financial_metrics",
    essential: true,
    ask: "What does an hour of your team's time cost the business, roughly?",
    why: "Turns hours saved into a cost figure. If they will not say, the estimate stays in hours.",
    follow_ups: ["A range is fine."],
    fills: ["finance.staff_hourly_cost"],
  },
  {
    id: "fin-kpis",
    category: "financial_metrics",
    essential: false,
    ask: "Which numbers do you watch to know the business is doing well?",
    why: "Their numbers are the ones the audit should move.",
    follow_ups: ["Where do you look them up?"],
    fills: ["finance.kpis"],
  },
  // Priorities and decision-making
  {
    id: "dec-first-fix",
    category: "priorities_decisions",
    essential: true,
    ask: "If the right technology were ready tomorrow, what would you fix first?",
    why: "The first roadmap item should be the one they already want.",
    follow_ups: ["Why that one?"],
    fills: ["goals.first_fix"],
  },
  {
    id: "dec-past",
    category: "priorities_decisions",
    essential: false,
    ask: "What has stopped you fixing this before?",
    why: "Past attempts show the real constraints: time, money, trust, or bad experiences.",
    follow_ups: ["What did you try, and what happened?"],
    fills: ["decision.past_attempts", "decision.constraints"],
  },
  {
    id: "dec-who",
    category: "priorities_decisions",
    essential: true,
    ask: "Who else is involved in a decision like this, and is there a timeline we should know about?",
    why: "The audit and proposal should reach everyone who decides, on their schedule.",
    follow_ups: ["When would you want something like this working?"],
    fills: ["decision.makers", "decision.timeline"],
  },
  {
    id: "dec-budget",
    category: "priorities_decisions",
    essential: false,
    ask: "Is there a budget range you have in mind? Only if you are comfortable saying.",
    why: "Asked only if the conversation allows. It shapes the roadmap's phasing, never the price: prices come from the catalogue, after the call.",
    follow_ups: [],
    fills: ["decision.budget"],
  },
  // Close
  {
    id: "close-next",
    category: "close",
    essential: true,
    ask: "Here is what happens next: we research the business, write your free audit, and send you a private link. Is email the best way to reach you?",
    why: "Clear expectations, and the right address for the audit.",
    follow_ups: ["Is there anything we did not cover that you want in the audit?"],
    fills: [],
  },
];

/** The questions for one business type, in order. */
export function questionsFor(type: BusinessType | null): DiscoveryQuestion[] {
  return DISCOVERY_QUESTIONS.filter((q) => !type || !(q.skip_for ?? []).includes(type));
}

/** Every profile field the framework can fill, for the extraction schema. */
export function frameworkFields(): string[] {
  return [...new Set(DISCOVERY_QUESTIONS.flatMap((q) => q.fills))];
}

/** The fields an essential question fills (consent included). */
export function essentialFields(type: BusinessType | null = null): string[] {
  return [...new Set(questionsFor(type).filter((q) => q.essential).flatMap((q) => q.fills))];
}

/** Essential fields the profile does not have yet: the call screen's "still needed", Gate 1's gap count. */
export function essentialGaps(captured: ReadonlySet<string>, type: BusinessType | null = null): string[] {
  return essentialFields(type).filter((k) => !captured.has(k));
}
