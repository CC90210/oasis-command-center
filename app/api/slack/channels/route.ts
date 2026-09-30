/**
 * /api/slack/channels - the Slack channel map on Settings > Chat apps.
 *
 *   GET     the connected workspace's public channels (conversations.list, with
 *           the workspace's own bot token), each with its current mapping, plus
 *           this workspace's client records to link a channel to.
 *   PUT     { channel_id, channel_name, department | null, customer_id | null }
 *           maps one channel. department null = a general channel (mirrored,
 *           answered only when @mentioned).
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
import {
  deleteChannelRoute,
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
      // Mapped channels Slack no longer lists (archived, renamed private): still shown, so they can be removed.
      orphaned: routes.filter((r) => !listed.data.channels.some((c) => c.id === r.channel_id)),
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
        channel_taken: "That channel is mapped by another workspace.",
      };
      return json(saved.error === "channel_taken" ? 409 : 400, { ok: false, error: saved.error, message: msg[saved.error] });
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
