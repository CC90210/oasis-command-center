/**
 * components/os/department/routine-rules.ts — which routines a department
 * shows, and how a schedule reads to an owner.
 *
 * PURE. The read itself (tenant_cron_jobs) is in ./routines.ts; this file only
 * shapes rows, so tests/os-departments.test.ts can run it without a database.
 *
 * Routines are the workspace's own `tenant_cron_jobs` rows. The Empire lane
 * (`cron_jobs`, OASIS's operator schedules) is never LISTED here: it belongs
 * to Admin, and a client owner has no business seeing CC's machine. Its rows
 * that carry the OASIS workspace's own tenant_id are counted in OASIS's
 * routine HEALTH (routineHealth, below; read in ./routines.ts), because they
 * are that workspace's routines and a health card that skips them says
 * "nothing measured" about a fleet that runs every few minutes. They are
 * counted only for the platform operator, the one viewer the Automations page
 * lists them for, and each row keeps its `lane`, so a failure in that lane
 * points at Automations (failedRoutinesHref), never at a panel that cannot
 * show it.
 */

import type { DepartmentKey } from "@/lib/os/types";

export type RoutineRow = {
  id: string;
  agentKey: string;
  name: string;
  description: string;
  schedule: string;
  enabled: boolean;
  lastRunAt: string | null;
  /** tenant_cron_jobs.last_run_status: "success" | "error" | "unknown" | null. */
  lastRunStatus: string | null;
  /** "workspace": tenant_cron_jobs, listed on the panel. "empire": cron_jobs, listed only in Automations. */
  lane: "workspace" | "empire";
};

/** SQLite hands booleans back as 0/1 (and sometimes "1"); Postgres as true. */
function asBool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

function asText(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

export function normalizeRoutineRow(raw: Record<string, unknown>): RoutineRow {
  return {
    id: asText(raw.id),
    agentKey: asText(raw.agent_key).trim().toLowerCase(),
    name: asText(raw.name).trim(),
    description: asText(raw.description).trim(),
    schedule: asText(raw.schedule).trim(),
    enabled: asBool(raw.enabled),
    lastRunAt: raw.last_run_at ? asText(raw.last_run_at) : null,
    lastRunStatus: raw.last_run_status ? asText(raw.last_run_status) : null,
    lane: raw.lane === "empire" ? "empire" : "workspace",
  };
}

/**
 * A department's routines. Operations lists every routine in the workspace
 * (design doc §(c) Routines UX: "Team › Operations lists all of them"); every
 * other department lists the routines owned by the agent its channel is bound
 * to. `agentSlugs` is that binding — an unbound department owns none.
 */
export function routinesForDepartment(
  rows: readonly RoutineRow[],
  key: DepartmentKey,
  agentSlugs: readonly string[],
): RoutineRow[] {
  if (key === "operations") return [...rows];
  const owners = new Set(agentSlugs.map((s) => s.trim().toLowerCase()).filter(Boolean));
  return rows.filter((r) => owners.has(r.agentKey));
}

/** Failed on its last run inside the window. An old failure is history, not news. */
export function failedWithin(rows: readonly RoutineRow[], hours: number, now: number): RoutineRow[] {
  const since = now - hours * 3_600_000;
  return rows.filter((r) => {
    if (r.lastRunStatus !== "error" || !r.lastRunAt) return false;
    const at = Date.parse(r.lastRunAt);
    return Number.isFinite(at) && at >= since;
  });
}

/**
 * The health of a workspace's routines in three numbers: how many are on, how
 * many of those failed in the last 24 hours, and when any of them last ran
 * cleanly. Today's Operations card and the Operations tab both print this, so
 * the two cannot disagree about the same rows.
 *
 * `total` 0 is "no routines set up", which a caller shows as no data, never as
 * "0 failed" (a fleet of nothing has no failures to speak of).
 */
export type RoutineHealth = {
  total: number;
  on: number;
  failed24h: RoutineRow[];
  /** Newest successful run across the routines that are on. Null = none recorded. */
  lastSuccessAt: string | null;
};

type RoutineRead = { ok: true; value: RoutineRow[] } | { ok: false };

/**
 * Whether a viewer's routine health includes the Empire lane: true (the
 * platform operator in OASIS), false (anyone else: correctly no Empire lane),
 * or "unknown" when the verified operator check could not be made (a failed
 * profile or session read). "unknown" is not "no": the operator's own Empire
 * failures would vanish behind a clean-looking workspace lane, so it reads as
 * a failed Empire read (mergeRoutineReads), "Couldn't check".
 */
export type EmpireLane = boolean | "unknown";

/** The Empire read for a lane answer: null = not asked, a failed read for "unknown". */
export async function empireReadFor(lane: EmpireLane, load: () => Promise<RoutineRead>): Promise<RoutineRead | null> {
  if (lane === "unknown") return { ok: false };
  return lane ? load() : null;
}

/**
 * The workspace lane plus, when asked (null = not asked), the Empire lane: one
 * list for the health counts. Either read failing fails the whole answer — a
 * health card built from half the routines would call the other half fine.
 */
export function mergeRoutineReads(workspace: RoutineRead, empire: RoutineRead | null): RoutineRead {
  if (!workspace.ok) return { ok: false };
  if (empire === null) return workspace;
  if (!empire.ok) return { ok: false };
  return { ok: true, value: [...workspace.value, ...empire.value] };
}

export function routineHealth(rows: readonly RoutineRow[], now: number): RoutineHealth {
  const on = rows.filter((r) => r.enabled);
  let lastSuccessAt: string | null = null;
  let lastMs = -Infinity;
  for (const r of on) {
    if (r.lastRunStatus !== "success" || !r.lastRunAt) continue;
    const at = Date.parse(r.lastRunAt);
    if (Number.isFinite(at) && at > lastMs) {
      lastMs = at;
      lastSuccessAt = r.lastRunAt;
    }
  }
  return { total: rows.length, on: on.length, failed24h: failedWithin(on, 24, now), lastSuccessAt };
}

/** The Operations tab: its panel lists the workspace's own routines. */
export const OPERATIONS_HREF = "/team/operations";
/** Automations: the only page that lists the Empire lane (operator-only). */
export const AUTOMATIONS_HREF = "/automations";

/**
 * Where someone goes to see WHICH routines failed. The Operations panel lists
 * the workspace lane only, so a failure in the Empire lane is seen in
 * Automations: a "see which" link to a page that cannot show the row is not
 * a link.
 */
export function failedRoutinesHref(failed: readonly Pick<RoutineRow, "lane">[]): string {
  return failed.some((r) => r.lane === "empire") ? AUTOMATIONS_HREF : OPERATIONS_HREF;
}

/** "lead_engine" → "Lead engine". Names people typed ("Weekly digest") pass through. */
export function routineTitle(name: string): string {
  const cleaned = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "Untitled routine";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** "Ran 2h ago", "Failed 5m ago", "Never run". */
export function lastRunLabel(row: Pick<RoutineRow, "lastRunAt" | "lastRunStatus">, ago: (iso: string) => string): string {
  if (!row.lastRunAt) return "Never run";
  if (row.lastRunStatus === "error") return `Failed ${ago(row.lastRunAt)}`;
  if (row.lastRunStatus === "success") return `Ran ${ago(row.lastRunAt)}`;
  return `Last run ${ago(row.lastRunAt)}`;
}

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

function clock(hour: string, minute: string): string {
  const h = Number(hour);
  const m = Number(minute);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/**
 * A five-field cron expression in plain English. Cron syntax never appears in
 * the department panel (design doc §(c) Routines UX), so a shape this does not
 * recognise reads "Custom schedule" rather than the raw expression. Times are
 * the scheduler's clock (the bridge runs local time), so no zone is claimed.
 */
export function describeSchedule(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "Custom schedule";
  const [minute, hour, dom, month, dow] = parts;
  const everyMin = minute.match(/^\*\/(\d+)$/);
  if (everyMin && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return everyMin[1] === "1" ? "Every minute" : `Every ${everyMin[1]} minutes`;
  }
  if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "Every minute";
  if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Hourly at :${minute.padStart(2, "0")}`;
  }
  const everyHour = hour.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(minute) && everyHour && dom === "*" && month === "*" && dow === "*") {
    return `Every ${everyHour[1]} hours`;
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && month === "*") {
    const at = clock(hour, minute);
    if (dom === "*") {
      if (dow === "*") return `Daily at ${at}`;
      if (dow === "1-5") return `Weekdays at ${at}`;
      if (dow === "0,6" || dow === "6,0") return `Weekends at ${at}`;
      if (/^[0-6]$/.test(dow)) return `${DAY_NAMES[Number(dow)]} at ${at}`;
    } else if (/^\d+$/.test(dom) && dow === "*") {
      return `Monthly on day ${dom} at ${at}`;
    }
  }
  return "Custom schedule";
}
