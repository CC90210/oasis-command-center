/** Signed, in-process destination for the Maven Cloudflare Queue consumer. */
import { NextResponse, type NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { mavenPublishEnabled, mavenPublishLiveReadiness } from "@/lib/marketing/maven-publish-contract";
import { isMavenPublishJob, runMavenPublishJob } from "@/lib/marketing/maven-publish-queue";
import * as mavenCloud from "@/lib/marketing/maven-publish-cloud";
import {
  MAVEN_JOB_SIGNATURE_HEADER,
  MAVEN_JOB_TIMESTAMP_HEADER,
  verifyMavenPublishJob,
} from "@/lib/marketing/maven-publish-job-signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.text();
  // Off means ACK-and-hold: the row remains queued, so activating the producer
  // later creates one fresh message instead of consuming this one in disguise.
  if (!mavenPublishEnabled()) {
    return NextResponse.json({ ok: true, held: true, reason: "OASIS_MAVEN_PUBLISH_QUEUE_FORWARD is off" });
  }
  const signed = await verifyMavenPublishJob({
    secret: (process.env.OASIS_MAVEN_PUBLISH_JOB_SIGNING_SECRET ?? "").trim() || null,
    timestamp: req.headers.get(MAVEN_JOB_TIMESTAMP_HEADER),
    signature: req.headers.get(MAVEN_JOB_SIGNATURE_HEADER),
    body,
    nowMs: Date.now(),
  });
  if (!signed) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const readiness = mavenPublishLiveReadiness();
  if (!readiness.ready) {
    // The producer is also stopped by this same readiness gate. ACK the stale
    // message and leave its DB row queued; do not burn retries into the DLQ.
    return NextResponse.json({ ok: true, held: true, reason: readiness.reason });
  }
  if (!tursoConfigured()) return NextResponse.json({ ok: false, error: "database_not_configured" }, { status: 503 });
  let job: unknown;
  try {
    job = JSON.parse(body);
  } catch {
    return NextResponse.json({ ok: true, dropped: "invalid_json" });
  }
  if (!isMavenPublishJob(job)) {
    console.error("[maven-publish.jobs] malformed job dropped");
    return NextResponse.json({ ok: true, dropped: "malformed_job" });
  }
  try {
    const db = getTursoClient();
    const result = await runMavenPublishJob({
      job,
      store: new mavenCloud.TursoMavenPublishStore(db),
      gateway: new mavenCloud.TursoMavenPublishGateway(db),
      provider: new mavenCloud.CloudLatePublisher(),
      now: new Date(),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[maven-publish.jobs] job failed", {
      intentId: job.intentId,
      error: error instanceof Error ? error.stack : String(error),
    });
    return NextResponse.json({ ok: false, error: "job_failed" }, { status: 500 });
  }
}
