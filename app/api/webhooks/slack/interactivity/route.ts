/**
 * POST /api/webhooks/slack/interactivity - Slack's Interactivity request URL:
 * the "Approve and post" button on an approval card.
 *
 * Public by path, authenticated INSIDE with Slack's v0 signature over the raw
 * form body (lib/slack/verify.ts). Who may approve, execute-once, and the card
 * update are lib/slack/interactivity.ts.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { handleSlackInteractivity } from "@/lib/slack/interactivity";
import { slackSigningHeaders } from "@/lib/slack/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const { timestamp, signature } = slackSigningHeaders(req.headers);
  if (!tursoConfigured()) return NextResponse.json({ ok: false, error: "database_not_configured" }, { status: 503 });
  try {
    const result = await handleSlackInteractivity({ rawBody, timestamp, signature }, { db: getTursoClient(), now: () => new Date() });
    // Slack reads nothing from a block_actions response body; an empty 200 is the ACK.
    return result.status === 200
      ? new NextResponse(null, { status: 200, headers: { "cache-control": "no-store" } })
      : NextResponse.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[webhooks.slack.interactivity]", err instanceof Error ? err.stack : err);
    return NextResponse.json({ ok: false, error: "slack_interactivity_failed" }, { status: 500 });
  }
}
