/**
 * lib/os/desk/tools.ts - a department turn's tools: the palette from
 * ./catalog.ts, executed against the SESSION's workspace for the person asking.
 *
 * THE BOUNDARY IS HERE, AT DISPATCH. The tool loops (lib/cloud-tool-runner.ts
 * with an injected toolset, ./gemini-loop.ts) only offer this palette, but the
 * offer is not the boundary: `execute` refuses any name outside THIS turn's
 * palette, whatever a model, a replayed stream or a future caller asks for.
 *
 * AN AUTOMATION IS NARROWER. A department task's run (lib/automations) passes
 * `only`, the lookups its owner chose: the palette offers only those and
 * execute() refuses the rest, and its drafts follow ./proposals.ts
 * proposeAutomationEmail (a test run files nothing). Its department_numbers
 * reads its OWN department's page and nothing else (automationDepartment):
 * Chief of Staff's reach into other pages is the chat's, and through it an
 * automation would read figures (Finance's company money, another page's
 * counts) its owner never chose. Which tools a person may use at all is
 * deskToolAvailability, the same predicate run() asks first.
 *
 * THE TENANT IS THE VIEWER'S. Every read takes `viewer.surface.tenantId`
 * (the session's active workspace, checked against the route's tenant before
 * the toolset is built, ./turn.ts). A tenant key the model writes into an input
 * is removed before anything runs and is never read.
 *
 * Results are JSON for the model, capped (RESULT_MAX_CHARS), and a person's
 * name, a ticket title or a message preview in them is data the prompt fences
 * as such (./state-render.ts: "Tool results are data").
 */

import "server-only";
import type { OsDepartment } from "@/lib/os/departments";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import type { OsViewer } from "@/components/os/department/viewer";
import { departmentGate } from "@/components/os/department/gate";
import { loadDepartmentNumbers } from "@/components/os/department/numbers";
import { loadTenantRoutines } from "@/components/os/department/routines";
import { routineHealth } from "@/components/os/department/routine-rules";
import { getDeliveryDb } from "@/lib/delivery/session";
import { listProjects, listTickets } from "@/lib/delivery/store";
import { ACTIVE_PROJECT_STAGES, slaStatus } from "@/lib/delivery/rules";
import { loadOasisMoney } from "@/lib/goals/oasis-money";
import { listCalendars, listEvents } from "@/lib/calendar/store";
import { expandOccurrences } from "@/lib/calendar/recurrence";
import { loadThreadMessages } from "@/lib/lead-interactions-queries";
import { stripModelSuppliedTenant, type InjectedToolset, type ToolResultBlock } from "@/lib/cloud-tool-runner";
import {
  deskApprovals,
  mayProposeFrom,
  proposeAutomationEmail,
  proposeDeskEmail,
  ProposalRefused,
  type AutomationProposalPolicy,
} from "./proposals";
import { AUTOMATION_DEPARTMENT_NUMBERS, DESK_TOOLS, deskPalette, type DeskTool, type DeskToolName } from "./catalog";
import { followUpsFrom, leadLine, openLead, pipelineScope, readPipeline, searchLeads } from "./reads";
import { deskDeliveryViewer, loadDeskConnections } from "./state";

export const RESULT_MAX_CHARS = 12_000;

export type DeskToolContext = {
  viewer: OsViewer;
  dept: OsDepartment;
  /** The department's agent: the approval card's requester (propose_email). */
  agentSlug: string;
  planMode?: boolean;
  /**
   * An automation's allowlist (lib/automations): only these tools are offered,
   * and execute() refuses every other one, even one the department has. Absent:
   * the department's whole palette (a chat). An empty list offers nothing.
   */
  only?: readonly DeskToolName[];
  /**
   * An automation's proposal rules (./proposals.ts proposeAutomationEmail).
   * With an allowlist (`only`), propose_email runs only under these rules; an
   * allowlist without them never offers it.
   */
  proposal?: AutomationProposalPolicy;
  /** For tests: the clock. */
  nowMs?: () => number;
};

/** The Operations page's own gate (components/os/department/gate.ts): owners and admins. */
export function mayOpenOperations(viewer: OsViewer): boolean {
  const ops = OS_DEPARTMENTS.find((d) => d.key === "operations");
  return !!ops && departmentGate(ops.slug, viewer.navInput) !== null;
}

class NotAvailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NotAvailable";
  }
}

export type DeskToolAvailability = { ok: true } | { ok: false; reason: string };

/**
 * Whether this person may use this tool at all, by the gate of the page behind
 * it. THE predicate run() enforces (run() asks it first), exported so a screen
 * that offers tools (the automation setup) offers exactly what would run.
 * A tool that is available can still fail to read; that is said separately.
 */
export function deskToolAvailability(name: DeskToolName, viewer: OsViewer): DeskToolAvailability {
  switch (name) {
    case "pipeline_summary":
    case "leads_search":
    case "lead_timeline":
      return pipelineScope(viewer) ? { ok: true } : { ok: false, reason: "no_access_to_leads" };
    case "tickets_list":
      return deskDeliveryViewer(viewer).ok ? { ok: true } : { ok: false, reason: "no_access_to_tickets" };
    case "projects_list":
      return deskDeliveryViewer(viewer).ok ? { ok: true } : { ok: false, reason: "no_access_to_projects" };
    case "routines_status":
      // Routines are the Operations page's data: its gate (owners and admins),
      // whichever department asks (Chief of Staff is open to members).
      return mayOpenOperations(viewer) ? { ok: true } : { ok: false, reason: "routines_not_available_to_you" };
    case "finance_get_metric":
      // The Finance page's own two locks (numbers.ts financeNumbers).
      return viewer.oasis && viewer.surface.capabilities.canSeeCompanyFinancials ? { ok: true } : { ok: false, reason: "company_money_not_available_to_you" };
    case "propose_email":
      return mayProposeFrom(viewer) ? { ok: true } : { ok: false, reason: "read_only_member_cannot_propose" };
    case "department_numbers":
    case "approvals_list":
    case "calendar_upcoming":
    case "connections_status":
      return { ok: true };
    default: {
      const unknown: never = name;
      return { ok: false, reason: `unknown_tool:${String(unknown)}` };
    }
  }
}

const num = (v: unknown, dflt: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(Math.floor(n), max)) : dflt;
};
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function result(name: string, data: unknown, summary: string): ToolResultBlock {
  let content = JSON.stringify(data);
  if (content.length > RESULT_MAX_CHARS) content = JSON.stringify({ truncated: true, partial: content.slice(0, RESULT_MAX_CHARS) });
  return { content, is_error: false, summary: `${DESK_TOOLS[name as DeskToolName]?.label ?? name}: ${summary}` };
}

function refused(name: string, error: string): ToolResultBlock {
  return { content: JSON.stringify({ error, tool: name }), is_error: true, summary: `${name} refused: ${error}` };
}

/**
 * The department a department_numbers / approvals_list call may read in a
 * CHAT. An automation's department_numbers never comes here
 * (automationDepartment). Its approvals_list may: Chief of Staff's approvals
 * are every department's already (deskApprovals with no department), so
 * naming one only narrows what its owner chose to let it read.
 */
function targetDepartment(ctx: DeskToolContext, raw: unknown): OsDepartment {
  const key = text(raw);
  if (!key || key === ctx.dept.key) return ctx.dept;
  // Only Chief of Staff reads across departments, and only the ones this
  // person's rail opens (the page gate).
  if (ctx.dept.key !== "chief_of_staff") throw new NotAvailable("only_your_own_department");
  const d = OS_DEPARTMENTS.find((x) => x.key === key);
  if (!d || departmentGate(d.slug, ctx.viewer.navInput) === null) throw new NotAvailable("department_not_open_to_you");
  return d;
}

/**
 * The page an AUTOMATION's department_numbers reads: its own department's,
 * the "Always included" numbers its owner was shown, whatever department the
 * model names (Chief of Staff included).
 */
function automationDepartment(ctx: DeskToolContext, raw: unknown): OsDepartment {
  const key = text(raw);
  if (key && key !== ctx.dept.key) throw new NotAvailable("automation_reads_its_own_department_only");
  return ctx.dept;
}

type RunState = { proposed: number };

async function run(name: DeskToolName, input: Record<string, unknown>, ctx: DeskToolContext, state: RunState): Promise<ToolResultBlock> {
  const v = ctx.viewer;
  const nowMs = (ctx.nowMs ?? Date.now)();
  // The page gate, asked first and in one place (deskToolAvailability).
  const available = deskToolAvailability(name, v);
  if (!available.ok) throw new NotAvailable(available.reason);
  switch (name) {
    case "department_numbers": {
      // An automation: its own page only (automationDepartment). A chat: Chief
      // of Staff may read another page its rail opens (targetDepartment).
      const d = ctx.only ? automationDepartment(ctx, input.department) : targetDepartment(ctx, input.department);
      const n = await loadDepartmentNumbers(d, v, await loadTenantRoutines(v.surface.tenantId));
      // An automation gets the page's COUNTS: a Needs-you line can carry a
      // title (an alert, a reply's subject) it was not given to read.
      const waiting = n.attention.reduce((sum, a) => sum + a.count, 0);
      return result(name, {
        department: d.label,
        numbers: n.tiles.map((t) => ({
          label: t.label,
          value: t.status === "live" ? t.value : null,
          state: t.status === "live" ? "known" : t.status === "error" ? "could_not_be_read" : t.emptyText || t.status,
          hint: t.hint ?? null,
        })),
        ...(ctx.only ? { needs_you_count: waiting } : { needs_you: n.attention.map((a) => ({ item: a.label, count: a.count })) }),
      }, `${d.label}, ${n.tiles.length} numbers`);
    }
    case "pipeline_summary": {
      const p = await readPipeline(v);
      if (p === null) throw new NotAvailable("no_access_to_leads");
      if (!p.ok) throw new Error("pipeline_could_not_be_read");
      const f = followUpsFrom(p.value, nowMs);
      const lite = (l: { id: string; name: string; at: number }) => ({ id: l.id, name: l.name, at: l.at ? new Date(l.at).toISOString() : null });
      return result(name, {
        scope: p.value.own ? "your own leads" : "whole pipeline",
        total: p.value.total,
        counts_may_be_a_floor: p.value.partial,
        stages: p.value.stages,
        follow_ups_past_due: f.overdue.slice(0, 15).map(lite),
        meetings_with_no_outcome: f.outcomeMissing.slice(0, 15).map(lite),
        meetings_today: f.meetingsToday.slice(0, 15).map(lite),
        open_leads_with_no_next_step: f.noNextStep,
      }, `${p.value.total} leads`);
    }
    case "leads_search": {
      const r = await searchLeads(v, { query: text(input.query), stage: text(input.stage), limit: num(input.limit, 10, 1, 15) });
      if (r === null) throw new NotAvailable("no_access_to_leads");
      return result(name, { scope: r.own ? "your own leads" : "whole pipeline", leads: r.leads }, `${r.leads.length} found`);
    }
    case "lead_timeline": {
      const id = text(input.lead_id);
      const lead = await openLead(v, id);
      if (lead === "no_scope") throw new NotAvailable("no_access_to_leads");
      if (!lead) throw new NotAvailable("lead_not_found");
      const thread = await loadThreadMessages(v.surface.tenantId, `lead:${lead.id}`, { limit: 15 });
      const messages = (thread?.messages ?? [])
        .slice(-15)
        .reverse()
        .map((m) => ({ at: m.at, channel: m.channel, direction: m.direction, subject: m.subject, preview: (m.preview || "").slice(0, 300) }));
      return result(name, { lead: leadLine(lead), history: messages, history_note: thread ? null : "no history found, or it could not be read" }, `${messages.length} entries`);
    }
    case "tickets_list": {
      const access = deskDeliveryViewer(v);
      if (!access.ok) throw new NotAvailable("no_access_to_tickets");
      const db = getDeliveryDb();
      if (!db) throw new Error("tickets_could_not_be_read");
      const status = text(input.status) === "closed" ? "closed" : "open";
      const res = await listTickets(db, access.viewer, { status });
      const now = new Date(nowMs);
      return result(name, {
        status,
        more_exist: res.truncated,
        tickets: res.rows.slice(0, 25).map((t) => ({
          number: t.ticket_number,
          title: t.title,
          client: t.client_company || t.client_name || t.client_tenant_name || null,
          severity: t.severity,
          status: t.status,
          first_response: slaStatus(t, now).state,
          project: t.project_title,
          created_at: t.created_at,
        })),
      }, `${res.rows.length}${res.truncated ? "+" : ""} ${status}`);
    }
    case "projects_list": {
      const access = deskDeliveryViewer(v);
      if (!access.ok) throw new NotAvailable("no_access_to_projects");
      const db = getDeliveryDb();
      if (!db) throw new Error("projects_could_not_be_read");
      const res = await listProjects(db, access.viewer, { includeArchived: false });
      const active = res.rows.filter((p) => (ACTIVE_PROJECT_STAGES as readonly string[]).includes(p.stage));
      return result(name, {
        more_exist: res.truncated,
        projects: active.slice(0, 25).map((p) => ({
          title: p.title,
          client: p.client_name || p.client_tenant_name || null,
          stage: p.stage,
          due_date: p.due_date,
          tasks: `${p.tasks_done} of ${p.task_count} done`,
          open_tickets: p.open_ticket_count,
        })),
      }, `${active.length} active`);
    }
    case "routines_status": {
      // The Operations gate was asked above (deskToolAvailability).
      const r = await loadTenantRoutines(v.surface.tenantId);
      if (!r.ok) throw new Error("routines_could_not_be_read");
      const h = routineHealth(r.value, nowMs);
      return result(name, {
        total: h.total,
        on: h.on,
        failed_last_24h: h.failed24h.map((x) => x.name),
        last_clean_run: h.lastSuccessAt,
        routines: r.value.slice(0, 30).map((x) => ({ name: x.name, schedule: x.schedule, on: x.enabled, last_run_at: x.lastRunAt, last_result: x.lastRunStatus })),
      }, `${h.on} of ${h.total} on`);
    }
    case "approvals_list": {
      // An owner or admin: what Needs you shows them. Anyone else: only the
      // drafts they proposed themselves (./proposals.ts).
      const d = text(input.department) ? targetDepartment(ctx, input.department) : ctx.dept;
      const r = await deskApprovals(v, d.key === "chief_of_staff" ? null : d.key, 15);
      return result(name, {
        scope: r.own ? "drafts you proposed" : "waiting for you in Needs you",
        waiting: r.total,
        cards: r.items,
      }, `${r.total} waiting`);
    }
    case "finance_get_metric": {
      // The Finance page's own two locks were asked above (deskToolAvailability).
      const metric = text(input.metric) || "all";
      const m = await loadOasisMoney(v.surface.tenantId, "os.desk.finance");
      const usd = (c: number | null | undefined) => (typeof c === "number" ? Math.round(c) / 100 : null);
      const out: Record<string, unknown> = { currency: "USD" };
      if (metric === "collected_7d" || metric === "all") {
        out.collected_last_7_days = m.last7 ? { amount: usd(m.last7.usd_cents), payments: m.last7.payments } : "could_not_be_read";
      }
      if (metric === "goal" || metric === "all") {
        out.revenue_goal = !m.goal
          ? "no_active_goal"
          : {
              target: usd(m.goal.target_cents),
              ends: m.goal.period_end,
              collected: m.collected ? usd(m.collected.usd_cents) : "could_not_be_read",
              pace: m.progress ? { percent: Math.round(m.progress.pct), status: m.progress.status, days_left: m.progress.days_left } : "could_not_be_read",
            };
      }
      if (metric === "mrr" || metric === "all") {
        out.monthly_recurring_revenue =
          m.stripeConnected === false
            ? "stripe_not_connected"
            : m.mrrUsdCents === null
              ? "could_not_be_read"
              : { amount: usd(m.mrrUsdCents), last_synced: m.stripeSync.ok ? m.stripeSync.lastSyncAt : "could_not_be_read" };
      }
      return result(name, out, metric);
    }
    case "calendar_upcoming": {
      const days = num(input.days, 3, 1, 14);
      const owner = { tenantId: v.surface.tenantId, userId: v.surface.userId };
      const [calendars, { events, truncated }] = await Promise.all([listCalendars(owner, { create: false }), listEvents(owner)]);
      const visible = new Set(calendars.filter((c) => c.visible).map((c) => c.id));
      const occ = expandOccurrences(events, new Date(nowMs), new Date(nowMs + days * 86_400_000))
        .filter((o) => visible.size === 0 || visible.has(o.event.calendarId))
        .sort((a, b) => a.start.getTime() - b.start.getTime());
      return result(name, {
        days,
        more_may_exist: truncated,
        events: occ.slice(0, 25).map((o) => ({ title: o.event.title, start: o.start.toISOString(), end: o.end.toISOString(), all_day: o.allDay, location: o.event.location || null })),
      }, `${occ.length} in ${days} days`);
    }
    case "connections_status": {
      const list = await loadDeskConnections(v, ctx.dept, nowMs);
      return result(name, {
        apps: list.map((c) => ({ app: c.name, status: c.status ?? "visible to owners and admins only", connected: c.status === null ? "unknown" : c.connected, reads: c.reads, does: c.does })),
      }, `${list.length} apps`);
    }
    case "propose_email": {
      // One approvals card under THIS department, owned by the person asking;
      // nothing is sent (./proposals.ts).
      if (ctx.proposal) {
        // An automation's draft: its own rules, and a test run files nothing.
        const out = await proposeAutomationEmail(v, ctx.dept, ctx.agentSlug, input, new Date(nowMs), ctx.proposal, state);
        return result(name, out, ctx.proposal.mode === "preview" ? "Would have drafted it (test run, nothing filed)" : "waiting in Needs you");
      }
      const out = await proposeDeskEmail(v, ctx.dept, ctx.agentSlug, input, new Date(nowMs));
      return result(name, out, "waiting in Needs you");
    }
    default: {
      const unhandled: never = name;
      throw new Error(`unknown_tool:${String(unhandled)}`);
    }
  }
}

/**
 * The toolset for one department turn: exactly this department's palette (plan
 * mode: reads only), and a dispatcher that refuses anything else.
 */
export function deskToolset(ctx: DeskToolContext): InjectedToolset & { palette: DeskTool[] } {
  // A member who may not act (read_only) is never offered a proposal.
  const canAct = mayProposeFrom(ctx.viewer);
  // Routines only for someone the Operations page opens for (Chief of Staff
  // lists them for owners and admins, not for members).
  const routines = mayOpenOperations(ctx.viewer);
  const departmentPalette = deskPalette(ctx.dept.key, { planMode: ctx.planMode, canAct }).filter((t) => routines || t.name !== "routines_status");
  const allowed = new Set<string>(departmentPalette.map((t) => t.name));
  // An automation's allowlist narrows the department's palette; a proposal
  // needs the automation's proposal rules as well (fail closed without them).
  const automation = ctx.only ? new Set<string>(ctx.only.filter((n) => DESK_TOOLS[n]?.kind !== "proposal" || !!ctx.proposal)) : null;
  // An automation is told what runs for it: department_numbers reads its own
  // page only (run(): automationDepartment), so it is offered that version.
  const palette = automation
    ? departmentPalette.filter((t) => automation.has(t.name)).map((t) => (t.name === "department_numbers" ? AUTOMATION_DEPARTMENT_NUMBERS : t))
    : departmentPalette;
  // Proposals this run made (an automation's cap per run, ./proposals.ts).
  const state: RunState = { proposed: 0 };
  return {
    palette,
    tools: palette.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    async execute(name, rawInput) {
      if (!allowed.has(name)) {
        console.error("[os.desk.tools] refused a tool outside the department palette", { tool: name, department: ctx.dept.key, tenantId: ctx.viewer.surface.tenantId });
        return refused(name, "tool_not_in_this_department");
      }
      // Enforced here, not only by the offer: an automation runs only what its owner chose.
      if (automation && !automation.has(name)) {
        console.error("[os.desk.tools] refused a tool outside the automation's allowlist", { tool: name, department: ctx.dept.key, tenantId: ctx.viewer.surface.tenantId });
        return refused(name, "tool_not_allowed_for_this_automation");
      }
      // Enforced again here, not only by the offer: a proposal needs a member who may act.
      if (DESK_TOOLS[name as DeskToolName].kind === "proposal" && !mayProposeFrom(ctx.viewer)) {
        return refused(name, "read_only_member_cannot_propose");
      }
      const input = stripModelSuppliedTenant(rawInput && typeof rawInput === "object" ? rawInput : {});
      try {
        return await run(name as DeskToolName, input, ctx, state);
      } catch (err) {
        if (err instanceof NotAvailable || err instanceof ProposalRefused) return refused(name, err.message);
        console.error("[os.desk.tools] tool failed", { tool: name, department: ctx.dept.key, error: err instanceof Error ? err.message : String(err) });
        return { content: JSON.stringify({ error: "could_not_be_read", tool: name }), is_error: true, summary: `${DESK_TOOLS[name as DeskToolName].label}: could not be read` };
      }
    },
  };
}
