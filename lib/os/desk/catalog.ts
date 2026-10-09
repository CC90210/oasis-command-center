/**
 * lib/os/desk/catalog.ts - what a department teammate can look up, per
 * department, and which AI providers can look anything up at all.
 *
 * WHY (CC, 2026-10-09). Chief of Staff answered "what's happening in the
 * pipeline and what tools do you have" with "please connect or specify the
 * workspace CRM": every department turn sent about 200 input tokens (a short
 * persona) and no tools, so it knew nothing about the business it works in.
 * A department turn now carries a DEPARTMENT STATE block (./state.ts) and a
 * PALETTE of read tools (./tools.ts) chosen here, per department.
 *
 * PURE. No server imports: the palette, the labels and the provider rule are
 * shared by the prompt, the dispatcher and the tests, so the list the model is
 * told about, the list it is offered and the list that runs are one list.
 *
 * READS, AND ONE KIND OF PROPOSAL. Every tool here reads the session's own
 * workspace through the readers its pages already use, with the viewer's own
 * scope. The only write is propose_email, which creates an approval card in
 * Needs you and sends nothing (lib/cloud-tool-runner.ts toolProposeEmail).
 * Nothing in a palette sends, changes a record or spends money.
 *
 * No agent persona name and no internal table or vendor name appears in a
 * label, a summary or a description: they reach the model, and the model's
 * words reach the client.
 */

import type { DepartmentKey } from "@/lib/os/types";

export type DeskToolName =
  | "department_numbers"
  | "pipeline_summary"
  | "leads_search"
  | "lead_timeline"
  | "tickets_list"
  | "projects_list"
  | "routines_status"
  | "approvals_list"
  | "finance_get_metric"
  | "calendar_upcoming"
  | "connections_status"
  | "propose_email";

export type DeskTool = {
  name: DeskToolName;
  /** The chip under a reply ("Looked up: Pipeline"). */
  label: string;
  /** One line for "what can you do", in the person's words. */
  summary: string;
  /** What the model is told. */
  description: string;
  input_schema: Record<string, unknown>;
  /** read: changes nothing. proposal: creates an approval card, sends nothing. */
  kind: "read" | "proposal";
};

const DEPARTMENT_KEY_LIST: readonly DepartmentKey[] = [
  "chief_of_staff",
  "sales",
  "marketing",
  "client_success",
  "finance",
  "operations",
];

const OBJECT = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
});

export const DESK_TOOLS: Readonly<Record<DeskToolName, DeskTool>> = {
  department_numbers: {
    name: "department_numbers",
    label: "Department numbers",
    summary: "Read the numbers and Needs-you items a department page shows right now",
    description:
      "Read the live numbers and the Needs-you items a department page shows right now (the same figures the person sees on that page). Use it to refresh the summary you were given, or, from Chief of Staff, to read another department's page. A number that could not be read comes back as unknown: say so, never guess.",
    input_schema: OBJECT({
      department: {
        type: "string",
        enum: [...DEPARTMENT_KEY_LIST],
        description: "The department page to read. Defaults to your own department.",
      },
    }),
    kind: "read",
  },
  pipeline_summary: {
    name: "pipeline_summary",
    label: "Pipeline",
    summary: "Count the leads in each pipeline stage, and list the follow-ups that are past due",
    description:
      "Count this workspace's leads by pipeline stage (the person's own book if they only see their own leads) and list the follow-ups that are past due and the meetings booked for today. Use it for 'what is happening in the pipeline', 'what is stalled' and 'who should I follow up with'.",
    input_schema: OBJECT(),
    kind: "read",
  },
  leads_search: {
    name: "leads_search",
    label: "Leads",
    summary: "Find leads by name, company, email or stage",
    description:
      "Search this workspace's leads by name, company, email or phone, optionally in one pipeline stage (use a stage key from pipeline_summary). Returns up to 15 leads with their stage, next step and last update. Use it before talking about a specific lead.",
    input_schema: OBJECT({
      query: { type: "string", description: "Part of a name, company, email or phone. Optional." },
      stage: { type: "string", description: "A stage key from pipeline_summary. Optional." },
      limit: { type: "number", description: "At most this many leads (default 10, max 15)." },
    }),
    kind: "read",
  },
  lead_timeline: {
    name: "lead_timeline",
    label: "Lead history",
    summary: "Read one lead's details and its recent emails, texts, calls and notes",
    description:
      "Read one lead's record and its most recent emails, texts, calls and notes (newest first). Pass the id from leads_search or pipeline_summary.",
    input_schema: OBJECT({ lead_id: { type: "string", description: "The lead's id." } }, ["lead_id"]),
    kind: "read",
  },
  tickets_list: {
    name: "tickets_list",
    label: "Tickets",
    summary: "List support tickets with their status, severity and response-time target",
    description:
      "List this workspace's support tickets (open by default) with their number, title, client, severity, status and whether the first-response target is met, at risk or breached.",
    input_schema: OBJECT({
      status: { type: "string", enum: ["open", "closed"], description: "Open (default) or closed tickets." },
    }),
    kind: "read",
  },
  projects_list: {
    name: "projects_list",
    label: "Projects",
    summary: "List client projects with their stage, due date and open tickets",
    description: "List this workspace's active client projects with their stage, due date, tasks done and open tickets.",
    input_schema: OBJECT(),
    kind: "read",
  },
  routines_status: {
    name: "routines_status",
    label: "Routines",
    summary: "List the scheduled routines, whether each is on, and how its last run went",
    description:
      "List this workspace's scheduled routines with their schedule, on or off, last run time and last result, plus how many failed in the last 24 hours.",
    input_schema: OBJECT(),
    kind: "read",
  },
  approvals_list: {
    name: "approvals_list",
    label: "Approvals",
    summary: "List the drafts waiting for a person's approval in Needs you",
    description:
      "List the approval cards waiting in Needs you (drafts a teammate proposed, waiting for a person to approve or send back), newest first, for the departments this person may decide on.",
    input_schema: OBJECT({
      department: {
        type: "string",
        enum: [...DEPARTMENT_KEY_LIST],
        description: "Only this department's cards. Defaults to your own department (Chief of Staff: every department).",
      },
    }),
    kind: "read",
  },
  finance_get_metric: {
    name: "finance_get_metric",
    label: "Finance",
    summary: "Read money collected in the last 7 days, progress toward the revenue goal, and recurring revenue",
    description:
      "Read the company's money figures the Finance page shows: collected in the last 7 days, collected toward the active revenue goal and its pace, and monthly recurring revenue with how fresh its sync is. Amounts are in US dollars. A figure that could not be read comes back as unknown.",
    input_schema: OBJECT({
      metric: {
        type: "string",
        enum: ["collected_7d", "goal", "mrr", "all"],
        description: "Which figure. Default all.",
      },
    }),
    kind: "read",
  },
  calendar_upcoming: {
    name: "calendar_upcoming",
    label: "Calendar",
    summary: "List the events on this person's calendar in the Command Center for the next few days",
    description:
      "List the events on this person's own calendar in the Command Center (the Calendar page) from now through the next few days, in order.",
    input_schema: OBJECT({
      days: { type: "number", description: "How many days ahead (default 3, max 14)." },
    }),
    kind: "read",
  },
  connections_status: {
    name: "connections_status",
    label: "Connections",
    summary: "Check which apps this department works through are connected, and what each one gives it",
    description:
      "List the apps this department works through (as Settings > Connections shows them): whether each is connected, needs attention or is not connected, what it reads and what it does. Use it to answer 'what are you connected to'.",
    input_schema: OBJECT(),
    kind: "read",
  },
  propose_email: {
    name: "propose_email",
    label: "Email draft for approval",
    summary: "Draft an email for a person to approve in Needs you (nothing is sent until they approve it)",
    description:
      "Draft an email for a person on the team to approve. NOTHING IS SENT by this tool: it puts an approval card in Needs you, and the email goes out only after a person approves it, through this workspace's own sender. Tell the person it is waiting for approval; never say it was sent.",
    input_schema: OBJECT(
      {
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string", description: "Subject line (one line, at most 200 characters)." },
        body: { type: "string", description: "Plain-text body, exactly as it should be sent." },
        lead_id: { type: "string", description: "Optional id of the lead this email is about." },
        revises_approval_id: { type: "string", description: "When revising a draft that was sent back: that approval's id." },
      },
      ["to", "subject", "body"],
    ),
    kind: "proposal",
  },
};

/**
 * Each department's palette, in the order the model is told about it. A tool
 * that the viewer may not use (a ticket desk they cannot open, company money
 * they may not see) still answers, with "not available to you", rather than
 * being guessed around.
 */
export const DEPARTMENT_PALETTES: Readonly<Record<DepartmentKey, readonly DeskToolName[]>> = {
  chief_of_staff: [
    "department_numbers",
    "approvals_list",
    "pipeline_summary",
    "leads_search",
    "lead_timeline",
    "tickets_list",
    "projects_list",
    "routines_status",
    "calendar_upcoming",
    "connections_status",
    "propose_email",
  ],
  sales: [
    "department_numbers",
    "pipeline_summary",
    "leads_search",
    "lead_timeline",
    "approvals_list",
    "calendar_upcoming",
    "connections_status",
    "propose_email",
  ],
  marketing: ["department_numbers", "approvals_list", "connections_status"],
  client_success: [
    "department_numbers",
    "tickets_list",
    "projects_list",
    "leads_search",
    "lead_timeline",
    "approvals_list",
    "calendar_upcoming",
    "connections_status",
    "propose_email",
  ],
  finance: ["department_numbers", "finance_get_metric", "approvals_list", "connections_status"],
  operations: ["department_numbers", "routines_status", "connections_status", "approvals_list"],
};

/**
 * The tools a department's turn is offered. Plan mode (the channel's /plan)
 * keeps the reads and drops every proposal: plan mode is research only. A
 * member who may not act (canAct false: read_only) gets no proposal either;
 * ./tools.ts enforces the same rule again when a tool runs.
 */
export function deskPalette(dept: DepartmentKey, opts: { planMode?: boolean; canAct?: boolean } = {}): DeskTool[] {
  const names = DEPARTMENT_PALETTES[dept] ?? [];
  const proposals = !opts.planMode && opts.canAct !== false;
  return names.map((n) => DESK_TOOLS[n]).filter((t) => proposals || t.kind !== "proposal");
}

/**
 * Can this provider look things up? Anthropic, OpenAI, OpenRouter and Google
 * Gemini run the tool loop (./turn.ts). A local model server does not: its
 * tool support varies by model and its address is the operator's machine, so
 * the turn answers from the state block alone and says so.
 */
export type DeskToolSupport = { on: true } | { on: false; reason: string };

const TOOL_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "openai", "openrouter", "google"]);

export function deskToolSupport(provider: string): DeskToolSupport {
  if (TOOL_PROVIDERS.has(provider)) return { on: true };
  if (provider === "ollama") {
    return {
      on: false,
      reason: "this workspace's AI account runs on a local model, which cannot look things up in the workspace",
    };
  }
  return { on: false, reason: "this workspace's AI provider cannot look things up in the workspace" };
}

/**
 * The line a department channel shows when its AI account cannot look things
 * up (the chat route's `agent` event `tools`, ./turn.ts): the reason, as the
 * route words it. Null when lookups are on, or for any other chat.
 */
export function deskToolsNote(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as { on?: unknown; note?: unknown };
  if (t.on === true) return null;
  return typeof t.note === "string" && t.note.trim() ? t.note.trim() : null;
}

/** The chip label for a tool name (an unknown name is shown as "a lookup", never its raw name). */
export function deskToolLabel(name: string): string {
  return (DESK_TOOLS as Record<string, DeskTool | undefined>)[name]?.label ?? "a lookup";
}
