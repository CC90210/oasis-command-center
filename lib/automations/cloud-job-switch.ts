/**
 * The work behind POST /api/automations/cloud-jobs (2026-10-31): switch one
 * scheduled cloud job ON or OFF. Kept out of the route file so tests can drive
 * it with their own session, database and audit log (a Next route module may
 * only export its handlers).
 *
 * Order: who is asking (404 for anyone but CC, lib/automations/cloud-job-control.ts),
 * same-site only, a known CRON_TABLE path and a real boolean, then the write,
 * then the audit row. A refused or failed request changes nothing.
 */
import "server-only";
import { NextResponse } from "next/server";
import type { Client } from "@libsql/client";
import { authorizeCloudJobControl, sameOrigin, type CloudJobControl } from "@/lib/automations/cloud-job-control";
import { isSwitchableCloudJob, writeCronSwitch } from "@/lib/automations/cron-switches";
import { cloudJobInfo } from "@/lib/automations/cloud-jobs";
import { logTenantAudit } from "@/lib/audit/activity-feed";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export type CloudJobSwitchDeps = {
  authorize?: () => Promise<CloudJobControl>;
  db?: () => Client | null;
  audit?: typeof logTenantAudit;
  now?: () => Date;
};

function fail(status: number, error: string, message: string): NextResponse {
  return NextResponse.json({ ok: false, error, message }, { status });
}

export async function handleCloudJobSwitch(req: Request, deps: CloudJobSwitchDeps = {}): Promise<NextResponse> {
  const control = await (deps.authorize ?? authorizeCloudJobControl)();
  if (!control.ok) return NextResponse.json({ ok: false, error: control.error }, { status: control.status });
  if (!sameOrigin(req)) return fail(403, "cross_origin_refused", "Open the dashboard directly and try again.");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "invalid_json", "That request could not be read. Nothing changed.");
  }
  const { route, enabled } = (body && typeof body === "object" ? body : {}) as { route?: unknown; enabled?: unknown };
  if (typeof route !== "string" || !isSwitchableCloudJob(route)) {
    return fail(400, "unknown_job", "That is not one of the scheduled cloud jobs. Nothing changed.");
  }
  if (typeof enabled !== "boolean") return fail(400, "invalid_state", "Say ON or OFF. Nothing changed.");
  const db = deps.db ? deps.db() : tursoConfigured() ? getTursoClient() : null;
  if (!db) return fail(503, "database_not_configured", "The database is not configured. Nothing changed.");

  let saved;
  try {
    saved = await writeCronSwitch(db, { route, enabled, actorUserId: control.userId, now: (deps.now ?? (() => new Date()))() });
  } catch (error) {
    console.error("[automations.cloud_jobs.switch] write failed", {
      route,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(503, "switch_write_failed", "The switch could not be saved. Nothing changed; try again.");
  }
  const audit = await (deps.audit ?? logTenantAudit)({
    tenantId: control.tenantId,
    actorUserId: control.userId,
    actionType: "cloud_job_switch",
    targetTable: "cron_job_switches",
    targetId: route,
    after: { enabled, job: cloudJobInfo(route)?.name ?? route },
  });
  if (!audit.ok) console.error("[automations.cloud_jobs.switch.audit]", audit.error);
  return NextResponse.json({ ok: true, route, enabled: saved.enabled, changed_at: saved.changedAt });
}
