/**
 * components/os/department/config.ts — what each department tab is made of.
 *
 * PURE DATA + PURE FUNCTIONS. No session, no database, no next/*: the page
 * (app/team/[dept]/page.tsx) and the AI Team roster (app/agents/page.tsx) read
 * the same answers, and tests/os-departments.test.ts runs every one of them in
 * bare node.
 *
 * WHO LEADS A DEPARTMENT (W4a, 2026-10-01). The workspace's manifest says: the
 * binding whose `departments` names it (lib/manifest/schema.ts). That is the
 * one roster every surface reads through departmentChannelFor: the department
 * channel and its header, the AI Team page, Settings > AI brain, Slack, the
 * chat route and the welcome wizard. OASIS's seed binds its own agents (Chief
 * of Staff and Operations → bravo, Sales → sdr, Marketing → maven, Client
 * Success → customer-support, Finance → atlas). The static table below answers
 * ONLY for OASIS's own workspace, and only for a department its manifest names
 * no lead for (a stored manifest written before `departments` existed). Any
 * other workspace gets exactly the leads its manifest binds, and an honest "not
 * set up" channel where it binds none.
 *
 * THE ONE RULE THIS FILE HOLDS: a workspace that is not OASIS's own never sees
 * an OASIS agent, an OASIS persona name or OASIS copy. A client binding that
 * names a house agent (lib/agents.ts isHouseAgentSlug) is ignored, so no
 * manifest edit can put Bravo's prompt ("You are Bravo…") in a client's
 * channel. OASIS provisions a client's departments with neutral library
 * templates (lib/agents/library.ts: `sdr`, `customer-support`, both prompts
 * say only "{{tenant.brand.name}}"; lib/provisioning/team.ts).
 *
 * Why not a department prompt overlay on bravo? /api/agents/chat composes the
 * system prompt from the library prompt plus the MANIFEST binding's overlay; it
 * takes no per-request overlay, so a department overlay needs backend work
 * (listed as a gap in the workstream report).
 */

import type { DepartmentKey } from "@/lib/os/types";
import type { ManifestAgentBinding, TenantManifest } from "@/lib/manifest/schema";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { QUICK_ACTIONS } from "@/lib/quick-actions";
import { isHouseAgentSlug } from "@/lib/agents";
import { isBindingOn } from "@/lib/manifest/agent-roster";

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

type DepartmentProfile = {
  /** One-line subtitle under the department name. */
  purpose: string;
  /**
   * The apps this department works through, as the owner would name them.
   * Labels only, so no chip claims a status. Slack is not a label here: the
   * department tab shows its REAL Slack state (lib/slack/status.ts, the mapped
   * channels or why there are none) on its own line.
   */
  connections: readonly string[];
};

// Written for any business. No OASIS names, no agent names, no CC.
const PROFILES: Record<DepartmentKey, DepartmentProfile> = {
  chief_of_staff: {
    purpose: "Your coordinator. Ask for anything; it pulls from every department.",
    connections: ["Google Calendar", "Telegram"],
  },
  sales: {
    purpose: "Leads, follow-ups and booked calls.",
    connections: ["Gmail", "Google Calendar", "Twilio SMS"],
  },
  marketing: {
    purpose: "Forms, content, campaigns and ads.",
    connections: ["Meta Ads", "Instagram", "Constant Contact"],
  },
  client_success: {
    purpose: "Projects, support tickets and client health.",
    connections: ["Zoom", "Google Meet", "Twilio SMS"],
  },
  finance: {
    purpose: "Cash, collections and revenue against goal.",
    connections: ["Stripe", "QuickBooks", "Bank feed"],
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

/** The first line in each department's empty channel, whoever leads it. */
const GREETINGS: Record<DepartmentKey, string> = {
  chief_of_staff: `Ask for today's priorities, a status across departments, or hand off a goal. ${DRAFTS_ONLY}`,
  sales: `Ask who to follow up with, what to say, or what is stalled. ${DRAFTS_ONLY}`,
  marketing: `Ask for content ideas, a campaign plan, or a read on what is working. ${DRAFTS_ONLY}`,
  client_success: `Ask for a reply to a client, a project status, or what is at risk. ${DRAFTS_ONLY}`,
  finance: `Ask about cash, collections, or where revenue stands against the goal. ${DRAFTS_ONLY}`,
  operations: `Ask what ran overnight, what failed, or what to automate next. ${DRAFTS_ONLY}`,
};

/**
 * OASIS's own leads, as OASIS_SEED binds them (lib/manifest/seeds.ts). Read
 * only for OASIS's workspace, and only for a department its manifest names no
 * lead for: a stored OASIS manifest written before `departments` existed keeps
 * the channels it had.
 */
const OASIS_LEADS: Record<DepartmentKey, string> = {
  chief_of_staff: "bravo",
  sales: "sdr",
  marketing: "maven",
  client_success: "customer-support",
  finance: "atlas",
  // Bravo's library role is operations ("Runs operations, debugging…"), so
  // Operations shares Chief of Staff's agent rather than borrowing one that
  // does not fit (qa-reviewer is an adversarial document reviewer).
  operations: "bravo",
};

/**
 * The neutral library template OASIS sets up as a client department's lead
 * (lib/provisioning/team.ts). Departments absent here have no neutral agent
 * yet, so provisioning gives them no lead.
 */
const NEUTRAL_TEMPLATES: Partial<Record<DepartmentKey, string>> = {
  sales: "sdr",
  client_success: "customer-support",
};

const NOT_SET_UP = "This department's AI teammate has not been set up for your workspace yet.";
const TURNED_OFF = "This department's AI teammate is turned off for your workspace.";

/**
 * Whose department is it: OASIS's own workspace or another, and the
 * workspace's manifest. Pass the manifest wherever the caller has it; without
 * one, OASIS falls back to its static leads and every other workspace has none
 * (fail closed: no manifest is never a reason to borrow an agent).
 */
export type DepartmentScope = {
  oasis: boolean;
  manifest?: Pick<TenantManifest, "agents" | "os"> | null;
};

/** The department each neutral template leads (the inverse of NEUTRAL_TEMPLATES). */
const NEUTRAL_TEMPLATE_DEPARTMENT: Readonly<Record<string, DepartmentKey>> = Object.fromEntries(
  (Object.entries(NEUTRAL_TEMPLATES) as Array<[DepartmentKey, string]>).map(([dept, slug]) => [slug, dept]),
);

/**
 * A neutral lead written before `departments` existed: provisioning and the
 * setup wizard bound `sdr` and `customer-support` with none until W4a. It
 * leads the department its template is for, but only when the workspace's
 * stored setup (manifest.os.departments) chose that department. An explicit
 * [] stays a custom teammate (CodeRabbit on #517). Read-time only: nothing is
 * written, and "Set up again" stores the departments for good.
 */
function withSetupDepartments(binding: ManifestAgentBinding, chosen: readonly DepartmentKey[] | undefined): ManifestAgentBinding {
  if (binding.departments !== undefined || !chosen) return binding;
  const dept = NEUTRAL_TEMPLATE_DEPARTMENT[binding.slug.toLowerCase()];
  return dept && chosen.includes(dept) ? { ...binding, departments: [dept] } : binding;
}

/** The workspace's bindings, minus any house agent outside OASIS's own workspace. */
export function workspaceBindings(scope: DepartmentScope): ManifestAgentBinding[] {
  const agents = scope.manifest?.agents ?? [];
  if (scope.oasis) return [...agents];
  const chosen = scope.manifest?.os?.departments;
  return agents.filter((a) => !isHouseAgentSlug(a.slug)).map((a) => withSetupDepartments(a, chosen));
}

/** lib/manifest/agent-roster.ts's rule: a core binding is always on. */
export const bindingIsOn: (binding: Pick<ManifestAgentBinding, "enabled" | "core">) => boolean = isBindingOn;

/** The manifest binding that leads `key` here (the first that names it), or null. */
export function manifestLeadFor(key: DepartmentKey, scope: DepartmentScope): ManifestAgentBinding | null {
  return workspaceBindings(scope).find((a) => (a.departments ?? []).includes(key)) ?? null;
}

/**
 * Who leads `key` in this workspace: its manifest's binding, or, in OASIS's
 * own workspace only, OASIS's static lead when the manifest names none
 * (`binding` is then null). Null: nobody leads it here.
 *
 * `control` is the binding whose switch turns this lead on and off: the lead's
 * own binding, or, for OASIS's static lead, a binding of the same agent that
 * names no department (a stored OASIS manifest from before `departments`).
 * The channel and the roster (lib/os/teammates.ts) both read it, so a lead the
 * AI Team shows Off never answers in its channel (W4a review R5).
 */
export function departmentLead(
  key: DepartmentKey,
  scope: DepartmentScope,
): { slug: string; binding: ManifestAgentBinding | null; control: ManifestAgentBinding | null } | null {
  const binding = manifestLeadFor(key, scope);
  if (binding) return { slug: binding.slug, binding, control: binding };
  if (!scope.oasis) return null;
  const slug = OASIS_LEADS[key];
  const control = workspaceBindings(scope).find((a) => a.slug.toLowerCase() === slug) ?? null;
  return { slug, binding: null, control };
}

export function departmentChannelFor(key: DepartmentKey, scope: DepartmentScope): DepartmentChannelBinding {
  const lead = departmentLead(key, scope);
  if (!lead) return { kind: "unavailable", reason: NOT_SET_UP };
  if (lead.control && !bindingIsOn(lead.control)) return { kind: "unavailable", reason: TURNED_OFF };
  return { kind: "agent", agentSlug: lead.slug, greeting: GREETINGS[key] };
}

/** The neutral template OASIS provisions as this department's lead in a client workspace, or null. */
export function neutralTemplateFor(key: DepartmentKey): string | null {
  return NEUTRAL_TEMPLATES[key] ?? null;
}

/** The static lead for `key` (OASIS's own, or the neutral template), with no manifest. */
export function staticLeadSlug(key: DepartmentKey, opts: { oasis: boolean }): string | null {
  return opts.oasis ? OASIS_LEADS[key] : neutralTemplateFor(key);
}

/** Every agent slug the static tables bind — for tests and the roster. */
export const OASIS_BOUND_SLUGS: readonly string[] = [...new Set(Object.values(OASIS_LEADS))];
export const NEUTRAL_BOUND_SLUGS: readonly string[] = [
  ...new Set(Object.values(NEUTRAL_TEMPLATES).filter((s): s is string => typeof s === "string")),
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
  for (const [key, agentSlug] of Object.entries(OASIS_LEADS) as Array<[DepartmentKey, string]>) {
    const label = OS_DEPARTMENTS.find((d) => d.key === key)?.label;
    if (label && !(agentSlug in out)) out[agentSlug] = label;
  }
  return out;
})();

function withDepartmentNames(text: string): string {
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
