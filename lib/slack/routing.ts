/**
 * lib/slack/routing.ts - which OASIS workspace, department and client a Slack
 * message belongs to, and the channel map owners edit in Settings > Chat apps.
 *
 * TENANT FIRST. Every function that reads or writes a channel route takes the
 * tenant id from its caller (the session, or the Slack team's registered route
 * in provider_webhook_routes) and binds it into every statement. A channel id
 * from another workspace reads as "not mapped" and writes nothing.
 *
 * DEPARTMENT NAMES ONLY. What a Slack user sees is the department ("Client
 * Success"), never an internal agent name. The text a person types after the
 * mention may name a department ("@OASIS Client Success, can you ..."); that
 * wins over the channel's default, which wins over Chief of Staff.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import type { DepartmentKey } from "@/lib/os/types";

/** Providers whose install flow OASIS can finish (the generic authorize route starts only these). */
export const INSTALL_PROVIDERS: readonly string[] = ["slack"];

/** Where an install lands the browser back. */
export function installReturnPath(provider: string): string {
  return provider === "slack" ? "/settings/chat-apps" : "/settings/connections";
}

export const DEPARTMENT_KEYS: readonly DepartmentKey[] = OS_DEPARTMENTS.map((d) => d.key);

export function isDepartmentKey(v: unknown): v is DepartmentKey {
  return typeof v === "string" && (DEPARTMENT_KEYS as readonly string[]).includes(v);
}

export function departmentLabelOf(key: DepartmentKey): string {
  return OS_DEPARTMENTS.find((d) => d.key === key)?.label ?? key;
}

const SLACK_ID = /^[A-Z0-9]{2,32}$/;
export const isSlackTeamId = (v: unknown): v is string => typeof v === "string" && /^T[A-Z0-9]{2,31}$/.test(v);
export const isSlackChannelId = (v: unknown): v is string => typeof v === "string" && /^C[A-Z0-9]{2,31}$/.test(v);
export const isSlackUserId = (v: unknown): v is string => typeof v === "string" && /^[UW][A-Z0-9]{2,31}$/.test(v);
export const isSlackTs = (v: unknown): v is string => typeof v === "string" && /^\d{1,12}\.\d{1,9}$/.test(v);
export const isSlackId = (v: unknown): v is string => typeof v === "string" && SLACK_ID.test(v);

/** The conversation_events thread key for a Slack thread (T6's Conversations tab groups by it). */
export function slackThreadKey(teamId: string, channelId: string, threadTs: string): string {
  return `slack:${teamId}:${channelId}:${threadTs}`;
}

/** Slack's "1727712000.000200" as an ISO timestamp (provider time), or null. */
export function slackTsToIso(ts: string): string | null {
  if (!isSlackTs(ts)) return null;
  const ms = Math.round(Number(ts) * 1000);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// -- Reading a mention --------------------------------------------------------

/** Mentions (<@U123>), channel links (<#C1|x>) and links (<https://...|label>) as plain words. */
export function plainSlackText(text: string): string {
  return String(text ?? "")
    .replace(/<@[UW][A-Z0-9]+(?:\|[^>]*)?>/g, " ")
    .replace(/<#C[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The department a mention names at its start, and the rest of the message.
 * "@OASIS Client Success can you draft..." -> client_success, "can you draft...".
 * Only an exact department label at the start counts ("@Chief of Staff", with
 * or without the @, then a space or punctuation), so a department mentioned in
 * passing later in the sentence does not reroute the question.
 */
export function departmentFromMention(text: string): { department: DepartmentKey | null; rest: string } {
  const plain = plainSlackText(text);
  const lower = plain.toLowerCase();
  // Longest label first, so "Chief of Staff" is not read as a shorter label.
  const labels = [...OS_DEPARTMENTS].sort((a, b) => b.label.length - a.label.length);
  for (const d of labels) {
    for (const prefix of [`@${d.label.toLowerCase()}`, d.label.toLowerCase()]) {
      if (!lower.startsWith(prefix)) continue;
      const next = plain.charAt(prefix.length);
      if (next && !/[\s,:;.!?-]/.test(next)) continue;
      const rest = plain.slice(prefix.length).replace(/^[\s,:;.!?-]+/, "").trim();
      return { department: d.key, rest };
    }
  }
  return { department: null, rest: plain };
}

/** Text named > the channel's default > Chief of Staff. */
export function departmentForMention(input: { text: string; channelDepartment: DepartmentKey | null }): {
  department: DepartmentKey;
  question: string;
  source: "named" | "channel" | "default";
} {
  const named = departmentFromMention(input.text);
  if (named.department) return { department: named.department, question: named.rest, source: "named" };
  if (input.channelDepartment) return { department: input.channelDepartment, question: named.rest, source: "channel" };
  return { department: "chief_of_staff", question: named.rest, source: "default" };
}

// -- The channel map -----------------------------------------------------------

export type ChannelRoute = {
  id: string;
  tenant_id: string;
  team_id: string;
  channel_id: string;
  channel_name: string | null;
  /** null = a general channel: mirrored, answered only when @mentioned. */
  department: DepartmentKey | null;
  customer_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

function toRoute(r: Row): ChannelRoute {
  const dept = s(r.department);
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    team_id: String(r.team_id),
    channel_id: String(r.channel_id),
    channel_name: s(r.channel_name),
    department: isDepartmentKey(dept) ? dept : null,
    customer_id: s(r.customer_id),
    created_by: s(r.created_by),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

const ROUTE_COLUMNS = "id, tenant_id, team_id, channel_id, channel_name, department, customer_id, created_by, created_at, updated_at";

function requireTenant(tenantId: string): string {
  if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("slack.routing: a tenant id is required");
  return tenantId;
}

/** A missing slack_* table (bravo__197 not applied) is "not installed", which every caller reports as such. */
export function isSlackSchemaMissing(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /no such table:\s*(slack_channel_routes|slack_event_receipts|external_identities|jev_calls)/i.test(m);
}

export async function listChannelRoutes(db: Client, tenantId: string): Promise<ChannelRoute[]> {
  const rs = await db.execute({
    sql: `SELECT ${ROUTE_COLUMNS} FROM slack_channel_routes WHERE tenant_id = ? ORDER BY channel_name, channel_id`,
    args: [requireTenant(tenantId)],
  });
  return (rs.rows as unknown as Row[]).map(toRoute);
}

export async function getChannelRoute(db: Client, tenantId: string, teamId: string, channelId: string): Promise<ChannelRoute | null> {
  const rs = await db.execute({
    sql: `SELECT ${ROUTE_COLUMNS} FROM slack_channel_routes WHERE tenant_id = ? AND team_id = ? AND channel_id = ? LIMIT 1`,
    args: [requireTenant(tenantId), teamId, channelId],
  });
  const r = rs.rows[0] as unknown as Row | undefined;
  return r ? toRoute(r) : null;
}

export type SaveRouteInput = {
  tenantId: string;
  teamId: string;
  channelId: string;
  channelName: string | null;
  department: DepartmentKey | null;
  customerId: string | null;
  createdBy: string | null;
  now: Date;
};

export type SaveRouteResult =
  | { ok: true; route: ChannelRoute }
  | { ok: false; error: "invalid_channel" | "invalid_department" | "unknown_customer" | "channel_taken" };

/**
 * Map (or re-map) one channel. The customer must be one of THIS workspace's
 * client records; the channel must not be mapped by another workspace (it
 * cannot be, while the team routes here, but the unique index is the proof).
 */
export async function saveChannelRoute(db: Client, input: SaveRouteInput): Promise<SaveRouteResult> {
  const tenantId = requireTenant(input.tenantId);
  if (!isSlackTeamId(input.teamId) || !isSlackChannelId(input.channelId)) return { ok: false, error: "invalid_channel" };
  if (input.department !== null && !isDepartmentKey(input.department)) return { ok: false, error: "invalid_department" };
  if (input.customerId) {
    const c = await db.execute({
      sql: "SELECT 1 FROM customers WHERE tenant_id = ? AND id = ? AND archived_at IS NULL LIMIT 1",
      args: [tenantId, input.customerId],
    });
    if (c.rows.length === 0) return { ok: false, error: "unknown_customer" };
  }
  const nowIso = input.now.toISOString();
  const name = input.channelName ? input.channelName.replace(/[^\w.-]/g, "").slice(0, 80) || null : null;
  const rs = await db.execute({
    sql: `INSERT INTO slack_channel_routes (id, tenant_id, team_id, channel_id, channel_name, department, customer_id, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (team_id, channel_id) DO UPDATE SET
            channel_name = excluded.channel_name,
            department = excluded.department,
            customer_id = excluded.customer_id,
            updated_at = excluded.updated_at
          WHERE slack_channel_routes.tenant_id = excluded.tenant_id`,
    args: [randomUUID(), tenantId, input.teamId, input.channelId, name, input.department, input.customerId, input.createdBy, nowIso, nowIso],
  });
  if (rs.rowsAffected !== 1) return { ok: false, error: "channel_taken" };
  const route = await getChannelRoute(db, tenantId, input.teamId, input.channelId);
  if (!route) return { ok: false, error: "channel_taken" };
  return { ok: true, route };
}

export async function deleteChannelRoute(db: Client, tenantId: string, teamId: string, channelId: string): Promise<boolean> {
  const rs = await db.execute({
    sql: "DELETE FROM slack_channel_routes WHERE tenant_id = ? AND team_id = ? AND channel_id = ?",
    args: [requireTenant(tenantId), teamId, channelId],
  });
  return rs.rowsAffected === 1;
}

/** The mapped channels of one department, for the department tab and the AI Team roster. */
export async function channelsForDepartment(db: Client, tenantId: string, department: DepartmentKey): Promise<ChannelRoute[]> {
  const rs = await db.execute({
    sql: `SELECT ${ROUTE_COLUMNS} FROM slack_channel_routes WHERE tenant_id = ? AND department = ? ORDER BY channel_name`,
    args: [requireTenant(tenantId), department],
  });
  return (rs.rows as unknown as Row[]).map(toRoute);
}
