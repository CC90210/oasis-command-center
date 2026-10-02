/**
 * lib/slack/send.ts - everything OASIS posts into Slack, for ONE workspace,
 * with that workspace's own bot token.
 *
 *   postSlackReply      an APPROVED department reply (the send_slack_message
 *                       executor is the only caller), mirrored onto the
 *                       conversation as outbound.
 *   postApprovalRequest a line under the @mention saying a draft waits for
 *                       review in OASIS, with NO draft text in it (everyone in
 *                       the channel reads it, guests included); and the draft
 *                       with its Approve button (lib/slack/interactivity.ts)
 *                       sent ephemerally to the one owner or admin who asked,
 *                       when that is who asked. Nobody else sees the draft in
 *                       Slack until it is approved and posted.
 *   postNotice          a one-line status under the @mention when no draft
 *                       could be made (department not set up, no AI account,
 *                       the month's AI budget reached). Operational only: it
 *                       says what happened, never an answer on anyone's behalf.
 *
 * Every post checks that the team it is for is the team this tenant's live
 * Slack connection is pinned to, so nothing can reach a Slack workspace the
 * tenant does not hold. Names shown are department names; no internal agent
 * name is ever posted.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { findActiveConnection } from "@/lib/connections/store";
import { readBotToken } from "@/lib/connections/token-store";
import type { DepartmentKey } from "@/lib/os/types";
import { postEphemeral, postMessage, type SlackFetch } from "@/lib/slack/client";
import { mirrorStatement } from "@/lib/slack/mirror";
import { departmentLabelOf, getChannelRoute, isSlackSchemaMissing } from "@/lib/slack/routing";

/**
 * The Slack connection a piece of work was accepted under: its id and its
 * generation (tenant_connections.token_version, lib/connections/store.ts).
 * Work bound to one is never carried out on another, or on a later generation
 * of the same one (a disconnect, or a reinstall, moved it on).
 */
export type SlackConnectionBinding = { id: string; generation: number };

export type SlackPostArgs = {
  tenantId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  text: string;
  department: DepartmentKey | null;
  approvalId: string;
  /** The connection the approved reply was drafted under (its approval's payload). */
  connection: SlackConnectionBinding;
};

export type SlackPostOutcome = { ok: true; ts: string } | { ok: false; reason: string; message: string };

type Token = { ok: true; token: string; botUserId: string | null } | { ok: false; reason: string; message: string };

/** What a post bound to an earlier Slack connection (or generation of it) says, instead of posting. */
export const SLACK_CONNECTION_CHANGED_COPY =
  "This was drafted while an earlier Slack connection was in place. Slack has since been disconnected or installed again, so nothing was posted. Ask again in Slack.";

/**
 * The tenant's live Slack connection for `teamId`, and its bot token. A
 * connection being disconnected is not live. With `connection`, only that
 * connection on that generation will do.
 */
export async function slackTokenFor(db: Client, tenantId: string, teamId: string, connection?: SlackConnectionBinding): Promise<Token> {
  const conn = await findActiveConnection(db, tenantId, "slack");
  if (!conn || conn.status === "disconnecting") {
    return { ok: false, reason: "slack_not_connected", message: "Slack is not connected to this workspace, so nothing was posted." };
  }
  if (conn.external_account_id !== teamId) {
    return { ok: false, reason: "slack_team_mismatch", message: "This reply is for a Slack workspace that is not the one connected here, so nothing was posted." };
  }
  if (connection && (conn.id !== connection.id || conn.token_version !== connection.generation)) {
    return { ok: false, reason: "slack_connection_changed", message: SLACK_CONNECTION_CHANGED_COPY };
  }
  if (conn.status === "expired" || conn.status === "revoked") {
    return { ok: false, reason: "slack_token_rejected", message: "Slack no longer accepts OASIS's token for this workspace. Install the app again in Settings > Chat apps." };
  }
  const token = await readBotToken(tenantId, conn.id);
  if (!token.ok) {
    if (token.reason === "lookup_failed") throw new Error("slack token lookup failed");
    return { ok: false, reason: "slack_token_missing", message: "OASIS's Slack token for this workspace is missing. Install the app again in Settings > Chat apps." };
  }
  return token;
}

function slackFailureMessage(error: string): string {
  switch (error) {
    case "not_in_channel":
    case "channel_not_found":
      return "OASIS's Slack app is not in that channel any more, so nothing was posted. Invite the app back to the channel and ask again.";
    case "is_archived":
      return "That Slack channel is archived, so nothing was posted.";
    case "invalid_auth":
    case "token_revoked":
    case "account_inactive":
      return "Slack no longer accepts OASIS's token for this workspace. Install the app again in Settings > Chat apps.";
    case "rate_limited":
      return "Slack asked OASIS to slow down, so nothing was posted. Approve again in a minute.";
    case "timeout":
    case "network_error":
      return "Slack did not answer in time. It may have been posted: check the thread before approving again.";
    default:
      return `Slack refused the reply (${error}).`;
  }
}

export async function postSlackReply(db: Client, args: SlackPostArgs, opts: { fetchImpl?: SlackFetch; now?: () => Date } = {}): Promise<SlackPostOutcome> {
  const token = await slackTokenFor(db, args.tenantId, args.teamId, args.connection);
  if (!token.ok) return token;
  // Posted as the words that were approved. Slack reads &, < and > in a
  // message as its own markup (<!channel> pings everyone, <@U..> mentions,
  // <https://..|label> hides a link behind a label), none of which the
  // approver saw as such: escaped, the thread shows exactly the approved text.
  const posted = await postMessage(token.token, { channel: args.channelId, thread_ts: args.threadTs, text: escapeMrkdwn(args.text) }, { fetchImpl: opts.fetchImpl });
  if (!posted.ok) {
    const unknown = posted.error === "timeout" || posted.error === "network_error";
    return { ok: false, reason: unknown ? "delivery_unknown" : `slack_${posted.error}`, message: slackFailureMessage(posted.error) };
  }
  // The reply is part of the conversation: mirrored as outbound, under the
  // department. It already went out, so a mirror that cannot be written is
  // logged loudly and does not turn the post into a failure.
  try {
    let route = null;
    try {
      route = await getChannelRoute(db, args.tenantId, args.teamId, args.channelId);
    } catch (err) {
      if (!isSlackSchemaMissing(err)) throw err;
    }
    const now = (opts.now ?? (() => new Date()))();
    await db.execute(
      mirrorStatement({
        tenantId: args.tenantId,
        teamId: args.teamId,
        channelId: args.channelId,
        channelName: route?.channel_name ?? null,
        ts: posted.data.ts,
        threadTs: args.threadTs,
        text: args.text,
        authorName: args.department ? departmentLabelOf(args.department) : null,
        direction: "outbound",
        slackUserId: null,
        department: args.department,
        customerId: route?.customer_id ?? null,
        actorUserId: null,
        receivedAt: now,
      }),
    );
  } catch (err) {
    console.error("[slack.send] posted, but the reply could not be mirrored", {
      tenantId: args.tenantId,
      approvalId: args.approvalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { ok: true, ts: posted.data.ts };
}

/** The Approve button's value: the approval and the exact draft it binds to. */
export function approveButtonValue(approvalId: string, payloadHash: string): string {
  return `${approvalId}|${payloadHash}`;
}

export function parseApproveButtonValue(v: unknown): { approvalId: string; payloadHash: string } | null {
  if (typeof v !== "string") return null;
  const m = /^([A-Za-z0-9_-]{1,80})\|([0-9a-f]{64})$/.exec(v);
  return m ? { approvalId: m[1], payloadHash: m[2] } : null;
}

export const APPROVE_ACTION_ID = "oasis_approval_approve";
export const OPEN_ACTION_ID = "oasis_approval_open";

/** Slack mrkdwn needs &, < and > escaped in text it did not write. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The line posted IN the thread when a draft is made. It carries no draft
 * text: everyone in the channel reads it, guests included, and a draft that is
 * later sent back or left to expire must never have been shown there. It is
 * true whatever happens to the approval afterwards, so it never goes stale.
 */
export function approvalNoticeText(departmentLabel: string): string {
  return `${departmentLabel} drafted a reply for review in OASIS. Nothing is posted in this thread unless someone approves it.`;
}

export function approvalNoticeBlocks(input: { departmentLabel: string; openUrl: string | null }): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: escapeMrkdwn(approvalNoticeText(input.departmentLabel)) } },
    ...(input.openUrl
      ? [{ type: "actions", elements: [{ type: "button", action_id: OPEN_ACTION_ID, text: { type: "plain_text", text: "Open in OASIS" }, url: input.openUrl }] }]
      : []),
  ];
}

/** Raw draft characters per card section: escaped (at most 5 characters each) and quoted, a piece stays under Slack's 3,000. */
export const CARD_PIECE_MAX = 500;

/**
 * The draft in pieces of at most CARD_PIECE_MAX characters, split at line ends
 * where it can be and inside a longer line only where it must (never inside a
 * character). Every character of the draft is in exactly one piece, in order.
 */
export function draftPieces(draft: string): string[] {
  const pieces: string[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = () => {
    if (current.length) pieces.push(current.join("\n"));
    current = [];
    size = 0;
  };
  for (const line of draft.split("\n")) {
    const chars = Array.from(line);
    const segments: string[] = [];
    for (let i = 0; i < chars.length; i += CARD_PIECE_MAX) segments.push(chars.slice(i, i + CARD_PIECE_MAX).join(""));
    if (segments.length === 0) segments.push("");
    for (const seg of segments) {
      const len = Array.from(seg).length;
      // +1: the line end that joins it to the piece so far.
      if (current.length && size + 1 + len > CARD_PIECE_MAX) flush();
      size += (current.length ? 1 : 0) + len;
      current.push(seg);
    }
  }
  flush();
  return pieces;
}

/**
 * The review card: the draft, word for word and in full, and the Approve
 * button bound to exactly those words. A section holds 3,000 characters, so a
 * long draft runs over several sections rather than being cut: the Approve
 * button binds to the whole draft, so the whole draft is what is shown. Sent
 * ONLY with chat.postEphemeral, to one owner or admin (postApprovalRequest),
 * never into the channel.
 */
export function approvalCardBlocks(input: {
  departmentLabel: string;
  draft: string;
  approvalId: string;
  payloadHash: string;
  openUrl: string | null;
}): unknown[] {
  const quote = (piece: string) =>
    escapeMrkdwn(piece)
      .split("\n")
      .map((l) => `>${l}`)
      .join("\n");
  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Only you can see this. *${escapeMrkdwn(input.departmentLabel)}* drafted this reply. Nothing is posted until it is approved.`,
      },
    },
    ...draftPieces(input.draft).map((piece) => ({ type: "section", text: { type: "mrkdwn", text: quote(piece) } })),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: APPROVE_ACTION_ID,
          style: "primary",
          text: { type: "plain_text", text: "Approve and post" },
          value: approveButtonValue(input.approvalId, input.payloadHash),
        },
        ...(input.openUrl ? [{ type: "button", action_id: OPEN_ACTION_ID, text: { type: "plain_text", text: "Open in OASIS" }, url: input.openUrl }] : []),
      ],
    },
  ];
  return blocks;
}

export type ApprovalRequestOutcome = {
  /** The draft-free line in the thread. */
  notice: SlackPostOutcome;
  /** The ephemeral review card, or why none was sent. */
  review: SlackPostOutcome | { ok: false; reason: "no_slack_approver"; message: string };
};

/**
 * Tell the thread a draft waits (no draft text), and send the draft with its
 * Approve button to `reviewer` alone: the Slack user id of the owner or admin
 * who asked (lib/slack/identity.ts slackApproverProfile), or null when the
 * person who asked may not approve from Slack. Then the draft is only in OASIS.
 */
export async function postApprovalRequest(
  db: Client,
  input: {
    tenantId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    department: DepartmentKey;
    draft: string;
    approvalId: string;
    payloadHash: string;
    openUrl: string | null;
    reviewer: string | null;
    /** The connection the mention came through (lib/slack/jobs.ts). */
    connection: SlackConnectionBinding;
  },
  opts: { fetchImpl?: SlackFetch } = {},
): Promise<ApprovalRequestOutcome> {
  const token = await slackTokenFor(db, input.tenantId, input.teamId, input.connection);
  if (!token.ok) return { notice: token, review: token };
  const label = departmentLabelOf(input.department);
  const posted = await postMessage(
    token.token,
    {
      channel: input.channelId,
      thread_ts: input.threadTs,
      text: approvalNoticeText(label),
      blocks: approvalNoticeBlocks({ departmentLabel: label, openUrl: input.openUrl }),
    },
    { fetchImpl: opts.fetchImpl },
  );
  const notice: SlackPostOutcome = posted.ok
    ? { ok: true, ts: posted.data.ts }
    : { ok: false, reason: `slack_${posted.error}`, message: slackFailureMessage(posted.error) };
  if (!input.reviewer) {
    return { notice, review: { ok: false, reason: "no_slack_approver", message: "The person who asked cannot approve from Slack; the draft is in the Feed." } };
  }
  const card = await postEphemeral(
    token.token,
    {
      channel: input.channelId,
      user: input.reviewer,
      thread_ts: input.threadTs,
      text: `${label} drafted a reply for you to review. Only you can see it.`,
      blocks: approvalCardBlocks({ departmentLabel: label, draft: input.draft, approvalId: input.approvalId, payloadHash: input.payloadHash, openUrl: input.openUrl }),
    },
    { fetchImpl: opts.fetchImpl },
  );
  const review: SlackPostOutcome = card.ok
    ? { ok: true, ts: card.data.message_ts }
    : { ok: false, reason: `slack_${card.error}`, message: slackFailureMessage(card.error) };
  return { notice, review };
}

export async function postNotice(
  db: Client,
  input: { tenantId: string; teamId: string; channelId: string; threadTs: string; text: string; connection: SlackConnectionBinding },
  opts: { fetchImpl?: SlackFetch } = {},
): Promise<SlackPostOutcome> {
  const token = await slackTokenFor(db, input.tenantId, input.teamId, input.connection);
  if (!token.ok) return token;
  const posted = await postMessage(token.token, { channel: input.channelId, thread_ts: input.threadTs, text: input.text }, { fetchImpl: opts.fetchImpl });
  if (!posted.ok) return { ok: false, reason: `slack_${posted.error}`, message: slackFailureMessage(posted.error) };
  return { ok: true, ts: posted.data.ts };
}
