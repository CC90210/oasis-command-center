/**
 * lib/slack/mirror.ts - a Slack message as a conversation_events row.
 *
 * The one shape every reader relies on (the client hub's Conversations tab,
 * lib/os/customers/conversations.ts, reads exactly these keys):
 *   event_type   'slack_message'
 *   metadata     { channel: 'slack', direction: 'inbound' | 'outbound', text,
 *                  author_name, customer_id (when the channel is mapped to a
 *                  client), department, team_id, channel_id, channel_name, ts,
 *                  thread_ts, thread_key, slack_user_id, received_at }
 *   created_at   when the message was written in Slack (provider time), so a
 *                late retry does not reorder the thread.
 *
 * Tenant from the caller (the Slack team's route), bound into the row. The
 * text is kept for the retention window only (lib/slack/retention.ts, 90 days).
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { InStatement, InValue } from "@libsql/client";
import type { DepartmentKey } from "@/lib/os/types";
import { slackThreadKey, slackTsToIso } from "@/lib/slack/routing";

export const SLACK_EVENT_TYPE = "slack_message";
/** A mirrored message longer than this is cut (Slack's own limit is 40,000). */
export const MIRROR_TEXT_MAX = 4_000;

export type MirrorInput = {
  tenantId: string;
  teamId: string;
  channelId: string;
  channelName: string | null;
  ts: string;
  threadTs: string | null;
  text: string;
  authorName: string | null;
  direction: "inbound" | "outbound";
  slackUserId: string | null;
  department: DepartmentKey | null;
  customerId: string | null;
  /** The teammate's auth user id, when the Slack user is linked to one. */
  actorUserId: string | null;
  receivedAt: Date;
};

/**
 * `guard` (lib/connections/store.ts liveConnectionGuard): the row is written
 * only while the Slack connection the message came through is still live on
 * the same generation, checked in the same statement.
 */
export function mirrorStatement(m: MirrorInput, guard?: { sql: string; args: InValue[] }): InStatement {
  if (!m.tenantId) throw new Error("slack.mirror: a tenant id is required");
  const threadTs = m.threadTs || m.ts;
  const metadata = {
    channel: "slack",
    direction: m.direction,
    text: m.text.length > MIRROR_TEXT_MAX ? m.text.slice(0, MIRROR_TEXT_MAX) : m.text,
    author_name: m.authorName,
    customer_id: m.customerId,
    department: m.department,
    team_id: m.teamId,
    channel_id: m.channelId,
    channel_name: m.channelName,
    ts: m.ts,
    thread_ts: threadTs,
    thread_key: slackThreadKey(m.teamId, m.channelId, threadTs),
    slack_user_id: m.slackUserId,
    received_at: m.receivedAt.toISOString(),
  };
  return {
    sql: `INSERT INTO conversation_events (id, tenant_id, thread_id, lead_id, event_type, actor_user_id, metadata, created_at)
          SELECT ?, ?, NULL, NULL, ?, ?, ?, ? WHERE ${guard ? guard.sql : "1"}`,
    args: [
      randomUUID(),
      m.tenantId,
      SLACK_EVENT_TYPE,
      m.actorUserId,
      JSON.stringify(metadata),
      slackTsToIso(m.ts) ?? m.receivedAt.toISOString(),
      ...(guard ? guard.args : []),
    ],
  };
}
