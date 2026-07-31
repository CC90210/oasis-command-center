/**
 * ai-audit-format.ts — pure builders for the B2B qualification funnel.
 *
 * No `server-only`, no network, no secrets → unit-testable. The orchestrator
 * (ai-audit-notify.ts) hands these strings to sendTelegram / deliverWelcomeEmail.
 *
 * Deliberately separate from oasis-funnel-format.ts. That one formats the
 * personal-brand funnel (interests: AI / DJ / brand); this one formats a scored
 * B2B lead where the decision-driving facts are budget, timeline and score.
 * Sharing a formatter would mean neither reads well.
 *
 * The welcome email is composed DETERMINISTICALLY — no model call. Two reasons:
 * CC's standing rule is that ANTHROPIC_API_KEY is out of credits and banned, and
 * a confirmation email that reads differently on every submission is a support
 * burden, not a personalization win.
 */
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";
import type { ScoreBreakdown } from "@/lib/forms/ai-audit-ingest";

/** Display text for the funnel's enum values. Keys read from
 *  oasis-ai-audit-seed.ts + the scoring tables in ai-audit-ingest.ts — an
 *  unmapped key falls back to the raw value rather than rendering blank. */
const REVENUE_LABELS: Record<string, string> = {
  pre_revenue: "pre-revenue",
  under_10k: "<$10K/mo",
  "10k_50k": "$10-50K/mo",
  "50k_250k": "$50-250K/mo",
  "250k_plus": "$250K+/mo",
};

const BUDGET_LABELS: Record<string, string> = {
  none_yet: "no budget yet",
  under_2k: "<$2K",
  "2k_5k": "$2-5K",
  "5k_15k": "$5-15K",
  "15k_plus": "$15K+",
};

const TIMELINE_LABELS: Record<string, string> = {
  immediate: "IMMEDIATE",
  "30_days": "within 30 days",
  quarter: "this quarter",
  exploring: "just exploring",
};

const GOAL_LABELS: Record<string, string> = {
  agent_fleet: "full agent fleet",
  sales_leadgen: "sales / lead gen",
  workflow_automation: "workflow automation",
  customer_support: "customer support",
};

const TRIED_LABELS: Record<string, string> = {
  hired: "hired someone before (it didn't stick)",
  diy: "tried building it themselves",
  tools: "bought tools, no system",
  never: "never tried",
};

const TEAM_LABELS: Record<string, string> = {
  solo: "solo",
  "2_5": "2-5 people",
  "6_20": "6-20 people",
  "21_100": "21-100 people",
  "100_plus": "100+ people",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function label(table: Record<string, string>, v: unknown): string {
  const k = str(v);
  if (!k) return "";
  return table[k] || k.replace(/_/g, " ");
}

/** Status → the emoji that survives a glance at a phone screen. */
const STATUS_MARK: Record<string, string> = {
  qualified: "🔥",
  warm: "🟡",
  cold: "⚪",
};

/**
 * CC's Telegram alert for a scored B2B lead.
 *
 * Ordered by what decides whether he picks up the phone: score and status
 * first, then how to reach them, then the money facts, then their own words.
 * Every user-supplied substring is HTML-escaped — the same crafted-input
 * concern the 2026-06-18 Codex audit raised for the other funnel.
 */
export function buildAiAuditAlert(
  a: Record<string, unknown>,
  s: ScoreBreakdown,
): string {
  const e = escapeTelegramHtml;
  const mark = STATUS_MARK[s.status] || "⚪";
  const name = str(a.name) || "New lead";
  const company = str(a.company);
  const email = str(a.email);
  const phone = str(a.phone);
  const website = str(a.website);

  const lines: string[] = [
    `${mark} <b>AI Audit Lead — ${s.score}/100 (${e(s.status)})</b>`,
    "",
    `<b>${e(name)}</b>${company ? ` — ${e(company)}` : ""}`,
  ];

  if (email) lines.push(`📧 ${e(email)}`);
  if (phone) lines.push(`📱 ${e(phone)}`);
  if (website) lines.push(`🌐 ${e(website)}`);

  // The money facts, on one line each so they scan vertically.
  const budget = label(BUDGET_LABELS, a.budget);
  const timeline = label(TIMELINE_LABELS, a.timeframe);
  const revenue = label(REVENUE_LABELS, a.monthly_revenue);
  const goal = label(GOAL_LABELS, a.automation_goal);
  const team = label(TEAM_LABELS, a.team_size);
  const tried = label(TRIED_LABELS, a.tried_before);

  lines.push("");
  if (budget) lines.push(`💰 Budget: ${e(budget)}`);
  if (timeline) lines.push(`⏱ Timeline: ${e(timeline)}`);
  if (revenue) lines.push(`📊 Revenue: ${e(revenue)}`);
  if (goal) lines.push(`🎯 Wants: ${e(goal)}`);
  if (team) lines.push(`👥 Team: ${e(team)}`);
  if (tried) lines.push(`🔁 Before: ${e(tried)}`);

  // Their own words are the highest-signal thing in the whole submission.
  const detail = str(a.bottleneck_detail).trim();
  if (detail) {
    lines.push("", `<b>In their words:</b>`, `<i>${e(detail.slice(0, 600))}</i>`);
  }

  if (str(a.wants_call) === "yes") {
    lines.push("", `✅ <b>ASKED TO BOOK A CALL</b>`);
  }

  if (s.reasons.length) {
    lines.push("", `<b>Why this score:</b> ${e(s.reasons.join(" · "))}`);
  }

  return lines.join("\n");
}

export type Composed = { subject: string; body: string };

/**
 * The lead's confirmation email. Deterministic, plain, and specific about what
 * happens next — the two failures of a generic auto-responder are saying
 * nothing ("Thanks for your submission!") and over-promising.
 *
 * Tone follows CC's own: direct, no filler, no "we're excited to partner on
 * your journey". It references what they actually told us so it does not read
 * like an autoresponder, without needing a model to do it.
 */
export function composeAiAuditWelcome(a: Record<string, unknown>): Composed {
  const first = (str(a.name).trim().split(/\s+/)[0] || "there").slice(0, 40);
  const goal = label(GOAL_LABELS, a.automation_goal);
  const urgent = str(a.timeframe) === "immediate" || str(a.timeframe) === "30_days";
  const askedForCall = str(a.wants_call) === "yes";

  const subject = askedForCall
    ? `${first} — booking your AI audit call`
    : `${first}, I've got your AI audit answers`;

  const opening = goal
    ? `Thanks for filling that out — you're looking at ${goal}, and you gave me enough detail to actually be useful rather than guess.`
    : `Thanks for filling that out — you gave me enough detail to actually be useful rather than guess.`;

  const next = askedForCall
    ? `You asked for a call, so that's the next thing that happens. I'll come back to you with a couple of times that work — and I'll have read your answers before we talk, not during.`
    : urgent
      ? `You said you want this moving soon, so I'll come back to you shortly with where I'd start and what it would take. If it's faster to just talk, reply to this email and say so.`
      : `I'll come back to you with where I'd start and roughly what it would take. No pitch deck, no discovery-call maze — just the honest read.`;

  const body = [
    `${first},`,
    "",
    opening,
    "",
    next,
    "",
    `One thing worth saying up front: if I don't think automation is the right spend for you right now, I'll tell you that. It's a shorter conversation and it's the honest one.`,
    "",
    `— CC`,
    `Conaugh McKenna · OASIS AI Solutions`,
  ].join("\n");

  return { subject, body };
}
