/**
 * POST /api/webhooks/slack/interactivity - Slack's Interactivity request URL:
 * the "Approve and post" button on a review card.
 *
 * Public by path, authenticated INSIDE with Slack's v0 signature over the raw
 * form body (lib/slack/verify.ts): OASIS's app's secret with no query string,
 * or, with ?workspace=<id>, that workspace's own app's secret only, for the
 * Slack team routed to that workspace (lib/slack/own-app.ts slackRequestScope).
 * Slack wants the press acknowledged within
 * 3 seconds, so this answers as soon as the signature and the press are read
 * (acceptSlackInteraction) and runs the press's work after the answer, in
 * after(): who may approve, execute-once and the card update are
 * lib/slack/interactivity.ts, and the outcome reaches the presser through
 * Slack's response_url.
 */
import { NextResponse, after, type NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { acceptSlackInteraction, reportPressFailure } from "@/lib/slack/interactivity";
import { slackSigningHeaders } from "@/lib/slack/verify";
import { slackRequestScope } from "@/lib/slack/own-app";
import { SLACK_WORKSPACE_PARAM } from "@/lib/slack/own-app-setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "cache-control": "no-store" };

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const { timestamp, signature } = slackSigningHeaders(req.headers);
  if (!tursoConfigured()) return NextResponse.json({ ok: false, error: "database_not_configured" }, { status: 503 });
  try {
    const scope = await slackRequestScope(req.nextUrl.searchParams.get(SLACK_WORKSPACE_PARAM));
    if (!scope.ok) return NextResponse.json(scope.body, { status: scope.status, headers: NO_STORE });
    const accepted = await acceptSlackInteraction(
      { rawBody, timestamp, signature },
      { db: getTursoClient(), now: () => new Date(), env: scope.env, expectTenantId: scope.expectTenantId },
    );
    const work = accepted.work;
    if (work) {
      after(async () => {
        try {
          await work();
        } catch (err) {
          console.error("[webhooks.slack.interactivity] the press failed after Slack was answered", err instanceof Error ? err.stack : err);
          await reportPressFailure(accepted.responseUrl);
        }
      });
    }
    // Slack reads nothing from a block_actions response body; an empty 200 is the ACK.
    return accepted.status === 200
      ? new NextResponse(null, { status: 200, headers: NO_STORE })
      : NextResponse.json(accepted.body, { status: accepted.status, headers: NO_STORE });
  } catch (err) {
    console.error("[webhooks.slack.interactivity]", err instanceof Error ? err.stack : err);
    return NextResponse.json({ ok: false, error: "slack_interactivity_failed" }, { status: 500 });
  }
}
