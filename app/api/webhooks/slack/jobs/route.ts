/**
 * POST /api/webhooks/slack/jobs - where the SLACK_AGENT_JOBS queue consumer
 * (worker-entry.ts) hands each @mention job to the app.
 *
 * Only a job signed by the consumer (lib/slack/job-signature.ts, the Slack
 * signing secret over a job-only message) is run; anything else is 401. The
 * job itself is lib/slack/jobs.ts runSlackMentionJob: one approval per Slack
 * event, so a queue retry never drafts twice.
 *
 * Answers 200 when the job is done (an approval, a duplicate, a notice or a
 * drop), 500 when it failed and should be retried by the queue.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { slackSigningSecret } from "@/lib/slack/verify";
import { JOB_SIGNATURE_HEADER, JOB_TIMESTAMP_HEADER, verifySlackJob } from "@/lib/slack/job-signature";
import { isSlackMentionJob, runSlackMentionJob } from "@/lib/slack/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signed = await verifySlackJob({
    secret: slackSigningSecret(),
    timestamp: req.headers.get(JOB_TIMESTAMP_HEADER),
    signature: req.headers.get(JOB_SIGNATURE_HEADER),
    body,
    nowMs: Date.now(),
  });
  if (!signed) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!tursoConfigured()) return NextResponse.json({ ok: false, error: "database_not_configured" }, { status: 503 });
  let job: unknown;
  try {
    job = JSON.parse(body);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  // A malformed job will never succeed: acknowledge it (the queue drops it) and log.
  if (!isSlackMentionJob(job)) {
    console.error("[webhooks.slack.jobs] malformed job dropped");
    return NextResponse.json({ ok: true, dropped: "malformed_job" });
  }
  try {
    const out = await runSlackMentionJob(job, { db: getTursoClient(), now: () => new Date() });
    return NextResponse.json({ ok: true, ...out });
  } catch (err) {
    console.error("[webhooks.slack.jobs] job failed", { tenantId: job.tenantId, eventId: job.eventId, error: err instanceof Error ? err.stack : String(err) });
    return NextResponse.json({ ok: false, error: "job_failed" }, { status: 500 });
  }
}
