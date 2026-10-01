/**
 * components/os/department/config.ts — what each department tab is made of.
 *
 * PURE DATA + PURE FUNCTIONS. No session, no database, no next/*: the page
 * (app/team/[dept]/page.tsx) and the AI Team roster (app/agents/page.tsx) read
 * the same answers, and tests/os-departments.test.ts runs every one of them in
 * bare node.
 *
 * THE ONE RULE THIS FILE HOLDS: a workspace that is not OASIS's own never sees
 * an OASIS agent, an OASIS persona name or OASIS copy. OASIS binds its own
 * agents (Chief of Staff → bravo, Marketing → maven, Finance → atlas, as the
 * design doc §(b) "Agent binding" says). Every other workspace gets a neutral
 * library template where one exists (lib/agents/library.ts: `sdr`,
 * `customer-support` — both prompts say only "{{tenant.brand.name}}"), and an
 * honest "not set up" channel where none does. Rendering the default agent
 * instead would put Bravo's prompt ("You are Bravo…") in a client's channel.
 *
 * Why not a department prompt overlay on bravo? /api/agents/chat composes the
 * system prompt from the library prompt plus the MANIFEST binding's overlay; it
 * takes no per-request overlay, so a department overlay needs backend work
 * (listed as a gap in the workstream report).
 */

import type { DepartmentKey } from "@/lib/os/types";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { QUICK_ACTIONS } from "@/lib/quick-actions";

/** Which agent answers in a department's channel. */
export type DepartmentChannelBinding =
  | {
      kind: "agent";
      /** A slug /api/agents/chat resolves (library seed or tenant custom). */
      agentSlug: string;
      /** First line in an empty channel. */
      greeting: string;
    }
  | {
      kind: "unavailable";
      /** Plain sentence shown where the channel would be. */
      reason: string;
    };

export type SuggestedAsk = { title: string; prompt: string };

/**
 * One app a department works through: the name the owner knows it by, and the
 * Connections hub card it arrives through (a lib/os/connectors.ts slug: Gmail,
 * Google Calendar and Google Meet all come through Google Workspace).
 */
export type DepartmentApp = { label: string; connector: string };

type DepartmentProfile = {
  /** One-line subtitle under the department name. */
  purpose: string;
  /**
   * The apps this department works through. The tab shows each one with the
   * real status of its hub card (resolveConnectorStatus, the same words
   * Settings > Connections shows), so a name never stands in for a connection
   * nobody made. Slack is not listed here: the department tab shows its REAL
   * Slack state (lib/slack/status.ts, the mapped channels or why there are
   * none) on its own line.
   */
  connections: readonly DepartmentApp[];
};

// Written for any business. No OASIS names, no agent names, no CC.
const PROFILES: Record<DepartmentKey, DepartmentProfile> = {
  chief_of_staff: {
    purpose: "Your coordinator. Ask for anything; it pulls from every department.",
    connections: [
      { label: "Google Calendar", connector: "google-workspace" },
      { label: "Telegram", connector: "telegram" },
    ],
  },
  sales: {
    purpose: "Leads, follow-ups and booked calls.",
    connections: [
      { label: "Gmail", connector: "google-workspace" },
      { label: "Google Calendar", connector: "google-workspace" },
      { label: "Twilio SMS", connector: "twilio" },
    ],
  },
  marketing: {
    purpose: "Forms, content, campaigns and ads.",
    connections: [
      { label: "Meta Ads", connector: "meta" },
      { label: "Instagram", connector: "meta" },
      { label: "Constant Contact", connector: "constant-contact" },
    ],
  },
  client_success: {
    purpose: "Projects, support tickets and client health.",
    connections: [
      { label: "Zoom", connector: "zoom" },
      { label: "Google Meet", connector: "google-workspace" },
      { label: "Twilio SMS", connector: "twilio" },
    ],
  },
  finance: {
    purpose: "Cash, collections and revenue against goal.",
    connections: [
      { label: "Stripe", connector: "stripe" },
      { label: "QuickBooks", connector: "quickbooks" },
      { label: "Bank feed", connector: "plaid" },
    ],
  },
  operations: {
    purpose: "Routines, connections and the health of the machine.",
    // Operations watches all of them; the panel links the hub instead of
    // listing one chip per app.
    connections: [],
  },
};

export function departmentProfile(key: DepartmentKey): DepartmentProfile {
  return PROFILES[key];
}

// ── Channel binding ───────────────────────────────────────────────────────

/**
 * The replies in a department channel are text only: /api/agents/chat streams
 * a model response and runs no tools, so nothing can be sent from here. The
 * greeting says so, because an owner deciding whether to type a customer's
 * name into it deserves to know.
 */
const DRAFTS_ONLY = "Replies are drafts. Nothing is sent from this channel.";

const OASIS_BINDINGS: Record<DepartmentKey, { agentSlug: string; greeting: string }> = {
  chief_of_staff: {
    agentSlug: "bravo",
    greeting: `Ask for today's priorities, a status across departments, or hand off a goal. ${DRAFTS_ONLY}`,
  },
  sales: {
    agentSlug: "sdr",
    greeting: `Ask who to follow up with, what to say, or what is stalled. ${DRAFTS_ONLY}`,
  },
  marketing: {
    agentSlug: "maven",
    greeting: `Ask for content ideas, a campaign plan, or a read on what is working. ${DRAFTS_ONLY}`,
  },
  client_success: {
    agentSlug: "customer-support",
    greeting: `Ask for a reply to a client, a project status, or what is at risk. ${DRAFTS_ONLY}`,
  },
  finance: {
    agentSlug: "atlas",
    greeting: `Ask about cash, collections, or where revenue stands against the goal. ${DRAFTS_ONLY}`,
  },
  operations: {
    // Bravo's library role is operations ("Runs operations, debugging…"), so
    // Operations shares Chief of Staff's agent rather than borrowing one that
    // does not fit (qa-reviewer is an adversarial document reviewer).
    agentSlug: "bravo",
    greeting: `Ask what ran overnight, what failed, or what to automate next. ${DRAFTS_ONLY}`,
  },
};

/** Neutral library templates. Departments absent here have no neutral agent yet. */
const NEUTRAL_BINDINGS: Partial<Record<DepartmentKey, { agentSlug: string; greeting: string }>> = {
  sales: OASIS_BINDINGS.sales,
  client_success: OASIS_BINDINGS.client_success,
};

const NOT_SET_UP = "This department's AI teammate has not been set up for your workspace yet.";

export function departmentChannelFor(key: DepartmentKey, opts: { oasis: boolean }): DepartmentChannelBinding {
  const bound = opts.oasis ? OASIS_BINDINGS[key] : NEUTRAL_BINDINGS[key];
  return bound ? { kind: "agent", ...bound } : { kind: "unavailable", reason: NOT_SET_UP };
}

/** Every agent slug any workspace may be bound to — for tests and the roster. */
export const OASIS_BOUND_SLUGS: readonly string[] = [...new Set(Object.values(OASIS_BINDINGS).map((b) => b.agentSlug))];
export const NEUTRAL_BOUND_SLUGS: readonly string[] = [
  ...new Set(Object.values(NEUTRAL_BINDINGS).map((b) => b!.agentSlug)),
];

// ── Suggested asks ────────────────────────────────────────────────────────

/**
 * OASIS reuses its own quick actions (lib/quick-actions.ts) by exact title, so
 * the prompts stay the ones CC already tuned. A title that stops resolving
 * drops out rather than inventing a prompt; tests/os-departments.test.ts fails
 * when one does, so the drift is caught instead of silently shrinking a list.
 * Personal-finance actions (net worth, FIRE, trading) are deliberately not on
 * the business Finance tab.
 */
const OASIS_ASK_TITLES: Record<DepartmentKey, ReadonlyArray<readonly [agent: string, title: string]>> = {
  chief_of_staff: [
    ["bravo", "Run the daily briefing"],
    ["bravo", "What changed in the last 24h?"],
  ],
  sales: [
    ["bravo", "What leads are qualified?"],
    ["bravo", "Send a check-in"],
    ["bravo", "Score a sales call"],
  ],
  marketing: [
    ["maven", "Tomorrow's content"],
    ["maven", "What's working in ads?"],
    ["maven", "This week's content calendar"],
  ],
  client_success: [],
  finance: [
    ["atlas", "Red-flag transactions"],
    ["atlas", "What's owing on tax?"],
  ],
  operations: [
    ["bravo", "What changed in the last 24h?"],
    ["maven", "Funnel audit"],
  ],
};

const NEUTRAL_ASKS: Record<DepartmentKey, readonly SuggestedAsk[]> = {
  chief_of_staff: [
    { title: "Plan my day", prompt: "Look across sales, clients and routines and tell me the three things I should do first today, and why." },
    { title: "What needs a decision?", prompt: "List anything waiting on a decision from me this week, most urgent first, with the one-line tradeoff for each." },
  ],
  sales: [
    { title: "Who should I follow up with?", prompt: "Which of my open leads should I follow up with today? Rank them by urgency and suggest the next step for each." },
    { title: "Draft a check-in", prompt: "Draft a short, friendly check-in for a warm lead who has gone quiet for a week. Keep it under 80 words." },
    { title: "What is stalled?", prompt: "Which deals have not moved in the last 14 days, and what would get each one moving again?" },
  ],
  marketing: [
    { title: "Content ideas for this week", prompt: "Give me five content ideas for this week that would bring in the kind of leads we close. One line each, with the hook." },
    { title: "Improve a form", prompt: "I'll paste one of my lead forms. Tell me the two changes most likely to raise the submission rate." },
    { title: "Plan a campaign", prompt: "Outline a two-week campaign to fill next month's calendar: audience, offer, three messages, and how we'll measure it." },
  ],
  client_success: [
    { title: "Draft a client reply", prompt: "I'll paste a client's message. Draft a clear, warm reply that answers it and states the next step." },
    { title: "Which clients are at risk?", prompt: "Which clients look at risk right now, based on open tickets, late projects or silence? What should I do about each?" },
    { title: "Write a project update", prompt: "Write a short weekly update for a client project: what shipped, what is next, anything we need from them." },
  ],
  finance: [
    { title: "Where does cash stand?", prompt: "Summarize where cash and collections stand this month, and flag anything that needs attention." },
    { title: "Chase an overdue invoice", prompt: "Draft a polite, firm reminder for an invoice that is 14 days overdue." },
  ],
  operations: [
    { title: "What failed overnight?", prompt: "Did any routine fail or skip since yesterday? For each, what broke and what should I do?" },
    { title: "What should we automate?", prompt: "Looking at the work this team repeats every week, what are the two best candidates to turn into routines?" },
  ],
};

/**
 * OASIS's quick-action prompts were written for the operator chat and name the
 * house agents ("No revenue or MRR figures, that's <finance agent>'s domain").
 * On a department tab the prompt is shown (tooltip) and typed into the channel,
 * so each house agent is written as the department it leads, first binding
 * wins (Chief of Staff, Marketing, Finance): the prompt CC tuned still reads
 * right, and no persona name reaches the screen.
 */
const HOUSE_AGENT_DEPARTMENT: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const [key, bound] of Object.entries(OASIS_BINDINGS) as Array<[DepartmentKey, { agentSlug: string }]>) {
    const label = OS_DEPARTMENTS.find((d) => d.key === key)?.label;
    if (label && !(bound.agentSlug in out)) out[bound.agentSlug] = label;
  }
  return out;
})();

/** The same rule for any system string a screen prints (the Feed's publisher and event names). */
export function withDepartmentNames(text: string): string {
  return text.replace(/\b(bravo|maven|atlas)\b/gi, (name) => HOUSE_AGENT_DEPARTMENT[name.toLowerCase()] ?? name);
}

export function suggestedAsksFor(key: DepartmentKey, opts: { oasis: boolean }): SuggestedAsk[] {
  if (opts.oasis) {
    const picked: SuggestedAsk[] = [];
    for (const [agent, title] of OASIS_ASK_TITLES[key]) {
      const qa = QUICK_ACTIONS.find((q) => q.agent === agent && q.title === title);
      if (qa) picked.push({ title: withDepartmentNames(qa.title), prompt: withDepartmentNames(qa.prompt) });
    }
    if (picked.length > 0) return picked;
  }
  return [...NEUTRAL_ASKS[key]];
}

/** For the drift test: every OASIS quick-action title this file names. */
export const OASIS_ASK_REFERENCES: ReadonlyArray<readonly [DepartmentKey, string, string]> = (
  Object.entries(OASIS_ASK_TITLES) as Array<[DepartmentKey, ReadonlyArray<readonly [string, string]>]>
).flatMap(([key, pairs]) => pairs.map(([agent, title]) => [key, agent, title] as const));
