/**
 * lib/automations/guided-service.ts - what the guided-automation routes do.
 *
 * The routes under app/api/automations/guided/* are thin: each calls one function here and sends back
 * `{ status, body }`. Everything that decides what is allowed lives in this file and in the contract
 * (lib/automations/guided/validate.ts) and the run engine (lib/os/runs/guided-run.ts):
 *
 *   - WHO. Tenant and person come from the session (getSessionContext), never the body. Building needs
 *     an owner or admin (canManageTeam); a department needs that person's own department gate; only the
 *     OWNER of an automation may edit, test, turn on or delete it. Anyone who manages the workspace may
 *     PAUSE one (the same rule as every other scheduled job: someone else may switch it off, never on).
 *   - WHAT. The payload is validated by validateGuidedPayload with the person's own company-financials
 *     right; the row stores the payload the validator returned, never the body's.
 *   - WHEN IT MAY RUN. Turn on runs preflightGuidedAutomation, the exact check every scheduled run makes
 *     (seat, department, connections, lookups, AI account). A change to a turned-on automation pauses it.
 *   - COST. A cap on automations per workspace and on tests per person per hour, kept in the database
 *     (not in memory) because Workers isolates do not share memory.
 *
 * Saved rows are tenant_cron_jobs with action_type "department_task". The script routes still refuse
 * that type (lib/automations/action-types.ts), so a guided row is only ever changed through here.
 */
import "server-only";

import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { departmentChannelFor } from "@/components/os/department/config";
import { departmentGate } from "@/components/os/department/gate";
import { resolveOsViewerFor, type OsViewer } from "@/components/os/department/viewer";
import { loadWorkspaceConnectorStatus } from "@/components/os/connections/connector-facts";
import { hasUsableKey, readWorkspaceAiAccount } from "@/lib/ai/workspace-account";
import { isApiEngineProvider } from "@/lib/ai/agent-engine";
import { toggleCronWithAudit } from "@/lib/automations/cron-toggle-transaction";
import { GUIDED_ACTION_TYPE, GUIDED_PAYLOAD_VERSION, type GuidedPayload, type InputValues } from "@/lib/automations/guided/types";
import { ALL_TEMPLATES, templateById } from "@/lib/automations/guided/templates";
import { GUIDED_ZONE, hasControlChars, requiredConnectors, validateGuidedPayload } from "@/lib/automations/guided/validate";
import { whenText } from "@/lib/automations/guided/view";
import type {
  ApiFailure,
  CloudState,
  ConnectionFact,
  ConnectionState,
  GuidedAutomationView,
  GuidedContextView,
  GuidedStatus,
  LastRunView,
  Problem,
  RepairLink,
  RunHistoryItem,
  RunReceipt,
  TestResult,
} from "@/lib/automations/guided/api-types";
import { nextRuns, planToCron, validatePlan } from "@/lib/automations/schedule-plan";
import type { DeskToolName } from "@/lib/os/desk/catalog";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { connectorBySlug } from "@/lib/os/connectors";
import { GuidedPreflightUnavailable, plainFailure, preflightGuidedAutomation, runGuidedAutomation, type GuidedAutomationRow } from "@/lib/os/runs/guided-run";
import { automationHasLiveRun } from "@/lib/os/runs/store";
import { redactAll } from "@/lib/secret-redaction";
import { setupHref } from "@/lib/setup-links";
import { getSessionUser } from "@/lib/supabase-server";
import { canManageTeam, getSessionContext } from "@/lib/team";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export type ServiceResult<T> = { status: number; body: ({ ok: true } & T) | ApiFailure };

/** At most this many guided automations in one workspace. */
export const MAX_GUIDED_PER_WORKSPACE = 30;
/** At most this many Test now runs per person per hour: each one calls the workspace's AI account. */
export const MAX_TESTS_PER_HOUR = 12;
const NAME_MAX = 80;

// ── session ──────────────────────────────────────────────────────────────

export type GuidedSession = { tenantId: string; userId: string; email: string | null; viewer: OsViewer; db: Client };

export async function guidedSession(): Promise<{ ok: true; session: GuidedSession } | { ok: false; status: number; body: ApiFailure }> {
  if (!tursoConfigured()) return { ok: false, status: 503, body: fail("server_error", "Automations are not available on this deployment yet.") };
  const ctx = await getSessionContext();
  if (!ctx) return { ok: false, status: 401, body: fail("unauthorized", "Sign in to build automations.") };
  if (!canManageTeam(ctx.teamRole, ctx.adminAccess)) {
    return { ok: false, status: 403, body: fail("forbidden", "Only owners and admins can build automations.") };
  }
  const viewer = await resolveOsViewerFor(ctx.tenantId, ctx.authUserId);
  if (!viewer.ok) return { ok: false, status: 403, body: fail("forbidden", "We could not confirm your access to this workspace. Nothing was changed.") };
  let email: string | null = null;
  try {
    const user = await getSessionUser();
    if (!user || user.id !== ctx.authUserId) return { ok: false, status: 401, body: fail("unauthorized", "Sign in again to build automations.") };
    email = user.email ?? null;
  } catch {
    return { ok: false, status: 503, body: fail("server_error", "We could not confirm your session just now. Nothing was changed.") };
  }
  return { ok: true, session: { tenantId: ctx.tenantId, userId: ctx.authUserId, email, viewer, db: getTursoClient() } };
}

function fail(error: string, message: string, extra: Partial<ApiFailure> = {}): ApiFailure {
  return { ok: false, error, message, ...extra };
}

const notFound = (): ServiceResult<never> => ({ status: 404, body: fail("not_found", "We could not find that automation. It may have been deleted.") });

// ── context ──────────────────────────────────────────────────────────────

const CONNECTION_REPAIR = (slug: string, label: string): RepairLink => ({ label: `Open ${label}`, href: setupHref(`connector:${slug}`) });

function connectionState(kind: string | undefined): ConnectionState {
  if (kind === "connected") return "connected";
  if (kind === "attention" || kind === "configured") return "attention";
  if (kind === "not_connected" || kind === "coming_soon") return "not_connected";
  return "unknown";
}

/** Every connection any template can need, with the state Settings > Connections shows for it. */
async function connectionFacts(tenantId: string, now: Date): Promise<ConnectionFact[]> {
  const slugs = new Set<string>(["google-workspace"]);
  for (const t of ALL_TEMPLATES) for (const s of t.requires) slugs.add(s);
  const facts: ConnectionFact[] = [];
  for (const slug of slugs) {
    const label = connectorBySlug(slug)?.name ?? slug;
    let kind: string | undefined;
    try {
      kind = (await loadWorkspaceConnectorStatus(tenantId, slug, now.getTime()))?.kind;
    } catch {
      console.error("[guided.context.connection]", { tenantId, slug });
    }
    const state = connectionState(kind);
    facts.push({ slug, label, state, repair: state === "connected" ? null : CONNECTION_REPAIR(slug, label) });
  }
  return facts;
}

async function cloudState(tenantId: string): Promise<CloudState> {
  try {
    const account = await readWorkspaceAiAccount(tenantId);
    const repair = { label: "Open AI brain", href: setupHref("ai_account") };
    if (!hasUsableKey(account)) return { ready: false, reason: "No AI account is connected to this workspace.", repair };
    if (!isApiEngineProvider(account.provider) || !account.model.trim()) {
      return { ready: false, reason: "This workspace's AI account runs on a local model, which cannot run in the cloud.", repair };
    }
    return { ready: true, reason: null, repair: null };
  } catch {
    console.error("[guided.context.cloud]", { tenantId });
    return { ready: false, reason: "We could not check the workspace AI account just now.", repair: null };
  }
}

function departmentsFor(viewer: OsViewer): GuidedContextView["departments"] {
  return OS_DEPARTMENTS.filter(
    (d) =>
      departmentGate(d.slug, viewer.navInput) &&
      departmentChannelFor(d.key, { oasis: viewer.oasis, manifest: viewer.manifest }).kind === "agent",
  ).map((d) => d.key);
}

async function contextOf(s: GuidedSession, now: Date): Promise<GuidedContextView> {
  const [cloud, connections] = await Promise.all([cloudState(s.tenantId), connectionFacts(s.tenantId, now)]);
  return {
    companyFinancials: s.viewer.surface.capabilities.canSeeCompanyFinancials,
    departments: departmentsFor(s.viewer),
    cloud,
    connections,
  };
}

export async function getContext(s: GuidedSession, now = new Date()): Promise<ServiceResult<{ context: GuidedContextView }>> {
  return { status: 200, body: { ok: true, context: await contextOf(s, now) } };
}

// ── rows and views ───────────────────────────────────────────────────────

type CronRow = GuidedAutomationRow & { description?: string | null; schedule?: string | null; tz?: string | null };

const COLUMNS = "id, tenant_id, agent_key, name, description, schedule, action_type, action_payload, enabled, owner_user_id, last_scheduled_for, tz, created_at, updated_at";

function rowOf(r: Record<string, unknown>): CronRow {
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    owner_user_id: String(r.owner_user_id ?? ""),
    agent_key: String(r.agent_key ?? ""),
    name: String(r.name ?? ""),
    description: str(r.description),
    schedule: str(r.schedule),
    action_type: String(r.action_type ?? ""),
    action_payload: r.action_payload,
    enabled: r.enabled,
    last_scheduled_for: str(r.last_scheduled_for),
    tz: str(r.tz),
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
  };
}

const isEnabled = (v: unknown) => v === 1 || v === true || v === "1" || v === 1n;

function parsePayload(raw: unknown): Record<string, unknown> | null {
  const value = typeof raw === "string" ? safeJson(raw) : raw;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function loadRows(db: Client, tenantId: string, id?: string): Promise<CronRow[]> {
  const rs = await db.execute({
    sql: `SELECT ${COLUMNS} FROM tenant_cron_jobs WHERE tenant_id = ? AND action_type = ?${id ? " AND id = ?" : ""} ORDER BY created_at DESC LIMIT 100`,
    args: id ? [tenantId, GUIDED_ACTION_TYPE, id] : [tenantId, GUIDED_ACTION_TYPE],
  });
  return rs.rows.map((r) => rowOf(r as unknown as Record<string, unknown>));
}

function firstSentence(text: string | null): string {
  const clean = (text ?? "").replace(/[#*_>`]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return "Finished with nothing to report.";
  const cut = clean.match(/^.{20,160}?[.!?](\s|$)/)?.[0]?.trim() ?? clean.slice(0, 160);
  return cut.length < clean.length && !/[.!?]$/.test(cut) ? `${cut}...` : cut;
}

/** The sentence for a run that did not finish well. */
export function failureSentence(code: string | null): string {
  switch (code) {
    case "run_timeout":
      return "It took longer than its time limit and was stopped.";
    case "stream_failed":
    case "provider_error":
      return "The AI account did not answer. Try again in a minute.";
    case null:
    case "":
      return "It could not finish. Try again in a minute.";
    default:
      // plainFailure reads the one copy table (provider errors, run failures, refusals) for every other code.
      return plainFailure(code);
  }
}

function lastRunOf(r: Record<string, unknown>): LastRunView {
  const status = String(r.status ?? "");
  const code = r.error_code ? String(r.error_code) : null;
  const summary =
    status === "done"
      ? firstSentence(r.final_text ? redactAll(String(r.final_text)) : null)
      : status === "missed"
        ? "It missed its scheduled time and was not run late."
        : status === "cancelled"
          ? "It was stopped before it finished."
          : status === "running" || status === "queued"
            ? "Running now."
            : failureSentence(code);
  return { at: String(r.at ?? ""), status, summary, receiptId: r.id ? String(r.id) : null, preview: String(r.origin ?? "") === "test" };
}

async function lastRuns(db: Client, tenantId: string, ids: string[]): Promise<Map<string, LastRunView>> {
  const out = new Map<string, LastRunView>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(",");
  const rs = await db.execute({
    sql: `SELECT r.automation_id, r.id, r.status, r.error_code, r.final_text, r.origin, COALESCE(r.started_at, r.created_at) AS at
          FROM dept_chat_runs r
          WHERE r.tenant_id = ? AND r.automation_id IN (${marks})
            AND r.created_at = (SELECT MAX(r2.created_at) FROM dept_chat_runs r2 WHERE r2.tenant_id = r.tenant_id AND r2.automation_id = r.automation_id)`,
    args: [tenantId, ...ids],
  });
  for (const raw of rs.rows) {
    const r = raw as unknown as Record<string, unknown>;
    const key = String(r.automation_id);
    if (!out.has(key)) out.set(key, lastRunOf(r));
  }
  return out;
}

/** The reasons an automation cannot be turned on (or will not run well) right now, from the shared facts. */
function problemsFor(payload: GuidedPayload, ctx: GuidedContextView): Problem[] {
  const out: Problem[] = [];
  for (const slug of requiredConnectors(payload)) {
    const fact = ctx.connections.find((c) => c.slug === slug);
    if (fact?.state === "connected") continue;
    const label = fact?.label ?? connectorBySlug(slug)?.name ?? slug;
    out.push({
      code: `missing_connection:${slug}`,
      message: fact?.state === "attention" ? `${label} needs attention before this can run.` : `${label} is not connected.`,
      repair: fact?.repair ?? CONNECTION_REPAIR(slug, label),
    });
  }
  if (!ctx.cloud.ready) out.push({ code: "ai_account_unavailable", message: ctx.cloud.reason ?? "The workspace AI account cannot run this right now.", repair: ctx.cloud.repair });
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A stored payload that no longer validates (an old template version, a lookup that left the
 * catalogue) still has to be SHOWN, so a person can read what it was and rebuild it. It is rebuilt
 * field by field into the exact shape the client reads, never cast from the stored JSON: a malformed
 * row (a string where the screen reads an array) must not crash the page for everyone who opens it.
 * Nothing it returns is ever run: only validateGuidedPayload's own output reaches the engine.
 */
export function salvagePayload(raw: Record<string, unknown>): GuidedPayload {
  const department = OS_DEPARTMENTS.find((d) => d.key === raw.department)?.key ?? "chief_of_staff";
  const tpl = isObject(raw.template) ? raw.template : {};
  const inputs: InputValues = {};
  if (isObject(raw.inputs)) {
    for (const [name, value] of Object.entries(raw.inputs).slice(0, 20)) {
      if (typeof value === "number" && Number.isFinite(value)) inputs[name.slice(0, 40)] = value;
      else if (typeof value === "string") inputs[name.slice(0, 40)] = value.slice(0, 400);
    }
  }
  const tools = Array.isArray(raw.tools) ? raw.tools.filter((t): t is string => typeof t === "string").slice(0, 12).map((t) => t.slice(0, 60) as DeskToolName) : [];
  const planned = isObject(raw.schedule) ? validatePlan(raw.schedule.plan) : null;
  const cap = typeof raw.runtime_cap_sec === "number" && raw.runtime_cap_sec > 0 && raw.runtime_cap_sec <= 600 ? raw.runtime_cap_sec : 120;
  return {
    v: GUIDED_PAYLOAD_VERSION,
    template: { id: typeof tpl.id === "string" ? tpl.id.slice(0, 80) : "", version: typeof tpl.version === "number" && Number.isFinite(tpl.version) ? tpl.version : 0 },
    department,
    inputs,
    tools,
    output: raw.output === "email_drafts" ? "email_drafts" : "digest",
    target: { kind: "cloud" },
    approval: "proposal_only",
    runtime_cap_sec: cap,
    schedule: { plan: planned && planned.ok ? planned.plan : { mode: "manual", timezone: GUIDED_ZONE } },
  };
}

/**
 * Whether this person may see this automation. Its owner always can. Anyone else sees it only with
 * the same access the department's own pages need (and the company-financials right for a Finance
 * digest): the list carries the owner's objective and the first line of their last result, which is
 * business data a manager without that department must not read through this screen.
 */
function visibleTo(s: GuidedSession, row: CronRow, raw: Record<string, unknown> | null): boolean {
  if (row.owner_user_id === s.userId) return true;
  const department = OS_DEPARTMENTS.find((d) => d.key === raw?.department);
  if (!department || !departmentGate(department.slug, s.viewer.navInput)) return false;
  const stored = raw && isObject(raw.template) ? raw.template : null;
  const template = templateById(typeof stored?.id === "string" ? stored.id : "", department.key);
  return !(template?.companyFinancialsOnly && !s.viewer.surface.capabilities.canSeeCompanyFinancials);
}

function viewOf(row: CronRow, ctx: GuidedContextView, last: LastRunView | null, now: Date, viewerId: string): GuidedAutomationView | null {
  const raw = parsePayload(row.action_payload);
  if (!raw) return null;
  const validated = validateGuidedPayload(raw, { companyFinancials: ctx.companyFinancials });
  const enabled = isEnabled(row.enabled);
  const shown = validated.ok ? validated.payload : salvagePayload(raw);
  const template = templateById(shown.template.id, shown.department);
  const base = {
    id: row.id,
    name: row.name,
    department: shown.department,
    templateId: template?.id ?? shown.template.id,
    templateTitle: template?.title ?? "Saved automation",
    lastRun: last,
    mine: row.owner_user_id === viewerId,
  };
  if (!validated.ok) {
    return {
      ...base,
      status: "needs_attention",
      payload: shown,
      scheduleSentence: "Not scheduled",
      nextRuns: [],
      problems: [{ code: validated.error, message: `${validated.message} Edit it or rebuild it from a template.`, repair: null }],
    };
  }
  const payload = validated.payload;
  const plan = payload.schedule.plan;
  const problems = problemsFor(payload, ctx);
  const upcoming = enabled && plan.mode !== "manual" ? nextRuns(planToCron(plan), plan.timezone, now, 3).map((d) => d.toISOString()) : [];
  const unhealthy = enabled && (problems.length > 0 || last?.status === "failed");
  const status: GuidedStatus = unhealthy ? "needs_attention" : enabled ? "on" : "paused";
  return { ...base, status, payload, scheduleSentence: whenText(plan), nextRuns: upcoming, problems };
}

export async function listAutomations(s: GuidedSession, now = new Date()): Promise<ServiceResult<{ items: GuidedAutomationView[] }>> {
  const [rows, ctx] = await Promise.all([loadRows(s.db, s.tenantId), contextOf(s, now)]);
  const visible = rows.filter((r) => visibleTo(s, r, parsePayload(r.action_payload)));
  const last = await lastRuns(s.db, s.tenantId, visible.map((r) => r.id));
  const items: GuidedAutomationView[] = [];
  for (const row of visible) {
    const view = viewOf(row, ctx, last.get(row.id) ?? null, now, s.userId);
    if (view) items.push(view);
    else console.error("[guided.list] unreadable payload", { tenantId: s.tenantId, id: row.id });
  }
  return { status: 200, body: { ok: true, items } };
}

async function viewFor(s: GuidedSession, id: string, now: Date): Promise<GuidedAutomationView | null> {
  const [rows, ctx] = await Promise.all([loadRows(s.db, s.tenantId, id), contextOf(s, now)]);
  if (rows.length === 0) return null;
  const last = await lastRuns(s.db, s.tenantId, [id]);
  return viewOf(rows[0], ctx, last.get(id) ?? null, now, s.userId);
}

// ── create / update ──────────────────────────────────────────────────────

function cleanName(raw: unknown, fallback: string): { ok: true; name: string } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, name: fallback };
  if (typeof raw !== "string") return { ok: false, message: "The name must be text." };
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return { ok: true, name: fallback };
  if (name.length > NAME_MAX) return { ok: false, message: `The name can be at most ${NAME_MAX} characters.` };
  if (hasControlChars(name)) return { ok: false, message: "The name must be plain text on one line." };
  return { ok: true, name };
}

type Prepared = { payload: GuidedPayload; agentSlug: string; name: string; description: string; schedule: string };

/** Validate a body, apply the person's own department gate, and build what the row stores. */
async function prepare(s: GuidedSession, body: { name?: unknown; payload?: unknown }, fallbackName: string | null): Promise<{ ok: true; value: Prepared } | { ok: false; status: number; body: ApiFailure }> {
  const validated = validateGuidedPayload(body.payload, { companyFinancials: s.viewer.surface.capabilities.canSeeCompanyFinancials });
  if (!validated.ok) {
    return { ok: false, status: 422, body: fail(validated.error, validated.message, validated.field ? { field: validated.field } : {}) };
  }
  const payload = validated.payload;
  // The owner's words are stored and sent to a model provider on every run: text that is (or contains)
  // one of this deployment's own secrets must never be saved.
  for (const [name, value] of Object.entries(payload.inputs)) {
    if (typeof value === "string" && redactAll(value) !== value) {
      return { ok: false, status: 422, body: fail("input_invalid", "That looks like a password or key, and it would be sent to the AI on every run. Take it out and describe what you need instead.", { field: name }) };
    }
  }
  const department = OS_DEPARTMENTS.find((d) => d.key === payload.department);
  const binding = department && departmentGate(department.slug, s.viewer.navInput) ? departmentChannelFor(payload.department, { oasis: s.viewer.oasis, manifest: s.viewer.manifest }) : null;
  if (!department || !binding || binding.kind !== "agent") {
    return { ok: false, status: 403, body: fail("forbidden", "You do not have access to that department's teammate, so you cannot build for it.", { field: "department" }) };
  }
  const template = templateById(payload.template.id, payload.department);
  const name = cleanName(body.name, fallbackName ?? template?.title ?? "Automation");
  if (!name.ok) return { ok: false, status: 422, body: fail("input_invalid", name.message, { field: "name" }) };
  return {
    ok: true,
    value: {
      payload,
      agentSlug: binding.agentSlug,
      name: name.name,
      description: template?.promise ?? "",
      schedule: planToCron(payload.schedule.plan),
    },
  };
}

export async function createAutomation(s: GuidedSession, body: { name?: unknown; payload?: unknown }, now = new Date()): Promise<ServiceResult<{ item: GuidedAutomationView }>> {
  const prepared = await prepare(s, body, null);
  if (!prepared.ok) return prepared;
  const v = prepared.value;
  const id = randomUUID();
  const stamp = now.toISOString();
  // The count and the insert are ONE statement: two saves at the same moment cannot both pass a cap
  // they each read as 29.
  const inserted = await s.db.execute({
    sql: `INSERT INTO tenant_cron_jobs
            (id, tenant_id, agent_key, name, description, schedule, action_type, action_payload, enabled,
             created_by, owner_user_id, last_scheduled_for, tz, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?
          WHERE (SELECT COUNT(*) FROM tenant_cron_jobs WHERE tenant_id = ? AND action_type = ?) < ?`,
    args: [
      id, s.tenantId, v.agentSlug, v.name, v.description, v.schedule, GUIDED_ACTION_TYPE, JSON.stringify(v.payload), s.userId, s.userId, stamp, v.payload.schedule.plan.timezone, stamp, stamp,
      s.tenantId, GUIDED_ACTION_TYPE, MAX_GUIDED_PER_WORKSPACE,
    ],
  });
  if (inserted.rowsAffected !== 1) {
    return { status: 409, body: fail("limit_reached", `This workspace already has ${MAX_GUIDED_PER_WORKSPACE} guided automations. Delete one you no longer use first.`) };
  }
  const item = await viewFor(s, id, now);
  if (!item) return { status: 500, body: fail("server_error", "It was saved but could not be read back. Reload the page.") };
  return { status: 201, body: { ok: true, item } };
}

/** The row, only if it exists in this workspace and the caller owns it. */
async function ownedRow(s: GuidedSession, id: string): Promise<{ ok: true; row: CronRow } | { ok: false; result: ServiceResult<never> }> {
  const rows = await loadRows(s.db, s.tenantId, id);
  if (rows.length === 0) return { ok: false, result: notFound() };
  if (rows[0].owner_user_id !== s.userId) {
    return {
      ok: false,
      result: { status: 403, body: fail("not_your_automation", "This automation belongs to someone else. You can pause it, but only its owner can change, test, turn on or delete it.") },
    };
  }
  return { ok: true, row: rows[0] };
}

export async function updateAutomation(s: GuidedSession, id: string, body: { name?: unknown; payload?: unknown }, now = new Date()): Promise<ServiceResult<{ item: GuidedAutomationView }>> {
  const owned = await ownedRow(s, id);
  if (!owned.ok) return owned.result;
  const fallbackName = owned.row.name;
  const prepared = await prepare(s, { name: body.name, payload: body.payload ?? parsePayload(owned.row.action_payload) }, fallbackName);
  if (!prepared.ok) return prepared;
  const v = prepared.value;
  // A changed automation is a different automation: it is switched off until it is tested and turned on again.
  const stamp = now.toISOString();
  const r = await s.db.execute({
    sql: `UPDATE tenant_cron_jobs
             SET name = ?, description = ?, schedule = ?, action_payload = ?, agent_key = ?, tz = ?,
                 enabled = 0, last_scheduled_for = ?, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND action_type = ? AND owner_user_id = ?`,
    args: [v.name, v.description, v.schedule, JSON.stringify(v.payload), v.agentSlug, v.payload.schedule.plan.timezone, stamp, stamp, id, s.tenantId, GUIDED_ACTION_TYPE, s.userId],
  });
  if (r.rowsAffected !== 1) return notFound();
  const item = await viewFor(s, id, now);
  return item ? { status: 200, body: { ok: true, item } } : notFound();
}

export async function removeAutomation(s: GuidedSession, id: string): Promise<ServiceResult<Record<never, never>>> {
  const owned = await ownedRow(s, id);
  if (!owned.ok) return owned.result;
  const r = await s.db.execute({
    sql: "DELETE FROM tenant_cron_jobs WHERE id = ? AND tenant_id = ? AND action_type = ? AND owner_user_id = ?",
    args: [id, s.tenantId, GUIDED_ACTION_TYPE, s.userId],
  });
  return r.rowsAffected === 1 ? { status: 200, body: { ok: true } } : notFound();
}

// ── test / activate / pause ──────────────────────────────────────────────

/**
 * Take one of this person's MAX_TESTS_PER_HOUR tests, in a single statement. A count read followed by
 * the run lets a burst of presses all pass the check before any of them is recorded; here the count
 * and the claim are one INSERT, so the 13th concurrent press inserts nothing and is refused. The
 * claim rows live in the workspace audit log (one table, durable across Workers isolates).
 */
async function claimTestSlot(s: GuidedSession, id: string, now: Date): Promise<boolean> {
  const stamp = now.toISOString();
  const since = new Date(now.getTime() - 3_600_000).toISOString();
  const claimed = await s.db.execute({
    sql: `INSERT INTO tenant_audit_log
            (id, tenant_id, actor_user_id, actor_email, action_type, target_table, target_id, metadata, created_at)
          SELECT ?, ?, ?, ?, 'guided_test_claim', 'tenant_cron_jobs', ?, '{}', ?
          WHERE (SELECT COUNT(*) FROM tenant_audit_log
                  WHERE tenant_id = ? AND actor_user_id = ? AND action_type = 'guided_test_claim' AND created_at > ?) < ?`,
    args: [randomUUID(), s.tenantId, s.userId, s.email, id, stamp, s.tenantId, s.userId, since, MAX_TESTS_PER_HOUR],
  });
  return claimed.rowsAffected === 1;
}

export async function testAutomation(s: GuidedSession, id: string, now = new Date()): Promise<ServiceResult<{ result: TestResult }>> {
  const owned = await ownedRow(s, id);
  if (!owned.ok) return owned.result;
  // One run of an automation at a time: a test pressed during a scheduled run (or a second press) would
  // be refused by the run engine anyway; saying so first costs nothing and uses none of the hourly allowance.
  const scope = { tenantId: s.tenantId, userId: s.userId };
  if (await automationHasLiveRun(s.db, scope, id, now)) {
    return { status: 409, body: fail("run_in_progress", "This automation is running right now. Wait for it to finish, then test it again.") };
  }
  if (!(await claimTestSlot(s, id, now))) {
    return { status: 429, body: fail("rate_limited", `You have run ${MAX_TESTS_PER_HOUR} tests in the last hour. Each one uses your AI account, so wait a little before the next.`) };
  }
  // Each test is its own slot: the run engine keys a run by (automation, instant).
  const run = await runGuidedAutomation({ db: s.db, row: owned.row, mode: "preview", scheduledFor: now, now });
  const finished = run.status === "done" || run.status === "failed" || run.status === "cancelled";
  const status: TestResult["status"] = run.status === "done" ? "done" : run.status === "cancelled" ? "cancelled" : "failed";
  const failureText = status === "done" ? null : failureSentence(run.receipt?.errorCode ?? (finished ? null : "run_incomplete"));
  return {
    status: 200,
    body: {
      ok: true,
      result: {
        runId: run.runId,
        status,
        finalText: run.finalText ?? "",
        wouldDraft: run.wouldDraft.map((d) => ({ to: d.to, subject: d.subject, body: d.body })),
        failure: failureText,
      },
    },
  };
}

function repairFor(code: string): { error: string; repair: RepairLink | null; status: number } {
  if (code.startsWith("missing_connection:")) {
    const slug = code.slice("missing_connection:".length);
    const label = connectorBySlug(slug)?.name ?? slug;
    return { error: "connection_missing", repair: CONNECTION_REPAIR(slug, label), status: 409 };
  }
  if (code === "ai_account_unavailable") return { error: "cloud_unavailable", repair: { label: "Open AI brain", href: setupHref("ai_account") }, status: 409 };
  if (code === "owner_inactive" || code === "owner_not_manager" || code === "department_unavailable") return { error: "forbidden", repair: null, status: 403 };
  if (code.startsWith("tool_unavailable:") || code === "tools_invalid") return { error: "tools_invalid", repair: null, status: 409 };
  return { error: code, repair: null, status: 422 };
}

export async function activateAutomation(s: GuidedSession, id: string, now = new Date()): Promise<ServiceResult<{ item: GuidedAutomationView }>> {
  const owned = await ownedRow(s, id);
  if (!owned.ok) return owned.result;
  // Already on: nothing to switch. Re-stamping the schedule here could drop a slot that is due but not yet dispatched.
  if (isEnabled(owned.row.enabled)) {
    const current = await viewFor(s, id, now);
    return current ? { status: 200, body: { ok: true, item: current } } : notFound();
  }
  // The exact check every scheduled run makes. A person can switch on only what could run right now.
  let pre;
  try {
    pre = await preflightGuidedAutomation({ row: owned.row, now });
  } catch (error) {
    if (!(error instanceof GuidedPreflightUnavailable)) throw error;
    return { status: 503, body: fail("server_error", "We could not check your connections and AI account just now. Nothing was changed. Try again in a minute.") };
  }
  if (!pre.ok) {
    const r = repairFor(pre.code);
    return { status: r.status, body: fail(r.error, plainFailure(pre.code, pre.detail), { repair: r.repair }) };
  }
  const toggled = await toggleCronWithAudit(s.db, { source: "tenant", id, tenantId: s.tenantId, enabled: true, actorEmail: s.email, actorUserId: s.userId });
  if (!toggled.ok) return { status: toggled.status, body: fail(String(toggled.body.error ?? "server_error"), String(toggled.body.message ?? "We could not turn it on. Nothing was changed.")) };
  // What was switched on must be the version that was just checked. An edit saved in another tab
  // while the check ran writes a new payload (and switches it off); the switch above would then turn
  // on a version nobody checked. Compare what the switch read back, and undo it if they differ.
  if (canonicalPayload(toggled.row.action_payload) !== canonicalPayload(owned.row.action_payload)) {
    await toggleCronWithAudit(s.db, { source: "tenant", id, tenantId: s.tenantId, enabled: false, actorEmail: s.email, actorUserId: s.userId });
    return { status: 409, body: fail("changed_while_checking", "This automation was changed while we were checking it, so it was not turned on. Look it over and turn it on again.") };
  }
  const item = await viewFor(s, id, now);
  return item ? { status: 200, body: { ok: true, item } } : notFound();
}

/** A stored payload as one comparable string, whether the driver handed back text or an object. */
function canonicalPayload(raw: unknown): string {
  const value = typeof raw === "string" ? safeJson(raw) : raw;
  return JSON.stringify(value ?? null);
}

export async function pauseAutomation(s: GuidedSession, id: string, now = new Date()): Promise<ServiceResult<{ item: GuidedAutomationView }>> {
  // Anyone who manages the workspace may switch one off; the row must still be a guided automation of this workspace.
  const rows = await loadRows(s.db, s.tenantId, id);
  if (rows.length === 0 || !visibleTo(s, rows[0], parsePayload(rows[0].action_payload))) return notFound();
  const toggled = await toggleCronWithAudit(s.db, { source: "tenant", id, tenantId: s.tenantId, enabled: false, actorEmail: s.email, actorUserId: s.userId });
  if (!toggled.ok) return { status: toggled.status, body: fail(String(toggled.body.error ?? "server_error"), String(toggled.body.message ?? "We could not pause it. Nothing was changed.")) };
  const item = await viewFor(s, id, now);
  return item ? { status: 200, body: { ok: true, item } } : notFound();
}

// ── run history and receipts ─────────────────────────────────────────────

const HISTORY_LIMIT = 10;

function historyItemOf(r: Record<string, unknown>): RunHistoryItem {
  const view = lastRunOf(r);
  return { id: String(r.id), at: view.at, origin: view.preview ? "test" : "scheduled", status: view.status, summary: view.summary };
}

/** The automation, only if this person may see it. */
async function visibleRow(s: GuidedSession, id: string): Promise<{ ok: true; row: CronRow } | { ok: false; result: ServiceResult<never> }> {
  const rows = await loadRows(s.db, s.tenantId, id);
  if (rows.length === 0 || !visibleTo(s, rows[0], parsePayload(rows[0].action_payload))) return { ok: false, result: notFound() };
  return { ok: true, row: rows[0] };
}

/** The last runs of one automation, newest first: a scheduled run and a test alike. */
export async function listRunHistory(s: GuidedSession, id: string): Promise<ServiceResult<{ runs: RunHistoryItem[] }>> {
  const seen = await visibleRow(s, id);
  if (!seen.ok) return seen.result;
  const rs = await s.db.execute({
    sql: `SELECT id, status, error_code, final_text, origin, COALESCE(started_at, created_at) AS at
          FROM dept_chat_runs
          WHERE tenant_id = ? AND automation_id = ?
          ORDER BY created_at DESC LIMIT ?`,
    args: [s.tenantId, id, HISTORY_LIMIT],
  });
  return { status: 200, body: { ok: true, runs: rs.rows.map((r) => historyItemOf(r as unknown as Record<string, unknown>)) } };
}

/** One run in full: what it read, what it wrote, and why it failed if it did. Everything is redacted. */
export async function getRunReceipt(s: GuidedSession, id: string, runId: string): Promise<ServiceResult<{ receipt: RunReceipt }>> {
  const seen = await visibleRow(s, id);
  if (!seen.ok) return seen.result;
  const rs = await s.db.execute({
    sql: `SELECT id, status, error_code, final_text, origin, scheduled_for, finished_at, COALESCE(started_at, created_at) AS at
          FROM dept_chat_runs WHERE tenant_id = ? AND automation_id = ? AND id = ?`,
    args: [s.tenantId, id, runId],
  });
  const raw = rs.rows[0] as unknown as Record<string, unknown> | undefined;
  if (!raw) return notFound();
  const events = await s.db.execute({
    sql: `SELECT seq, data_json FROM dept_chat_run_events WHERE run_id = ? AND tenant_id = ? AND kind = 'tool' ORDER BY seq ASC LIMIT 200`,
    args: [runId, s.tenantId],
  });
  const steps: RunReceipt["steps"] = [];
  const byId = new Map<string, number>();
  for (const e of events.rows) {
    const data = safeJson(String((e as unknown as Record<string, unknown>).data_json ?? "")) as Record<string, unknown> | null;
    if (!isObject(data)) continue;
    const key = String(data.id ?? "");
    if (data.phase === "start") {
      byId.set(key, steps.length);
      steps.push({ label: redactAll(String(data.label ?? "A lookup")).slice(0, 120), ok: null });
    } else if (data.phase === "done" && byId.has(key)) {
      steps[byId.get(key) as number].ok = data.ok === false ? false : true;
    }
  }
  const item = historyItemOf(raw);
  const status = String(raw.status ?? "");
  const text = status === "done" ? redactAll(String(raw.final_text ?? "")).slice(0, 8_000) : "";
  return {
    status: 200,
    body: {
      ok: true,
      receipt: {
        ...item,
        scheduledFor: raw.scheduled_for ? String(raw.scheduled_for) : null,
        finishedAt: raw.finished_at ? String(raw.finished_at) : null,
        text,
        steps,
        failure: status === "done" || status === "running" || status === "queued" ? null : item.summary,
      },
    },
  };
}
