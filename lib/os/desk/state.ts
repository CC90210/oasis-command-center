/**
 * lib/os/desk/state.ts - load the DEPARTMENT STATE for one department turn,
 * from the SAME loaders the department page (app/team/[dept]/page.tsx) and
 * Today use, for the person asking:
 *
 *   numbers + Needs you   components/os/department/numbers.ts loadDepartmentNumbers
 *   approvals             components/os/approvals/load.ts loadPendingApprovals
 *   pipeline + follow-ups ./reads.ts readPipeline (Sales, Chief of Staff)
 *   open tickets          lib/delivery store, through lib/delivery/access.ts (Client Success)
 *   routines              components/os/department/routines.ts (Operations)
 *   connections           lib/os/connectors.ts, statuses as Settings > Connections
 *                         words them (owners and admins only, like the page)
 *   business profile      the workspace manifest's brand and industry
 *
 * Every read runs under DESK_READ_DEADLINE_MS and fails on its own: one slow
 * or broken source makes its own line say "could not be read", never the turn.
 */

import "server-only";
import type { OsDepartment } from "@/lib/os/departments";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import type { OsViewer } from "@/components/os/department/viewer";
import { departmentGate } from "@/components/os/department/gate";
import { departmentProfile } from "@/components/os/department/config";
import { loadDepartmentNumbers } from "@/components/os/department/numbers";
import { loadTenantRoutines, type Read } from "@/components/os/department/routines";
import type { RoutineRow } from "@/components/os/department/routine-rules";
import { loadPendingApprovals } from "@/components/os/approvals/load";
import { approvalScopeFromViewer } from "@/lib/os/approvals/scope";
import { loadConnectorFacts } from "@/components/os/connections/connector-facts";
import {
  CONNECTOR_CATALOG,
  connectionSetUp,
  connectorBySlug,
  resolveConnectorStatus,
  type ConnectorDef,
} from "@/lib/os/connectors";
import { resolveDeliveryViewer } from "@/lib/delivery/access";
import { getDeliveryDb } from "@/lib/delivery/session";
import { listTickets } from "@/lib/delivery/store";
import { slaStatus } from "@/lib/delivery/rules";
import { withDeadline } from "@/lib/os/deadline";
import { deskRead, followUpsFrom, readPipeline } from "./reads";
import type { DeskConnection, DeskStateFacts } from "./state-render";

export const DESK_READ_DEADLINE_MS = 8_000;

function timed<T>(label: string, fn: () => Promise<T>) {
  return deskRead(label, () => withDeadline(fn(), DESK_READ_DEADLINE_MS, `desk.${label}`));
}

/** lib/delivery/access.ts, asked the way the page asks: own desk first, then vendor. */
export function deskDeliveryViewer(viewer: OsViewer) {
  const s = viewer.surface;
  const input = { ok: true as const, persona: s.persona, tenantId: s.tenantId, userId: s.userId, canAct: s.capabilities.canAct };
  const desk = resolveDeliveryViewer(input, { relation: "desk" });
  return desk.ok ? desk : resolveDeliveryViewer(input);
}

/** Owners and admins see each app's status, as on the department page. */
export function seesConnectionStatus(viewer: OsViewer): boolean {
  return viewer.surface.persona === "founder";
}

/**
 * The apps a department works through: the department page's own chips, plus,
 * for Chief of Staff and Operations (which watch every app), every app the
 * workspace has set up. AI models are the AI account, not a department app.
 */
export async function loadDeskConnections(viewer: OsViewer, dept: OsDepartment, nowMs: number): Promise<DeskConnection[]> {
  const chips = departmentProfile(dept.key).connections;
  const defs = new Map<string, { def: ConnectorDef; name: string }>();
  for (const chip of chips) {
    const def = connectorBySlug(chip.connector);
    if (def && !defs.has(def.slug)) defs.set(def.slug, { def, name: chip.label });
  }
  const watchesAll = dept.key === "chief_of_staff" || dept.key === "operations";
  if (!seesConnectionStatus(viewer)) {
    return [...defs.values()].map(({ def, name }) => ({ name, status: null, connected: false, reads: def.reads, does: def.does }));
  }
  const facts = await loadConnectorFacts({ tenantId: viewer.surface.tenantId, userId: viewer.surface.userId, personal: false });
  const out: DeskConnection[] = [];
  const add = (def: ConnectorDef, name: string) => {
    const status = resolveConnectorStatus(def, facts, nowMs);
    out.push({ name, status: status.label, connected: status.kind === "connected", reads: def.reads, does: def.does });
  };
  for (const { def, name } of defs.values()) add(def, name);
  if (watchesAll) {
    for (const def of CONNECTOR_CATALOG) {
      if (defs.has(def.slug) || def.category === "ai_models" || !def.live) continue;
      if (connectionSetUp(resolveConnectorStatus(def, facts, nowMs))) add(def, def.name);
    }
  }
  return out;
}

export async function loadOpenTickets(viewer: OsViewer, nowMs: number) {
  const access = deskDeliveryViewer(viewer);
  if (!access.ok) return "no_scope" as const;
  const db = getDeliveryDb();
  if (!db) throw new Error("delivery database not configured");
  const res = await listTickets(db, access.viewer, { status: "open" });
  const now = new Date(nowMs);
  return {
    open: res.rows.map((t) => ({
      number: t.ticket_number,
      title: t.title,
      client: t.client_company || t.client_name || t.client_tenant_name || null,
      severity: t.severity,
      sla: slaStatus(t, now).state.replace(/_/g, " "),
    })),
    truncated: res.truncated,
  };
}

function routineLines(rows: readonly RoutineRow[]) {
  return rows.map((r) => ({ name: r.name, enabled: r.enabled, schedule: r.schedule, lastRunStatus: r.lastRunStatus, lastRunAt: r.lastRunAt }));
}

export async function loadDepartmentState(viewer: OsViewer, dept: OsDepartment, nowMs = Date.now()): Promise<DeskStateFacts> {
  const routinesRead: Promise<Read<RoutineRow[]>> = loadTenantRoutines(viewer.surface.tenantId);
  const wantsPipeline = dept.key === "sales" || dept.key === "chief_of_staff";
  const [numbers, approvals, pipeline, tickets, routines, connections] = await Promise.all([
    timed("numbers", async () => loadDepartmentNumbers(dept, viewer, await routinesRead)),
    timed("approvals", async () => {
      const r = await loadPendingApprovals({
        scope: approvalScopeFromViewer({ surface: viewer.surface, navInput: viewer.navInput }),
        tenantSlug: viewer.surface.tenantSlug,
        department: dept.key === "chief_of_staff" ? null : dept.key,
        limit: 5,
      });
      if (!r.ok) throw new Error("approvals read failed");
      return r.value;
    }),
    wantsPipeline ? timed("pipeline", async () => readPipeline(viewer)) : Promise.resolve(null),
    dept.key === "client_success" ? timed("tickets", () => loadOpenTickets(viewer, nowMs)) : Promise.resolve(null),
    dept.key === "operations"
      ? timed("routines", async () => {
          const r = await routinesRead;
          if (!r.ok) throw new Error("routines read failed");
          return r.value;
        })
      : Promise.resolve(null),
    timed("connections", () => loadDeskConnections(viewer, dept, nowMs)),
  ]);

  const manifest = viewer.manifest;
  const facts: DeskStateFacts = {
    department: { key: dept.key, label: dept.label, purpose: departmentProfile(dept.key).purpose },
    business: {
      name: manifest.brand?.name || viewer.surface.tenantSlug || "This workspace",
      subtitle: manifest.brand?.subtitle || "",
      industry: typeof manifest.onboarding_industry === "string" ? manifest.onboarding_industry : null,
      departments: OS_DEPARTMENTS.filter((d) => departmentGate(d.slug, viewer.navInput) !== null).map((d) => d.label),
    },
    readAt: new Date(nowMs).toISOString(),
    tiles: numbers.ok ? numbers.value.tiles : null,
    attention: numbers.ok ? numbers.value.attention.map((a) => ({ label: a.label, count: a.count })) : null,
    approvals: approvals.ok
      ? { total: approvals.value.total, items: approvals.value.items.map((a) => ({ title: a.title, department: a.department_label })) }
      : null,
    connections: connections.ok ? connections.value : null,
  };
  if (wantsPipeline && pipeline) {
    if (!pipeline.ok) facts.pipeline = null;
    else if (pipeline.value === null) facts.pipeline = "no_scope";
    else if (!pipeline.value.ok) facts.pipeline = null;
    else {
      const p = pipeline.value.value;
      const f = followUpsFrom(p, nowMs);
      facts.pipeline = { own: p.own, stages: p.stages, total: p.total, partial: p.partial, ...f };
    }
  }
  if (dept.key === "client_success" && tickets) facts.tickets = tickets.ok ? tickets.value : null;
  if (dept.key === "operations" && routines) facts.routines = routines.ok ? routineLines(routines.value) : null;
  return facts;
}
