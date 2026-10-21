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
import { clipAndEscape, escapeTelegramHtml } from "@/lib/notify/telegram-format";
import type { ScoreBreakdown } from "@/lib/forms/ai-audit-ingest";
import type { PublicFunnelStage } from "@/lib/forms/public-booking";
import { AI_AUDIT_SLUG } from "@/lib/forms/oasis-ai-audit-seed";
import { publicBookingFormName } from "@/lib/forms/public-booking-config";

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
  // The /book form's escape hatch (lib/forms/oasis-book-seed.ts).
  not_sure: "not sure yet",
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

/**
 * A table's OWN entry for a key. A visitor's free text ("Anything we should
 * know?" on /book feeds bottleneckLabel) can be exactly "constructor" or
 * "toString", and a plain lookup would return Object's inherited member, a
 * function, where the lead and the sales alert expect words (Codex review of
 * #630 found the same shape in lib/offers/short-links.ts).
 */
function ownEntry(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function label(table: Record<string, string>, v: unknown): string {
  const k = str(v);
  if (!k) return "";
  return ownEntry(table, k) || k.replace(/_/g, " ");
}

/**
 * The bottleneck as a person reads it. A lead who leaves the optional detail box
 * empty is stored with the required goal's option key ("sales_leadgen"); this turns
 * exactly those keys into their words and leaves anything a person typed untouched
 * (unlike auditAnswerLabel, it never rewrites underscores in free text).
 */
export function bottleneckLabel(value: unknown): string {
  const text = str(value).trim();
  return ownEntry(GOAL_LABELS, text) ?? text;
}

const ANSWER_TABLES = {
  revenue: REVENUE_LABELS,
  budget: BUDGET_LABELS,
  timeframe: TIMELINE_LABELS,
  team: TEAM_LABELS,
} as const;

/**
 * A stored audit answer as the lead page should read it: "$10-50K/mo", not the
 * option key "10k_50k". Unknown keys fall back to the key with underscores
 * removed, so a renamed form option never renders as nothing. Null when empty.
 */
export function auditAnswerLabel(kind: keyof typeof ANSWER_TABLES, value: unknown): string | null {
  const text = label(ANSWER_TABLES[kind], value);
  return text || null;
}

/** Where a funnel lead got to (lib/forms/public-booking.ts PublicFunnelStage), in plain words. */
const FUNNEL_STAGE_LABELS: Record<PublicFunnelStage, string> = {
  inbound_lead: "Inbound lead",
  audit_requested: "Audit requested",
  meeting_booked: "Meeting booked",
};

/**
 * The funnel stage chip on the lead page and the Sales desk list. Null when the
 * lead has no funnel stage (a cold lead gets no chip, not an empty one); a
 * stage added later without a label here still shows, in words.
 *
 * `audit_requested` means "finished the form" for EVERY booking form, so its
 * chip names the form the lead stamped (`funnel_form`): "Audit requested" only
 * for the AI audit, "PROTOCOL form finished" for PROTOCOL, and "Form finished"
 * for a lead stamped before the form was recorded (review of #655: a PROTOCOL
 * buyer must never read as an audit).
 */
export function funnelStageLabel(value: unknown, form?: unknown): string | null {
  const key = str(value).trim();
  if (!key) return null;
  if (key === "audit_requested") return finishedFormLabel(form);
  const known = (FUNNEL_STAGE_LABELS as Record<string, string>)[key];
  if (known) return known;
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The booking form a lead came through: its `funnel_form` stamp, else the AI
 * audit when the lead carries the audit's own score stamp (only
 * ai-audit-ingest.ts writes ai_audit_scored_at, and only for that form), else
 * "" (unknown, never guessed). Leads finished before the stamp existed keep
 * their "Audit requested" only when they can prove it.
 */
export function leadFunnelForm(data: Record<string, unknown>): string {
  const stamped = str(data.funnel_form).trim().toLowerCase();
  if (stamped) return stamped;
  return str(data.ai_audit_scored_at).trim() ? AI_AUDIT_SLUG : "";
}

function finishedFormLabel(form: unknown): string {
  const slug = str(form).trim().toLowerCase();
  if (slug === AI_AUDIT_SLUG) return FUNNEL_STAGE_LABELS.audit_requested;
  const name = publicBookingFormName(slug);
  return name ? `${name} form finished` : "Form finished";
}

/**
 * What a lead that finished its form and has not booked did, for the Sales
 * desk's one-line summary: "audit done" for the AI audit, "finished the
 * PROTOCOL form" for PROTOCOL, "finished the form" when the form is unknown.
 */
export function finishedFormPhrase(form: unknown): string {
  const slug = str(form).trim().toLowerCase();
  if (slug === AI_AUDIT_SLUG) return "audit done";
  const name = publicBookingFormName(slug);
  return name ? `finished the ${name} form` : "finished the form";
}

/**
 * Revenue and bottleneck, the two facts a founder reads before calling, from a
 * lead row or a form's answers. One reading for every sales alert: the booked
 * call (public-booking.ts bookedLeadFacts), the audit started and the audit
 * completed alerts, so the three cannot describe one lead differently.
 * Empty strings when the lead never said.
 */
export function leadRevenueAndBottleneck(source: Record<string, unknown>): { revenue: string; bottleneck: string } {
  const field = (key: string) => str(source[key]).trim();
  return {
    revenue: auditAnswerLabel("revenue", field("revenue_band") || field("monthly_revenue")) ?? "",
    bottleneck: bottleneckLabel(field("primary_bottleneck") || field("bottleneck_detail") || field("automation_goal")),
  };
}

/**
 * The Revenue and Bottleneck lines of a sales alert. CC 2026-10-16: both
 * alerts promised them and neither had them. A value the lead never gave drops
 * its whole line, so an alert never reads "Revenue: undefined" or a bare label.
 * Escaped and capped: a stranger typed the bottleneck.
 */
export function alertLeadFactLines(source: Record<string, unknown>): string[] {
  const { revenue, bottleneck } = leadRevenueAndBottleneck(source);
  const lines: string[] = [];
  if (revenue) lines.push(`📊 Revenue: ${clipAndEscape(revenue, 120)}`);
  if (bottleneck) lines.push(`🚧 Bottleneck: ${clipAndEscape(bottleneck, 300)}`);
  return lines;
}

/**
 * Label for CUSTOMER-FACING copy: known keys only, empty otherwise.
 *
 * `label()` falls back to the raw key with underscores swapped for spaces,
 * which is the right call for an internal alert — seeing `21_100` beats
 * seeing nothing. In an email to a prospect it is a leak: a form option
 * renamed on the seed but not here would put a raw enum in front of a
 * customer. Copy that cannot be rendered should be omitted, not guessed.
 */
function safeLabel(table: Record<string, string>, v: unknown): string {
  const k = str(v);
  if (!k) return "";
  return ownEntry(table, k) ?? "";
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
/** What happened to the lead's own email, so the alert can report it. */
export type AlertLoop = {
  /** Human-readable outcome: "sent", "NOT sent — suppressed", etc. */
  emailStatus?: string;
  /** Deep link that opens the thread with this lead in Gmail. */
  inboxUrl?: string;
  /** Link that opens this lead in Command Center (lib/forms/lead-link.ts). */
  leadUrl?: string;
  /**
   * The call the lead booked BEFORE finishing (the calendar opens after the
   * contact step), as a person reads the time. Absent: not booked yet.
   */
  bookedCall?: string;
};

export function buildAiAuditAlert(
  a: Record<string, unknown>,
  s: ScoreBreakdown,
  loop?: AlertLoop,
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
  const goal = label(GOAL_LABELS, a.automation_goal);
  const team = label(TEAM_LABELS, a.team_size);
  const tried = label(TRIED_LABELS, a.tried_before);

  lines.push("");
  if (budget) lines.push(`💰 Budget: ${e(budget)}`);
  if (timeline) lines.push(`⏱ Timeline: ${e(timeline)}`);
  // Revenue, then the Bottleneck line the alert never had: the same reading the
  // started and booked alerts use. The bottleneck can BE the goal or the typed
  // answer (leadRevenueAndBottleneck falls back to them), so neither is printed
  // a second time below (re-audit 2026-10-16: the alert said it twice).
  const { bottleneck } = leadRevenueAndBottleneck(a);
  lines.push(...alertLeadFactLines(a));
  if (goal && goal !== bottleneck) lines.push(`🎯 Wants: ${e(goal)}`);
  if (team) lines.push(`👥 Team: ${e(team)}`);
  if (tried) lines.push(`🔁 Before: ${e(tried)}`);

  // Their own words are the highest-signal thing in the whole submission. Left
  // out only when the Bottleneck line above already printed all of them.
  const detail = str(a.bottleneck_detail).trim();
  const printedWhole = detail.length <= 300 && bottleneck === bottleneckLabel(detail);
  if (detail && !printedWhole) {
    lines.push("", `<b>In their words:</b>`, `<i>${clipAndEscape(detail, 600)}</i>`);
  }

  if (str(a.wants_call) === "yes") {
    lines.push("", `✅ <b>ASKED TO BOOK A CALL</b>`);
  }

  // The calendar opens after the contact step, so a lead may finish the
  // questions after booking: then the alert says booked, never "needs
  // follow-up". Otherwise the separate booked event carries the time later.
  if (loop?.bookedCall) {
    lines.push("", `📅 <b>Meeting:</b> booked for ${e(loop.bookedCall)}`);
  } else {
    lines.push("", "📅 <b>Meeting:</b> unbooked - needs follow-up");
  }

  if (s.reasons.length) {
    lines.push("", `<b>Why this score:</b> ${e(s.reasons.join(" · "))}`);
  }

  // Close the loop. The alert used to say a lead had arrived and stop there,
  // so CC still had to go and check whether the welcome email had actually
  // gone out, and then find the thread by hand. Both answers belong in the
  // one message that wakes the phone.
  if (loop?.emailStatus) {
    lines.push("", `✉️ <b>Welcome email:</b> ${e(loop.emailStatus)}`);
  }
  if (loop?.inboxUrl) {
    lines.push(`<a href="${loop.inboxUrl}">Open the thread in Gmail →</a>`);
  }
  if (loop?.leadUrl) {
    lines.push(`<a href="${loop.leadUrl}">Open the lead in Command Center →</a>`);
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
export type WelcomeLinks = {
  /** Signed link that opens the founder calendar for THIS lead (the page is long gone from a closed tab). */
  bookingUrl?: string;
  /**
   * Link to the free community. Present ONLY when marketingSendAllowed passed
   * for this address: it is an invitation, so the confirmation of their own
   * enquiry must never carry it for someone who declined marketing email.
   */
  communityUrl?: string;
};

export function composeAiAuditWelcome(
  a: Record<string, unknown>,
  links: WelcomeLinks = {},
  /**
   * The lead booked the call before finishing (the calendar opens after the
   * contact step). The email then confirms the call instead of offering a
   * time, and carries no booking or community link.
   */
  state: { booked?: boolean } = {},
): Composed {
  const first = (str(a.name).trim().split(/\s+/)[0] || "there").slice(0, 40);
  const goal = label(GOAL_LABELS, a.automation_goal);
  const urgent = str(a.timeframe) === "immediate" || str(a.timeframe) === "30_days";
  const booked = state.booked === true;
  const askedForCall = !booked && str(a.wants_call) === "yes";
  const { bookingUrl } = links;
  const communityUrl = booked ? undefined : links.communityUrl;

  const subject = askedForCall
    ? `${first} — booking your AI audit call`
    : `${first}, I've got your AI audit answers`;

  const opening = goal
    ? `Thanks for filling that out — you're looking at ${goal}, and you gave me enough detail to actually be useful rather than guess.`
    : `Thanks for filling that out — you gave me enough detail to actually be useful rather than guess.`;

  // With a signed link the email stands on its own: someone who closed the tab
  // before picking a time still has a way to book. Without one (the signing key
  // is unset) the copy keeps pointing at the page, as before.
  const offerCall = askedForCall
    ? bookingUrl
      ? `You asked for a call, so pick the time that works here: ${bookingUrl}\nThe Google invite arrives as soon as you book, and I'll have read your answers before we talk, not during.`
      : `You asked for a call, so use the live calendar on the page to pick the time that works. The Google invite arrives as soon as you book, and I'll have read your answers before we talk, not during.`
    // The two branches below used to promise "I'll come back to you with where
    // I'd start and what it would take": a personal written answer nobody has
    // committed to send (CC, 2026-10-08: there is no texted findings or custom
    // report). The promises cleared for this funnel are "Free AI audit. No
    // pitch." and "I read every one of these myself", so the copy says that and
    // points at the call, which IS the answer. Copy by Maven (CMO), 2026-10-15.
    : urgent
      ? bookingUrl
        ? `You said you want this moving soon. I read every one of these myself — the fastest way to a real answer is a call: ${bookingUrl}`
        : `You said you want this moving soon. I read every one of these myself — the fastest way to a real answer is a call: reply with two times that work and I'll send the invite.`
      : bookingUrl
        ? `I read every one of these myself. If talking is easier, pick a time with me here: ${bookingUrl}`
        : `I read every one of these myself. If talking is easier, reply with two times that work and I'll send the invite.`;
  // Booked: one sentence, no link to book again (copy by Maven, 2026-10-16; "your video call link", 2026-10-18: the
  // room is an Oasis Meet room, and "Meet link" beside "Google Calendar" read as Google Meet). No recording notice
  // here: this is Conaugh's first-person note, and the notice is in the invite and the room's consent box (Maven).
  const next = booked
    ? "Your call is booked, and the Google Calendar invite in your inbox has the time and your video call link."
    : offerCall;

  // Quote their own bottleneck back at them. This is the single most
  // personal thing in the form — they typed it — and the email was
  // ignoring it entirely while claiming to be specific. Trimmed to one
  // clause so it reads as "I read this", not as a receipt.
  const painRaw = str(a.bottleneck_detail).trim().replace(/\s+/g, " ");
  const pain =
    painRaw.length > 4
      ? painRaw.length > 150
        ? `${painRaw.slice(0, 147).replace(/[,;.\s]+\S*$/, "")}…`
        : painRaw
      : "";
  const team = safeLabel(TEAM_LABELS, a.team_size);
  const org = str(a.company).trim().slice(0, 60);

  const echo = pain
    ? `You wrote: "${pain}" — that's the part I'll come back on first.`
    : "";

  // Context line. Only `team` goes inline: it is the one label short enough
  // to read as a clause. `tried_before` is phrased for a report ("hired
  // someone before (it didn't stick)") and reads as a non-sequitur dropped
  // mid-sentence — it belongs in the internal alert, not in copy addressed
  // to the person it describes. Every part is omitted when absent rather
  // than rendered empty.
  const context = team
    ? org
      ? `At ${org}, with ${team}, where it is worth starting is different than it would be for a larger team — that is the useful part of the answer.`
      : `With ${team}, where it is worth starting is different than it would be for a larger team — that is the useful part of the answer.`
    : "";

  const body = [
    `${first},`,
    "",
    opening,
    ...(echo ? ["", echo] : []),
    ...(context ? ["", context] : []),
    "",
    next,
    ...(communityUrl ? ["", `If now is not the right time, the free OASIS community is open to you: ${communityUrl}`] : []),
    "",
    // Replaces "if I don't think automation is the right spend for you
    // right now, I'll tell you that." That line was conditional and meant
    // as a trust signal, but CC read it as being told he was a bad fit —
    // and a first-contact email that a reader can mistake for a rejection
    // has already failed, however well-intentioned. Same honesty, aimed at
    // scope instead of at the reader: I will tell you what NOT to build.
    `And I'll be straight about scope: if part of this is better solved by fixing a process than by automating it, I'll say so. You'll get the shortest path that actually works, not the biggest one.`,
    "",
    // "CC" is the internal name; public material signs as Conaugh.
    `— Conaugh`,
    `Conaugh McKenna · OASIS AI Solutions`,
  ].join("\n");

  return { subject, body };
}
