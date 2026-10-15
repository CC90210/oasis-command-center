/** Minute dispatcher for enabled guided department tasks. */
import "server-only";

import type { Client } from "@libsql/client";
import { nextRuns, planToCron, validatePlan, type SchedulePlan } from "@/lib/automations/schedule-plan";
import {
  GuidedPreflightUnavailable,
  recordMissedGuidedAutomation,
  runGuidedAutomation,
  type GuidedAutomationRow,
} from "@/lib/os/runs/guided-run";

/** Enabled guided rows read per query; the scan pages until every enabled row has been read. */
const PAGE_SIZE = 500;
/**
 * A ceiling on the rows one tick reads, far above any real fleet (30 per workspace). Reaching it is
 * logged as an incident: a row past it would not be read that minute.
 */
const SCAN_LIMIT = 10_000;
/** Due rows worked per tick, oldest due slot first. */
const DUE_ROWS_LIMIT = 25;
/** Slots read for one row per tick. */
const SLOT_LIMIT = 16;
/** Model turns started per tick; a tick must finish well inside the Worker's own 840 s abort. */
const RUNS_PER_TICK = 8;
/** "Missed" notes written per tick (each is a few database writes). */
const MISSED_PER_TICK = 48;
const CONCURRENCY = 2;
/** A slot later than this is recorded as missed, never run late: the owner asked for 8:00, not for 8:00 or whenever. */
const MISS_GRACE_MS = 30 * 60_000;
/** Time a run needs beyond its own cap (preflight, receipts, stamping). */
const RUN_RESERVE_MS = 30_000;
const DEFAULT_BUDGET_MS = 720_000;
const DEFAULT_CAP_SEC = 240;

export type GuidedDispatchSummary = {
  scanned: number;
  overLimit: boolean;
  started: string[];
  alreadyClaimed: string[];
  missed: string[];
  failed: string[];
  deferred: string[];
  invalid: string[];
  /** Rows read as due that were paused, deleted or edited before they ran. */
  skipped: string[];
  /** A read the preflight needed failed; the slot stays open for the next minute. */
  retrying: string[];
};

type DispatcherDeps = {
  run: typeof runGuidedAutomation;
  recordMissed: typeof recordMissedGuidedAutomation;
};

const COLUMNS = `id, tenant_id, owner_user_id, agent_key, name, action_type, action_payload,
                 enabled, last_scheduled_for, created_at, updated_at`;

function rowsOf(result: { rows: unknown[] }): GuidedAutomationRow[] {
  return result.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id ?? ""),
      tenant_id: String(row.tenant_id ?? ""),
      owner_user_id: String(row.owner_user_id ?? ""),
      agent_key: String(row.agent_key ?? ""),
      name: String(row.name ?? "Automation"),
      action_type: String(row.action_type ?? ""),
      action_payload: row.action_payload,
      enabled: row.enabled,
      last_scheduled_for: typeof row.last_scheduled_for === "string" ? row.last_scheduled_for : null,
      created_at: typeof row.created_at === "string" ? row.created_at : null,
      updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    };
  });
}

function json(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function planOfValue(value: unknown): SchedulePlan | null {
  const checked = validatePlan(value);
  return checked.ok ? checked.plan : null;
}

function planOf(raw: unknown): SchedulePlan | null {
  const payload = json(raw) as Record<string, unknown> | null;
  const schedule = payload && typeof payload === "object" ? (payload.schedule as Record<string, unknown> | undefined) : undefined;
  return planOfValue(schedule?.plan);
}

/** The time limit the stored payload asks for (the run engine re-validates it; this only budgets time). */
function capSecOf(raw: unknown): number {
  const payload = json(raw) as Record<string, unknown> | null;
  const cap = payload && typeof payload === "object" ? Number(payload.runtime_cap_sec) : NaN;
  return Number.isFinite(cap) && cap > 0 && cap <= 600 ? cap : DEFAULT_CAP_SEC;
}

function dateOf(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

type SlotBase = Pick<GuidedAutomationRow, "last_scheduled_for" | "created_at" | "updated_at">;

/** Activation stamps last_scheduled_for. created_at is the fail-closed legacy fallback; updated_at can
 * be changed by a preview result and is not an enabling time. */
function baseOf(row: SlotBase, now: Date): Date {
  return dateOf(row.last_scheduled_for) ?? dateOf(row.created_at) ?? dateOf(row.updated_at) ?? now;
}

function dueSlots(row: SlotBase, plan: SchedulePlan, now: Date): Date[] {
  if (plan.mode === "manual") return [];
  return nextRuns(planToCron(plan), plan.timezone, baseOf(row, now), SLOT_LIMIT).filter((slot) => slot.getTime() <= now.getTime());
}

async function stampSlot(db: Client, row: Pick<GuidedAutomationRow, "id" | "tenant_id">, slot: Date, now: Date): Promise<void> {
  await db.execute({
    sql: `UPDATE tenant_cron_jobs
          SET last_scheduled_for = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
            AND (last_scheduled_for IS NULL OR last_scheduled_for < ?)`,
    args: [slot.toISOString(), now.toISOString(), row.id, row.tenant_id, slot.toISOString()],
  });
}

type Candidate = { id: string; tenantId: string; firstSlot: Date; baseMs: number };

/** Which of these (automation, slot) pairs already have a real (not "missed") run, and in what state. */
async function claimedSlots(db: Client, candidates: Candidate[], now: Date): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (candidates.length === 0) return out;
  const earliest = candidates.reduce((min, c) => (c.firstSlot < min ? c.firstSlot : min), candidates[0].firstSlot);
  for (let i = 0; i < candidates.length; i += 100) {
    const chunk = candidates.slice(i, i + 100);
    const marks = chunk.map(() => "?").join(",");
    const rs = await db.execute({
      sql: `SELECT tenant_id, automation_id, scheduled_for, status FROM dept_chat_runs
            WHERE automation_id IN (${marks}) AND tenant_id IN (${marks})
              AND status <> 'missed' AND scheduled_for >= ? AND scheduled_for <= ?`,
      args: [...chunk.map((c) => c.id), ...chunk.map((c) => c.tenantId), earliest.toISOString(), now.toISOString()],
    });
    for (const raw of rs.rows) {
      const r = raw as unknown as Record<string, unknown>;
      out.set(`${String(r.tenant_id)}|${String(r.automation_id)}|${String(r.scheduled_for)}`, String(r.status));
    }
  }
  return out;
}

/** Dispatch rows independently, but only two model turns at a time. */
export async function dispatchGuidedAutomations(input: {
  db: Client;
  now?: Date;
  /** The most enabled rows one tick reads (default 10,000). */
  scanLimit?: number;
  /** Rows per page of the scan (default 500). */
  pageSize?: number;
  /** Due rows worked per tick (default 25). */
  dueLimit?: number;
  runsPerTick?: number;
  budgetMs?: number;
  concurrency?: number;
  deps?: Partial<DispatcherDeps>;
}): Promise<GuidedDispatchSummary> {
  const now = input.now ?? new Date();
  const startedAt = Date.now();
  const budgetMs = input.budgetMs ?? DEFAULT_BUDGET_MS;
  const deps: DispatcherDeps = {
    run: input.deps?.run ?? runGuidedAutomation,
    recordMissed: input.deps?.recordMissed ?? recordMissedGuidedAutomation,
  };
  const scanLimit = Math.max(1, Math.min(input.scanLimit ?? SCAN_LIMIT, SCAN_LIMIT));
  const dueLimit = Math.max(1, Math.min(input.dueLimit ?? DUE_ROWS_LIMIT, DUE_ROWS_LIMIT));
  const runsPerTick = Math.max(1, Math.min(input.runsPerTick ?? RUNS_PER_TICK, RUNS_PER_TICK));

  // 1. Read EVERY enabled guided row, cheaply (its schedule and stamps, not its objective or history),
  //    page by page in id order. Any one slice (the oldest by stamp, the first N) lets rows that are not
  //    due hide every row behind them, and a due row there would be missed.
  const pageSize = Math.max(1, Math.min(input.pageSize ?? PAGE_SIZE, PAGE_SIZE));
  const scanned: Record<string, unknown>[] = [];
  let overLimit = false;
  let after = "";
  for (;;) {
    const page = await input.db.execute({
      sql: `SELECT id, tenant_id, last_scheduled_for, created_at, updated_at,
                   CASE WHEN json_valid(action_payload) = 1 THEN json_extract(action_payload, '$.schedule.plan') END AS plan_json
            FROM tenant_cron_jobs
            WHERE enabled = 1 AND action_type = 'department_task' AND id > ?
              AND CASE
                    WHEN json_valid(action_payload) = 1 THEN COALESCE(json_extract(action_payload, '$.schedule.plan.mode'), '')
                    ELSE ''
                  END <> 'manual'
            ORDER BY id ASC
            LIMIT ?`,
      args: [after, pageSize],
    });
    const rows = page.rows.map((raw) => raw as unknown as Record<string, unknown>);
    for (const row of rows) {
      if (scanned.length >= scanLimit) {
        overLimit = true;
        break;
      }
      scanned.push(row);
    }
    if (overLimit || rows.length < pageSize) break;
    after = String(rows[rows.length - 1].id ?? "");
  }
  const summary: GuidedDispatchSummary = {
    scanned: scanned.length,
    overLimit,
    started: [],
    alreadyClaimed: [],
    missed: [],
    failed: [],
    deferred: [],
    invalid: [],
    skipped: [],
    retrying: [],
  };
  if (summary.overLimit) console.error("[guided.dispatch.scan_limit]", { limit: scanLimit });

  // 2. Which rows have a slot due now.
  let candidates: Candidate[] = [];
  for (const r of scanned) {
    const id = String(r.id ?? "");
    const tenantId = String(r.tenant_id ?? "");
    const plan = planOfValue(json(r.plan_json));
    if (!plan) {
      summary.invalid.push(id);
      console.error("[guided.dispatch.invalid]", { tenantId, automationId: id, code: "schedule_invalid" });
      continue;
    }
    if (plan.mode === "manual") continue;
    const base = baseOf({
      last_scheduled_for: typeof r.last_scheduled_for === "string" ? r.last_scheduled_for : null,
      created_at: typeof r.created_at === "string" ? r.created_at : null,
      updated_at: typeof r.updated_at === "string" ? r.updated_at : null,
    }, now);
    const first = nextRuns(planToCron(plan), plan.timezone, base, 1)[0];
    if (first && first.getTime() <= now.getTime()) candidates.push({ id, tenantId, firstSlot: first, baseMs: base.getTime() });
  }

  // 3. A slot that already has a run is not work: one still going must not take a place in the queue
  //    from a row that has not started (every minute's tick would otherwise re-pick the same rows),
  //    and one that finished but was never stamped is stamped now so the row moves on.
  if (candidates.length > 0) {
    const claimed = await claimedSlots(input.db, candidates, now);
    const open: Candidate[] = [];
    for (const c of candidates) {
      const status = claimed.get(`${c.tenantId}|${c.id}|${c.firstSlot.toISOString()}`);
      if (status === undefined) open.push(c);
      else if (status === "queued" || status === "running") summary.alreadyClaimed.push(`${c.id}:${c.firstSlot.toISOString()}`);
      else {
        summary.alreadyClaimed.push(`${c.id}:${c.firstSlot.toISOString()}`);
        await stampSlot(input.db, { id: c.id, tenant_id: c.tenantId }, c.firstSlot, now);
      }
    }
    candidates = open;
  }

  // 4. Oldest due slot first (rows due at the same minute: the one that has waited longest since it last ran),
  //    a bounded number of rows per tick.
  candidates.sort((a, b) => a.firstSlot.getTime() - b.firstSlot.getTime() || a.baseMs - b.baseMs || a.id.localeCompare(b.id));
  const work = candidates.slice(0, dueLimit);
  for (const c of candidates.slice(dueLimit)) summary.deferred.push(`${c.id}:more_rows`);

  let runsBegun = 0;
  let missedWritten = 0;
  let cursor = 0;
  const elapsed = () => Date.now() - startedAt;

  const worker = async (): Promise<void> => {
    while (cursor < work.length) {
      const candidate = work[cursor++];
      // Re-read the row now: it may have been paused, edited (which pauses it) or deleted since the scan,
      // and a run must carry the payload as it stands, not as it stood a few minutes ago.
      const fresh = rowsOf(await input.db.execute({
        sql: `SELECT ${COLUMNS} FROM tenant_cron_jobs
              WHERE id = ? AND tenant_id = ? AND action_type = 'department_task' AND enabled = 1`,
        args: [candidate.id, candidate.tenantId],
      }))[0];
      if (!fresh) {
        summary.skipped.push(candidate.id);
        continue;
      }
      const plan = planOf(fresh.action_payload);
      if (!plan) {
        summary.invalid.push(fresh.id);
        console.error("[guided.dispatch.invalid]", { tenantId: fresh.tenant_id, automationId: fresh.id, code: "schedule_invalid" });
        continue;
      }
      const capMs = capSecOf(fresh.action_payload) * 1_000;
      const slots = dueSlots(fresh, plan, now);
      for (const slot of slots) {
        const tag = `${fresh.id}:${slot.toISOString()}`;
        try {
          if (elapsed() >= budgetMs) {
            summary.deferred.push(tag);
            break;
          }
          if (now.getTime() - slot.getTime() > MISS_GRACE_MS) {
            if (missedWritten >= MISSED_PER_TICK) {
              summary.deferred.push(tag);
              break;
            }
            missedWritten += 1;
            const missed = await deps.recordMissed({ db: input.db, row: fresh, scheduledFor: slot, now });
            if (missed.created) summary.missed.push(missed.runId);
          } else {
            // A run starts only if it can finish inside the tick: its own limit plus the reserve.
            if (runsBegun >= runsPerTick || elapsed() + capMs + RUN_RESERVE_MS > budgetMs) {
              summary.deferred.push(tag);
              break;
            }
            runsBegun += 1;
            const run = await deps.run({ db: input.db, row: fresh, mode: "live", scheduledFor: slot, now });
            if (run.status === "already_claimed") {
              runsBegun -= 1;
              summary.alreadyClaimed.push(run.runId || tag);
            } else {
              summary.started.push(run.runId);
              if (run.status === "failed") summary.failed.push(run.runId);
            }
          }
          await stampSlot(input.db, fresh, slot, now);
        } catch (error) {
          if (error instanceof GuidedPreflightUnavailable) {
            // Nothing was queued and the slot is not stamped: the next minute tries again until the grace ends.
            runsBegun -= 1;
            summary.retrying.push(tag);
            console.error("[guided.dispatch.retrying]", { tenantId: fresh.tenant_id, automationId: fresh.id, scheduledFor: slot.toISOString(), stage: error.stage });
          } else {
            summary.failed.push(tag);
            console.error("[guided.dispatch.failed]", {
              tenantId: fresh.tenant_id,
              automationId: fresh.id,
              scheduledFor: slot.toISOString(),
              code: error instanceof Error ? error.name : "unknown",
            });
          }
          break;
        }
      }
      if (slots.length === SLOT_LIMIT && slots[SLOT_LIMIT - 1].getTime() <= now.getTime()) {
        summary.deferred.push(`${fresh.id}:more_slots`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(input.concurrency ?? CONCURRENCY, CONCURRENCY)) }, worker));
  return summary;
}
