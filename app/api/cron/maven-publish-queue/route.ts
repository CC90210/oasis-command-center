/**
 * Producer for Maven's Cloudflare Queue. It sees only explicit OASIS Library
 * publish intents; it never reads Maven's local cadence or historical bank.
 */
import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { cronPauseGate } from "@/lib/automations/cron-switches";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { mavenPublishEnabled, mavenPublishLiveReadiness } from "@/lib/marketing/maven-publish-contract";
import { runMavenPublishProducer } from "@/lib/marketing/maven-publish-queue";
import { reconcileMavenPublishes } from "@/lib/marketing/maven-publish-reconcile";
import { CloudLatePublisher, TursoMavenPublishStore, mavenPublishQueueBinding } from "@/lib/marketing/maven-publish-cloud";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  // Rollback must short-circuit before even opening Turso or resolving a Queue.
  if (!mavenPublishEnabled()) {
    return NextResponse.json({ ok: true, enabled: false, queued: 0, reason: "OASIS_MAVEN_PUBLISH_QUEUE_FORWARD is off" });
  }
  const denied = checkCronAuth(req);
  if (denied) return denied;
  const paused = await cronPauseGate(req);
  if (paused) return paused;
  if (!tursoConfigured()) return NextResponse.json({ ok: false, error: "database_not_configured" }, { status: 503 });

  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  if (!dryRun) {
    const readiness = mavenPublishLiveReadiness();
    if (!readiness.ready) {
      return NextResponse.json({ ok: false, error: "publisher_not_ready", detail: readiness.reason }, { status: 503 });
    }
  }
  try {
    const store = new TursoMavenPublishStore(getTursoClient());
    let reconciliation: Awaited<ReturnType<typeof reconcileMavenPublishes>> | null = null;
    let reconcileError: string | null = null;
    if (!dryRun) {
      try {
        const provider = new CloudLatePublisher();
        reconciliation = await reconcileMavenPublishes({ store, reader: provider, now: new Date() });
      } catch (error) {
        // The cron driver prints this body to the Actions log: a stable code
        // only. The raw provider error stays in the server log below.
        reconcileError = "reconciliation_failed";
        console.error("[cron.maven-publish-queue] reconciliation skipped", error instanceof Error ? error.stack : String(error));
      }
    }
    const queue = dryRun ? { send: async () => undefined } : await mavenPublishQueueBinding();
    if (!queue) return NextResponse.json({ ok: false, error: "queue_binding_missing" }, { status: 503 });
    const result = await runMavenPublishProducer({ store, queue, dryRun, now: new Date() });
    const ok = !reconcileError && (reconciliation?.readFailures ?? 0) === 0 && result.reaped.failed === 0;
    return NextResponse.json({ ok, enabled: true, reconciliation, reconcile_error: reconcileError, ...result }, { status: ok ? 200 : 409 });
  } catch (error) {
    console.error("[cron.maven-publish-queue]", error instanceof Error ? error.stack : String(error));
    return NextResponse.json({ ok: false, error: "producer_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
