/**
 * /api/slack/channels - the Slack channel map on Settings > Chat apps.
 *
 *   GET     the connected workspace's public channels (conversations.list, with
 *           the workspace's own bot token), each with its current mapping, plus
 *           this workspace's client records to link a channel to. Mapped
 *           channels missing from the page come back as `orphaned` when the
 *           page is complete (Slack no longer lists them) and as `beyond_page`
 *           when it is truncated (unproven either way; still unmappable).
 *   PUT     { channel_id, channel_name, department | null, customer_id | null }
 *           maps one channel. department null = a general channel (mirrored,
 *           answered only when @mentioned). A department is accepted only when
 *           it has an AI teammate in this workspace (every one in OASIS's own;
 *           in a client workspace, the neutral ones).
 *   DELETE  ?channel_id=C...  unmaps one channel.
 *
 * Owner/admin only (lib/connections/access.ts). The tenant AND the Slack team
 * come from the session and its live Slack connection, never from the body: a
 * channel can only ever be mapped inside the team this workspace installed.
 * Channels shared with another company are listed but cannot be mapped (v1:
 * OASIS never answers or mirrors there).
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveConnectionsActor, routeFailure } from "@/lib/connections/route-helpers";
import { findActiveConnection } from "@/lib/connections/store";
import { readBotToken } from "@/lib/connections/token-store";
import { channelInfo, listPublicChannels } from "@/lib/slack/client";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";
import { getWorkspaceManifest } from "@/lib/manifest/loader";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import type { DepartmentKey } from "@/lib/os/types";
import {
  answeringDepartments,
  deleteChannelRoute,
  departmentLabelOf,
  isDepartmentKey,
  isSlackChannelId,
  isSlackSchemaMissing,
  listChannelRoutes,
  saveChannelRoute,
} from "@/lib/slack/routing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

async function slackContext(tenantId: string, db: Parameters<typeof findActiveConnection>[0]) {
  const conn = await findActiveConnection(db, tenantId, "slack");
  if (!conn || !conn.external_account_id) return null;
  return conn;
}

/**
 * The departments with an AI teammate in the session's workspace
 * (lib/slack/routing.ts answeringDepartments): the leads its manifest binds,
 * the same roster the web channels read. A manifest read that fails throws
 * (routeFailure answers it), never "<Department> has no AI teammate" for a
 * department that has one (W4a review R3). So does a manifest slug that did
 * not resolve: resolveOwnedSlug answers a read that failed with null (W4a D1).
 */
async function answeringDepartmentsOf(db: Parameters<typeof findActiveConnection>[0], tenantId: string): Promise<DepartmentKey[]> {
  const rs = await db.execute({ sql: "SELECT slug FROM tenants WHERE id = ? LIMIT 1", args: [tenantId] });
  const row = rs.rows[0] as unknown as Record<string, unknown> | undefined;
  const slug = row?.slug ? String(row.slug) : "";
  if (!slug) throw new Error("api.slack.channels: the workspace's slug could not be read");
  const manifestSlug = await resolveOwnedSlug(tenantId);
  if (!manifestSlug) throw new Error("api.slack.channels: the workspace's manifest slug could not be read");
  const manifest = await getWorkspaceManifest(tenantId, manifestSlug);
  return answeringDepartments({ oasis: isOasisSurfaceTenant(slug), manifest });
}

export async function GET() {
  try {
    const resolved = await resolveConnectionsActor();
    if (!resolved.ok) return resolved.response;
    const { db } = resolved.deps;
    const tenantId = resolved.actor.tenantId;
    const conn = await slackContext(tenantId, db);
    if (!conn) return json(404, { ok: false, error: "slack_not_connected", message: "Slack is not connected to this workspace." });

    let routes;
    try {
      routes = await listChannelRoutes(db, tenantId);
    } catch (err) {
      if (!isSlackSchemaMissing(err)) throw err;
      return json(503, { ok: false, error: "slack_not_installed", message: "The Slack tables are not installed on this deployment yet." });
    }

    const token = await readBotToken(tenantId, conn.id);
    if (!token.ok) {
      if (token.reason === "lookup_failed") throw new Error("slack token lookup failed");
      return json(409, { ok: false, error: "slack_token_missing", message: "OASIS's Slack token is missing. Install the app again." });
    }
    const listed = await listPublicChannels(token.token);
    if (!listed.ok) {
      console.error("[api.slack.channels] conversations.list failed", { tenantId, error: listed.error });
      return json(502, { ok: false, error: "slack_unavailable", message: `Slack did not list the channels (${listed.error}). Try again.` });
    }

    let customers: Array<{ id: string; name: string }> = [];
    let customersAvailable = true;
    try {
      const rs = await db.execute({
        sql: "SELECT id, display_name FROM customers WHERE tenant_id = ? AND archived_at IS NULL ORDER BY display_name LIMIT 500",
        args: [tenantId],
      });
      customers = rs.rows.map((r) => ({ id: String((r as unknown as Record<string, unknown>).id), name: String((r as unknown as Record<string, unknown>).display_name) }));
    } catch (err) {
      console.error("[api.slack.channels] client records unreadable", { tenantId, error: err instanceof Error ? err.message : String(err) });
      customersAvailable = false;
    }

    const byChannel = new Map(routes.map((r) => [r.channel_id, r]));
    const byListed = new Set(listed.data.channels.map((c) => c.id));
    // Mapped channels missing from the page. Only a COMPLETE page proves a channel is gone
    // (archived, made private). A truncated page cannot, so those mappings are reported as
    // "beyond the page" instead of orphaned; the owner can still unmap them.
    const unlisted = routes.filter((r) => !byListed.has(r.channel_id));
    return json(200, {
      ok: true,
      team: { id: conn.external_account_id, name: conn.external_account_label },
      channels: listed.data.channels.map((c) => {
        const r = byChannel.get(c.id);
        return {
          id: c.id,
          name: c.name,
          is_member: c.is_member,
          is_ext_shared: c.is_ext_shared,
          route: r ? { department: r.department, customer_id: r.customer_id } : null,
        };
      }),
      orphaned: listed.data.truncated ? [] : unlisted,
      beyond_page: listed.data.truncated ? unlisted : [],
      truncated: listed.data.truncated,
      customers: customersAvailable ? customers : null,
    });
  } catch (error) {
    return routeFailure("api/slack/channels", error);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const resolved = await resolveConnectionsActor();
    if (!resolved.ok) return resolved.response;
    const { db } = resolved.deps;
    const tenantId = resolved.actor.tenantId;
    const conn = await slackContext(tenantId, db);
    if (!conn) return json(404, { ok: false, error: "slack_not_connected", message: "Slack is not connected to this workspace." });

    let body: Record<string, unknown>;
    try {
      const parsed = (await req.json()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return json(400, { ok: false, error: "invalid_json", message: "Send the channel as JSON." });
    }
    const channelId = body.channel_id;
    if (!isSlackChannelId(channelId)) return json(400, { ok: false, error: "invalid_channel", message: "That is not a Slack channel id." });
    const department = body.department === null || body.department === "" || body.department === undefined ? null : body.department;
    if (department !== null && !isDepartmentKey(department)) return json(400, { ok: false, error: "invalid_department", message: "That is not a department." });
    // Only a department with an AI teammate in THIS workspace can answer in
    // Slack; a channel mapped to one without would only ever get notices.
    if (department !== null && !(await answeringDepartmentsOf(db, tenantId)).includes(department)) {
      return json(400, {
        ok: false,
        error: "department_not_set_up",
        message: `${departmentLabelOf(department)} has no AI teammate in this workspace yet, so it cannot answer in Slack.`,
      });
    }
    const customerId = typeof body.customer_id === "string" && body.customer_id.trim() ? body.customer_id.trim() : null;

    // Slack says what the channel is, not the request: its real name, and
    // whether it is shared with another company (never mapped, v1).
    const token = await readBotToken(tenantId, conn.id);
    if (!token.ok) {
      if (token.reason === "lookup_failed") throw new Error("slack token lookup failed");
      return json(409, { ok: false, error: "slack_token_missing", message: "OASIS's Slack token is missing. Install the app again." });
    }
    const info = await channelInfo(token.token, channelId);
    if (!info.ok) {
      if (info.error === "channel_not_found") return json(400, { ok: false, error: "invalid_channel", message: "That channel is not in the connected Slack workspace." });
      return json(502, { ok: false, error: "slack_unavailable", message: `Slack did not confirm the channel (${info.error}). Try again.` });
    }
    if (info.data.is_ext_shared) {
      return json(409, { ok: false, error: "shared_channel", message: "This channel is shared with another company. OASIS stays out of shared channels." });
    }

    let saved;
    try {
      saved = await saveChannelRoute(db, {
        tenantId,
        teamId: conn.external_account_id as string,
        channelId,
        channelName: info.data.name,
        department,
        customerId,
        createdBy: resolved.actor.userId,
        now: resolved.deps.now(),
      });
    } catch (err) {
      if (!isSlackSchemaMissing(err)) throw err;
      return json(503, { ok: false, error: "slack_not_installed", message: "The Slack tables are not installed on this deployment yet." });
    }
    if (!saved.ok) {
      const msg: Record<string, string> = {
        invalid_channel: "That is not a channel in the connected Slack workspace.",
        invalid_department: "That is not a department.",
        unknown_customer: "That client is not in this workspace.",
      };
      return json(400, { ok: false, error: saved.error, message: msg[saved.error] });
    }
    return json(200, { ok: true, route: saved.route });
  } catch (error) {
    return routeFailure("api/slack/channels", error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const resolved = await resolveConnectionsActor();
    if (!resolved.ok) return resolved.response;
    const { db } = resolved.deps;
    const tenantId = resolved.actor.tenantId;
    const conn = await slackContext(tenantId, db);
    if (!conn) return json(404, { ok: false, error: "slack_not_connected", message: "Slack is not connected to this workspace." });
    const channelId = req.nextUrl.searchParams.get("channel_id");
    if (!isSlackChannelId(channelId)) return json(400, { ok: false, error: "invalid_channel", message: "That is not a Slack channel id." });
    const removed = await deleteChannelRoute(db, tenantId, conn.external_account_id as string, channelId);
    return json(200, { ok: true, removed });
  } catch (error) {
    return routeFailure("api/slack/channels", error);
  }
}
