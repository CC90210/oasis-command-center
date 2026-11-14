import "server-only";
import type { Client } from "@libsql/client";
import { CRON_TABLE } from "@/workers/oasis-cc-cron/src/index";
import { nextRuns } from "@/lib/automations/schedule-plan";
import type { DripCheck } from "./drip-checks";
import { VPS_HEALTH_SERVICES } from "@/lib/automations/vps-health";
import { workerEvidenceStaleMs } from "@/lib/automations/worker-status";

type Row = Record<string, unknown>;
export type ObserverFinding = { id: string; observed: number | null; reason: string };
export const AUTOMATION_OBSERVER_CHECK_IDS = [
  "observation_sources", "expected_occurrences", "worker_progress", "inbox_completion", "financial_handoff",
  "notification_delivery", "health_alert_delivery", "business_outcomes", "weekly_system_gate", "independent_observer_delivery",
].map((id) => `automation.${id}`);
const MINUTE = 60_000;
const at = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;

/**
 * The observer Worker samples every minute (workers/oasis-automation-observer,
 * "* * * * *") so the board and health_check_runs stay live. Paging is a
 * different matter: the runner's two-strike confirmation and its "next check in
 * 15 min" wording were written for the quarter-hour cadence every other check
 * runs on. Fed minute samples, "two consecutive failures" meant two MINUTES, so a
 * Telegram long-poll reconnect (3-4 min) became a 🔴 FAILING and, two minutes
 * later, a 🟢 RECOVERED — 39 flaps and ~30 pages in the 24 h to 2026-11-13.
 * Only the quarter-hour sample may page. The state machine then sees one sample
 * per 15 minutes and confirms on the second consecutive failing sample, about 15
 * minutes after the first — a condition has to outlive a reconnect to page.
 */
export const OBSERVER_PAGING_INTERVAL_MIN = 15;
export function isObserverPagingTick(tickMs: number): boolean {
  const date = new Date(tickMs);
  return Number.isFinite(tickMs) && date.getUTCMinutes() % OBSERVER_PAGING_INTERVAL_MIN === 0;
}

/** Two expected slots after the last confirmed occurrence, using its real zone.
 * Disabled jobs and a future explicitly scheduled slot are never an outage. */
export function missedOccurrences(input: { enabled: boolean; schedule: string; zone: string; last: string | null; due?: string | null; created?: string | null; graceMs?: number }, now: number): boolean | null {
  if (!input.enabled) return false;
  const due = at(input.due);
  if (Number.isFinite(due) && due > now) return false;
  const from = Number.isFinite(due) ? due - 1 : at(input.last ?? input.created);
  if (!Number.isFinite(from)) return null;
  try {
    const runs = nextRuns(input.schedule, input.zone, from, 2);
    if (runs.length < 2) return null;
    return now > runs[1].getTime() + (input.graceMs ?? 90_000);
  } catch { return null; }
}

/** Every query is scoped or explicitly reads a global schedule/control table.
 * Missing migration/provider telemetry yields unverified, never an empty queue. */
export async function observeAutomations(db: Client, tenantId: string, now = Date.now()): Promise<ObserverFinding[]> {
  const queries: Record<string, { sql: string; args: (string | number)[] }> = {
    empire: { sql: "SELECT id,name,schedule,is_active,last_run_at,next_run_at,created_at,fail_count,last_result FROM cron_jobs WHERE tenant_id=?", args: [tenantId] },
    workspace: { sql: "SELECT id,name,schedule,enabled,last_run_at,last_run_status,created_at,updated_at,tz FROM tenant_cron_jobs WHERE tenant_id=?", args: [tenantId] },
    // cron_runs / switches / controls are global provider control-plane metadata.
    cloud: { sql: "SELECT route,tick_at AS last_tick,ok,http_status FROM cron_runs r WHERE tick_at=(SELECT MAX(tick_at) FROM cron_runs latest WHERE latest.route=r.route)", args: [] },
    switches: { sql: "SELECT route,enabled,changed_at FROM cron_job_switches", args: [] },
    controls: { sql: "SELECT service,desired,changed_at FROM vps_unit_controls", args: [] },
    workers: { sql: "SELECT service,status,last_ping_at,last_error,metadata FROM integrations_health WHERE tenant_id=? AND service LIKE 'vps.%'", args: [tenantId] },
    mailboxes: { sql: "SELECT source_account,last_scan_at,bootstrap_started_at,last_error FROM inbox_mailboxes WHERE tenant_id=?", args: [tenantId] },
    inbox: { sql: "SELECT disposition,financial_status,notification_status,MIN(discovered_at) AS oldest,MIN(CASE WHEN json_valid(steps_json) THEN COALESCE(json_extract(steps_json,'$.handoff_at'),discovered_at) ELSE discovered_at END) AS handoff_at,COUNT(*) AS n FROM inbox_messages WHERE tenant_id=? AND (disposition='pending' OR financial_status='pending' OR notification_status IN ('queued','retry')) GROUP BY disposition,financial_status,notification_status", args: [tenantId] },
    outbox: { sql: "SELECT status,MIN(created_at) AS oldest,COUNT(*) AS n FROM automation_notification_outbox WHERE tenant_id=? AND status<>'delivered' GROUP BY status", args: [tenantId] },
    occurrences: { sql: "SELECT job_id,scheduled_at,state,lease_expires_at,deadline_at,result_json,updated_at FROM automation_occurrences o WHERE tenant_id=? AND (state IN ('claimed','running','delivery_unknown') OR scheduled_at=(SELECT MAX(scheduled_at) FROM automation_occurrences latest WHERE latest.tenant_id=o.tenant_id AND latest.job_id=o.job_id))", args: [tenantId] },
    weekly: { sql: "SELECT status,last_ping_at,metadata FROM integrations_health WHERE tenant_id=? AND service='automation.weekly_full_truth' ORDER BY last_ping_at DESC LIMIT 1", args: [tenantId] },
    healthDelivery: { sql: "SELECT alert_key,delivery_status FROM health_alert_state WHERE tenant_id=? AND delivery_status IN ('dispatching','unknown','rejected','permanent_failure')", args: [tenantId] },
  };
  const entries = await Promise.all(Object.entries(queries).map(async ([key, query]) => {
    try { return [key, (await db.execute(query)).rows as unknown as Row[]] as const; }
    catch { return [key, null] as const; }
  }));
  const data = Object.fromEntries(entries) as Record<string, Row[] | null>;
  const result: ObserverFinding[] = [];
  const add = (id: string, observed: number | null, reason: string) => result.push({ id: `automation.${id}`, observed, reason });
  const missing = Object.keys(data).filter((key) => data[key] === null);
  add("observation_sources", missing.length ? null : 0, missing.length ? `Observation unavailable: ${missing.join(", ")}; verify connectivity and migrations. No empty-queue claim.` : "All automation observation sources were read.");

  const late: string[] = [];
  let unverified = false;
  for (const row of data.empire ?? []) {
    if (!Number(row.is_active)) continue;
    const active = (data.occurrences ?? []).some((o) => o.job_id === row.id && ["claimed", "running"].includes(String(o.state)) && Number(o.lease_expires_at) * 1000 > now && Number(o.deadline_at) * 1000 > now);
    const missed = active ? false : missedOccurrences({ enabled: true, schedule: String(row.schedule), zone: "America/Toronto", last: row.last_run_at as string | null, due: row.next_run_at as string | null, created: row.created_at as string | null }, now);
    if (missed === null) unverified = true;
    if (missed || Number(row.fail_count) > 0) late.push(String(row.name));
  }
  for (const row of data.workspace ?? []) {
    if (!Number(row.enabled)) continue;
    const last = at(row.updated_at) > at(row.last_run_at) ? row.updated_at : row.last_run_at;
    const missed = missedOccurrences({ enabled: true, schedule: String(row.schedule), zone: String(row.tz || "America/Toronto"), last: last as string | null, created: row.created_at as string | null }, now);
    if (missed === null) unverified = true;
    if (missed || row.last_run_status === "error") late.push(String(row.name));
  }
  for (const entry of CRON_TABLE) {
    const control = data.switches?.find((r) => r.route === entry.path);
    if (control && !Number(control.enabled)) continue;
    const receipt = data.cloud?.find((r) => r.route === entry.path);
    const tick = receipt?.last_tick;
    const last = at(control?.changed_at) > at(tick) ? control?.changed_at : tick;
    const missed = missedOccurrences({ enabled: true, schedule: entry.schedule, zone: entry.timeZone ?? "UTC", last: last as string | null,
      graceMs: /dispatch-(engine-fallbacks|automations)$/.test(entry.path) ? 15 * MINUTE : 2 * MINUTE }, now);
    if (missed === null) unverified = true;
    if (missed || (receipt && !Number(receipt.ok))) late.push(entry.path);
  }
  add("expected_occurrences", data.empire && data.workspace && data.cloud && data.switches && !unverified ? late.length : null,
    late.length ? `Missed or failed occurrences: ${late.join(", ").slice(0, 350)}` : unverified ? "An enabled schedule has no valid occurrence evidence." : "Enabled schedules have recent occurrence evidence; paused schedules excluded.");

  const off = new Set((data.controls ?? []).filter((r) => r.desired === "off" || r.desired === "stopped").map((r) => String(r.service)));
  const workers = VPS_HEALTH_SERVICES.filter((service) => !off.has(service)).map((service) =>
    (data.workers ?? []).filter((r) => r.service === service).sort((a, b) => at(b.last_ping_at) - at(a.last_ping_at))[0] ?? { service });
  const staleWorkers = workers.filter((r) => {
    let running = false;
    try { running = JSON.parse(String(r.metadata || "{}")).phase === "running"; } catch { /* unverified */ }
    return !Number.isFinite(at(r.last_ping_at)) || now - at(r.last_ping_at) > workerEvidenceStaleMs(String(r.service)) || !(r.status === "healthy" || (r.status === "unknown" && running));
  });
  add("worker_progress", data.workers && data.controls ? staleWorkers.length : null,
    staleWorkers.length ? `Worker evidence requires attention: ${[...new Set(staleWorkers.map((r) => String(r.service)))].join(", ")}` : "Enabled worker observations are fresh; this is not proof of completed business work.");

  const inboxOff = off.has("vps.oasis-inbox-sweep");
  const staleMailbox = (data.mailboxes ?? []).some((r) => !Number.isFinite(at(r.last_scan_at)) || now - at(r.last_scan_at) > 10 * MINUTE);
  const pending = (data.inbox ?? []).filter((r) => r.disposition === "pending" && (!Number.isFinite(at(r.oldest)) || now - at(r.oldest) > 10 * MINUTE)).reduce((n, r) => n + Number(r.n), 0);
  add("inbox_completion", inboxOff ? 0 : data.inbox && data.mailboxes?.length ? pending + Number(staleMailbox) : null,
    inboxOff ? "Inbox worker is intentionally disabled." : `${pending} message(s) exceed the 10-minute ingestion contract; scan ${staleMailbox ? "overdue or unverified" : "current"}. Review-held mail is excluded.`);
  const atlas = (data.workspace ?? []).find((r) => /Inbound Financial Email/.test(String(r.name)));
  const atlasOff = Boolean(atlas && !Number(atlas.enabled));
  const finance = (data.inbox ?? []).filter((r) => r.financial_status === "pending" && (!Number.isFinite(at(r.handoff_at ?? r.oldest)) || now - at(r.handoff_at ?? r.oldest) > 30 * MINUTE)).reduce((n, r) => n + Number(r.n), 0);
  add("financial_handoff", atlasOff ? 0 : data.inbox && atlas ? finance : null,
    atlasOff ? "Financial consumer is intentionally disabled; no completion claim." : `${finance} financial handoff(s) exceed 30 minutes without completion or an explicit review outcome.`);
  const notices = (data.outbox ?? []).filter((r) => ["permanent_failure", "delivery_unknown"].includes(String(r.status)) || !Number.isFinite(Number(r.oldest)) || now - Number(r.oldest) * 1000 > 5 * MINUTE).reduce((n, r) => n + Number(r.n), 0);
  add("notification_delivery", data.outbox ? notices : null, `${notices} notification(s) are overdue, refused, or have an unknown provider acknowledgment. Queued does not mean delivered.`);
  add("health_alert_delivery", data.healthDelivery ? data.healthDelivery.length : null,
    `${data.healthDelivery?.length ?? "Unverified"} health alert delivery acknowledgment(s) require attention. Uncertain sends are held for reconciliation.`);
  const latest = new Map<string, Row>();
  for (const row of data.occurrences ?? []) {
    const previous = latest.get(String(row.job_id));
    if (!previous || String(row.scheduled_at) > String(previous.scheduled_at)) latest.set(String(row.job_id), row);
  }
  // Only a job's latest occurrence can be stuck. A lost lease stays `delivery_unknown` in the table
  // for good (nothing reconciles it), so counting every such row paged "business outcomes" for days
  // after the job had run again cleanly (2026-11-09 to 11-14: three old lost leases, one failing
  // check). The job's next run is the verdict on it; a lost lease nobody has run since still counts.
  const stuck = [...latest.values()].filter((r) => r.state === "delivery_unknown" || (["claimed", "running"].includes(String(r.state)) && (Number(r.lease_expires_at) * 1000 < now || Number(r.deadline_at) * 1000 < now)));
  const failed = [...latest.values()].filter((r) => {
    const definition = (data.empire ?? []).find((job) => job.id === r.job_id);
    if (!definition || !Number(definition.is_active)) return false;
    if (r.state === "failed") return true;
    if (r.state !== "completed") return false;
    try {
      const outcome = JSON.parse(String(r.result_json || "{}"));
      return ["partial", "failed", "unknown", "delivery_unknown"].includes(outcome.business_status ?? outcome.status ?? "unknown") || Number(outcome.failed_count) > 0;
    } catch { return true; }
  });
  add("business_outcomes", data.occurrences ? stuck.length + failed.length : null,
    `${stuck.length} execution(s) lost their lease/deadline or have uncertain effects; ${failed.length} job(s) have a failed, partial, or unverified latest business outcome.`);
  let weekly: { overall?: string; checked_at?: string } = {};
  try {
    const parsed = JSON.parse(String(data.weekly?.[0]?.metadata || "{}"));
    if (parsed && typeof parsed === "object") weekly = parsed;
  } catch { /* explicit unverified */ }
  // The Python publisher emits WARN for a completed, degraded check. Keep its
  // verdict visible instead of treating that valid report as missing evidence.
  const weeklyKnown = ["GREEN", "WARN", "AMBER", "RED"].includes(weekly.overall ?? "") && Number.isFinite(at(weekly.checked_at));
  const weeklyStale = now - at(weekly.checked_at) > (7 * 24 + 2) * 60 * MINUTE;
  add("weekly_system_gate", !weeklyKnown || weeklyStale ? null : weekly.overall === "GREEN" ? 0 : 1,
    !weeklyKnown || weeklyStale ? "Weekly system gate is missing, unverified, or overdue." : `Weekly system verdict: ${weekly.overall}. Report delivery is recorded separately and is not proof of a healthy system.`);
  return result;
}

export function observerChecks(findings: ObserverFinding[]): DripCheck[] {
  return findings.map((finding) => ({ id: finding.id, severity: "critical", lane: "operator", rule: { kind: "must_be_zero" },
    observe: async () => finding.observed, observeDetailed: async () => ({ observed: finding.observed, reason: finding.reason }), describe: (r) => r.reason }));
}
