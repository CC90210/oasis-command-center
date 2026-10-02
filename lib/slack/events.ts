/**
 * lib/slack/events.ts - the Slack Events API, end to end, as one function the
 * route calls (app/api/webhooks/slack/events/route.ts) and the tests drive.
 *
 * THE ORDER
 *   1. VERIFY the signature over the raw body (lib/slack/verify.ts): a bad or
 *      missing signature, or a timestamp more than five minutes off, is 401.
 *      No signing secret on this deployment is 503: nothing is processed.
 *   2. url_verification: answer Slack's challenge (it is signed too).
 *   3. The TEAM decides the workspace: provider_webhook_routes (written by the
 *      install). An unknown team is acknowledged and dropped; a team is never
 *      guessed into a workspace. That workspace must use the app whose secret
 *      checked the request (lib/slack/own-app.ts slackAppMaySpeakFor), or the
 *      event is dropped.
 *   4. DROPPED, acknowledged, never answered or mirrored:
 *        - a channel shared with another company (is_ext_shared_channel);
 *        - anything a bot wrote (OASIS's own replies come back this way);
 *        - edits, deletes, joins and other message subtypes;
 *        - a guest (is_restricted / is_ultra_restricted) or a user from
 *          another Slack organisation (lib/slack/identity.ts).
 *   5. EXACTLY ONCE per event_id: the receipt row (slack_event_receipts) is
 *      written in the SAME transaction as what the event does, so a Slack retry
 *      (x-slack-retry-num), or two deliveries racing, do it once.
 *        message in a MAPPED channel  -> one conversation_events row (lib/slack/mirror.ts)
 *        app_mention                  -> the receipt, then the agent job
 *                                        (lib/slack/jobs.ts); a failed hand-off
 *                                        removes the receipt and answers 500,
 *                                        so Slack's retry gets another chance.
 *   6. Everything answers inside Slack's 3 seconds: the only outbound call is
 *      users.info (1.5 s cap, cached a day); the agent turn runs after.
 *
 * Tenant from the team's route only; a request body never names a workspace.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { isUniqueViolationError } from "@/lib/api-helpers";
import { resolveWebhookRoute } from "@/lib/connections/store";
import type { SlackFetch } from "@/lib/slack/client";
import { verifySlackRequest } from "@/lib/slack/verify";
import { slackAppMaySpeakFor, type SlackRequestApp } from "@/lib/slack/own-app";
import { resolveSlackIdentity } from "@/lib/slack/identity";
import { mirrorStatement } from "@/lib/slack/mirror";
import { slackTokenFor } from "@/lib/slack/send";
import { getChannelRoute, isSlackChannelId, isSlackSchemaMissing, isSlackTeamId, isSlackTs, isSlackUserId, plainSlackText, type ChannelRoute } from "@/lib/slack/routing";
import type { SlackMentionJob } from "@/lib/slack/jobs";

type Env = Readonly<Record<string, string | undefined>>;

export type SlackEventsDeps = {
  db: Client;
  now: () => Date;
  env?: Env;
  /**
   * The app whose signing secret `env` holds (lib/slack/own-app.ts
   * slackRequestScope gives both): OASIS's when absent, as `env` is then the
   * Worker's own. On EVERY event, the workspace its team is routed to must use
   * that app (slackAppMaySpeakFor): OASIS's app speaks only for OASIS's own
   * workspaces, a client's own app only for that client.
   */
  app?: SlackRequestApp;
  fetchImpl?: SlackFetch;
  /** Hand an @mention to the agent job (queue or after the response). Throws when it could not. */
  dispatchMention: (job: SlackMentionJob) => Promise<unknown>;
  /** A mirrored message in a general channel, for the Jev shadow (lib/jev/mode.ts). Never awaited by the ACK. */
  onGeneralMessage?: (m: { tenantId: string; text: string; route: ChannelRoute }) => void;
};

export type SlackEventsResult = { status: number; body: Record<string, unknown> };

const ok = (body: Record<string, unknown> = {}): SlackEventsResult => ({ status: 200, body: { ok: true, ...body } });

/** Message subtypes that are a person writing something new. Everything else (edits, joins, bots) is dropped. */
const PLAIN_MESSAGE_SUBTYPES = new Set<string | undefined>([undefined, "thread_broadcast", "file_share"]);

export async function handleSlackEvents(
  input: { rawBody: string; timestamp: string | null; signature: string | null; retryNum?: string | null },
  deps: SlackEventsDeps,
): Promise<SlackEventsResult> {
  const now = deps.now();
  const verified = verifySlackRequest({
    rawBody: input.rawBody,
    timestamp: input.timestamp,
    signature: input.signature,
    nowMs: now.getTime(),
    env: deps.env,
  });
  if (!verified.ok) {
    if (verified.reason === "not_configured") return { status: 503, body: { ok: false, error: "slack_not_configured" } };
    return { status: 401, body: { ok: false, error: verified.reason } };
  }

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(input.rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: 400, body: { ok: false, error: "body_invalid" } };
    body = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: { ok: false, error: "invalid_json" } };
  }

  if (body.type === "url_verification") {
    const challenge = typeof body.challenge === "string" ? body.challenge.slice(0, 200) : "";
    return { status: 200, body: { challenge } };
  }
  if (body.type !== "event_callback") return ok({ ignored: "not_an_event" });

  const teamId = body.team_id;
  const eventId = body.event_id;
  const event = (body.event && typeof body.event === "object" ? body.event : null) as Record<string, unknown> | null;
  if (!isSlackTeamId(teamId) || typeof eventId !== "string" || !/^[A-Za-z0-9]{4,64}$/.test(eventId) || !event) {
    return ok({ ignored: "malformed_event" });
  }

  const routed = await resolveWebhookRoute(deps.db, "slack", teamId);
  if (!routed) return ok({ dropped: "unknown_team" });
  const app: SlackRequestApp = deps.app ?? { kind: "oasis" };
  if (!slackAppMaySpeakFor(app, routed.tenantId)) {
    console.error("[slack.events] an event named a Slack team whose workspace does not use the app that signed it; dropped", {
      app: app.kind,
      ...(app.kind === "own" ? { workspace: app.tenantId } : {}),
      routedTenantId: routed.tenantId,
    });
    return ok({ dropped: "team_not_this_workspace" });
  }
  const tenantId = routed.tenantId;

  if (body.is_ext_shared_channel === true) return ok({ dropped: "shared_channel" });

  const type = event.type;
  if (type !== "message" && type !== "app_mention") return ok({ ignored: "event_type" });
  if (typeof event.bot_id === "string" || event.subtype === "bot_message") return ok({ ignored: "bot" });
  if (type === "message") {
    if (!PLAIN_MESSAGE_SUBTYPES.has(event.subtype as string | undefined)) return ok({ ignored: "subtype" });
    if (event.channel_type !== "channel") return ok({ ignored: "not_a_channel" });
  }
  const channelId = event.channel;
  const userId = event.user;
  const ts = event.ts;
  if (!isSlackChannelId(channelId) || !isSlackUserId(userId) || !isSlackTs(ts)) return ok({ ignored: "malformed_event" });
  const threadTs = isSlackTs(event.thread_ts) ? event.thread_ts : null;
  const text = plainSlackText(typeof event.text === "string" ? event.text : "");

  // The channel map: a message is mirrored only in a mapped channel; a mention
  // is answered anywhere the app was invited, under the channel's department
  // when it has one.
  let route: ChannelRoute | null;
  try {
    route = await getChannelRoute(deps.db, tenantId, teamId, channelId);
  } catch (err) {
    if (isSlackSchemaMissing(err)) {
      console.error("[slack.events] migration bravo__197 is not applied; refusing so Slack retries");
      return { status: 503, body: { ok: false, error: "slack_not_installed" } };
    }
    throw err;
  }
  if (type === "message" && !route) return ok({ ignored: "channel_not_mapped" });

  // Who wrote it: guests and other companies' users are dropped. A lookup that
  // fails is not "not a guest": 503, and Slack retries.
  const token = await slackTokenFor(deps.db, tenantId, teamId);
  if (!token.ok) {
    console.error("[slack.events] no usable token for a routed team", { tenantId, reason: token.reason });
    return ok({ dropped: token.reason });
  }
  if (token.botUserId && userId === token.botUserId) return ok({ ignored: "self" });
  const who = await resolveSlackIdentity(deps.db, { tenantId, teamId, slackUserId: userId, token: token.token, now, fetchImpl: deps.fetchImpl });
  if (!who.ok) {
    console.error("[slack.events] identity lookup failed", { tenantId, error: who.error, detail: who.detail });
    return who.error === "token_rejected" ? ok({ dropped: "token_rejected" }) : { status: 503, body: { ok: false, error: "identity_unavailable" } };
  }
  const identity = who.identity;
  if (identity.isGuest) return ok({ dropped: "guest" });
  if (identity.isExternal) return ok({ dropped: "external_user" });
  if (identity.isBot) return ok({ ignored: "bot" });

  const receipt = {
    sql: "INSERT INTO slack_event_receipts (event_id, tenant_id, team_id, event_type, received_at) VALUES (?, ?, ?, ?, ?)",
    args: [eventId, tenantId, teamId, String(type), now.toISOString()],
  };

  if (type === "message") {
    const r = route as ChannelRoute;
    try {
      await deps.db.batch(
        [
          receipt,
          mirrorStatement({
            tenantId,
            teamId,
            channelId,
            channelName: r.channel_name,
            ts,
            threadTs,
            text,
            authorName: identity.displayName,
            direction: "inbound",
            slackUserId: userId,
            department: r.department,
            customerId: r.customer_id,
            actorUserId: null,
            receivedAt: now,
          }),
        ],
        "write",
      );
    } catch (err) {
      if (isUniqueViolationError(err as { message?: string })) return ok({ duplicate: true });
      throw err;
    }
    const mentionsBot = token.botUserId ? String(event.text ?? "").includes(`<@${token.botUserId}>`) : false;
    if (r.department === null && !mentionsBot && deps.onGeneralMessage) deps.onGeneralMessage({ tenantId, text, route: r });
    return ok({ mirrored: true });
  }

  // app_mention
  try {
    await deps.db.execute(receipt);
  } catch (err) {
    if (isUniqueViolationError(err as { message?: string })) return ok({ duplicate: true });
    throw err;
  }
  const job: SlackMentionJob = {
    v: 1,
    kind: "mention",
    tenantId,
    teamId,
    channelId,
    channelName: route?.channel_name ?? null,
    threadTs: threadTs ?? ts,
    eventId,
    slackUserId: userId,
    profileId: identity.profileId,
    authorName: identity.displayName,
    text: typeof event.text === "string" ? event.text.slice(0, 4000) : "",
    channelDepartment: route?.department ?? null,
    customerId: route?.customer_id ?? null,
  };
  try {
    await deps.dispatchMention(job);
  } catch (err) {
    // Hand the event back to Slack: without its receipt, the retry runs it.
    await deps.db.execute({ sql: "DELETE FROM slack_event_receipts WHERE event_id = ? AND tenant_id = ?", args: [eventId, tenantId] });
    console.error("[slack.events] the mention could not be handed to its job", { tenantId, eventId, error: err instanceof Error ? err.message : String(err) });
    return { status: 500, body: { ok: false, error: "dispatch_failed" } };
  }
  return ok({ dispatched: true });
}
