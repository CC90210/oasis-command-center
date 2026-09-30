/**
 * POST /api/webhooks/slack/events - Slack's Events API request URL.
 *
 * Public by path (middleware.ts "/api/webhooks/"), authenticated INSIDE: every
 * request must carry Slack's v0 signature over its raw body, within five
 * minutes (lib/slack/verify.ts). Everything else is lib/slack/events.ts:
 * url_verification, the team -> workspace route, guest / other-company /
 * shared-channel drops, exactly-once per event_id, the mirror of mapped
 * channels, and the hand-off of @mentions to the agent job.
 *
 * Answers inside Slack's 3-second window. The agent turn itself runs after the
 * response: on the SLACK_AGENT_JOBS Cloudflare Queue when the Worker has that
 * binding, otherwise in after() (lib/slack/jobs.ts dispatchSlackMentionJob).
 */
import { NextResponse, after, type NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { handleSlackEvents } from "@/lib/slack/events";
import { slackSigningHeaders } from "@/lib/slack/verify";
import { dispatchSlackMentionJob, runSlackMentionJob, slackJobQueueBinding } from "@/lib/slack/jobs";
import { shadowGeneralChannelRouting } from "@/lib/jev/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const { timestamp, signature } = slackSigningHeaders(req.headers);
  if (!tursoConfigured()) {
    return NextResponse.json({ ok: false, error: "database_not_configured" }, { status: 503 });
  }
  const db = getTursoClient();
  const now = () => new Date();
  try {
    const result = await handleSlackEvents(
      { rawBody, timestamp, signature, retryNum: req.headers.get("x-slack-retry-num") },
      {
        db,
        now,
        dispatchMention: async (job) =>
          dispatchSlackMentionJob(job, {
            queue: await slackJobQueueBinding(),
            runLater: (task) => after(task),
            run: (j) => runSlackMentionJob(j, { db, now }),
          }),
        onGeneralMessage: (m) =>
          after(async () => {
            await shadowGeneralChannelRouting(db, { tenantId: m.tenantId, text: m.text, now: now() });
          }),
      },
    );
    return NextResponse.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[webhooks.slack.events]", err instanceof Error ? err.stack : err);
    return NextResponse.json({ ok: false, error: "slack_events_failed" }, { status: 500 });
  }
}
