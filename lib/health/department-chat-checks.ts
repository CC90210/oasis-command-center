/**
 * lib/health/department-chat-checks.ts — are the department chats still
 * ANSWERING?
 *
 * WHY. On 2026-10-09 all six department chats (Chief of Staff, Sales,
 * Marketing, Client Success, Finance, Operations) were broken for hours: empty
 * replies, a stale "model not found", a CRLF stream bug. Nothing alerted. CC
 * found it by opening the chat. The outcome-check framework already runs every
 * 15 minutes and pages Telegram with dedupe, but it never looked at department
 * chat — and every model call already leaves the evidence behind: one
 * ai_usage_events row per call (lib/ai/usage.ts), with the outcome, the error
 * code, the tokens the model produced, and why it fell back.
 *
 * TWO CHECKS, per workspace that has department turns:
 *
 *   department_chat_outcomes (failing)  a department's most recent turn
 *     failed, or at least half of the window's turns did.
 *   department_chat_fallback (warning)  turns were answered by a fallback
 *     rather than what was chosen. The chat works; the choice is not honoured.
 *
 * WHAT COUNTS AS A FAILED TURN. Not only outcome != 'ok'. An 'ok' row with
 * output_tokens = 0 is an EMPTY SUCCESS: the provider answered 200 and the
 * model said nothing, which is exactly what the 2026-10-09 outage looked like
 * from the ledger. NULL output_tokens is not zero — a provider that reports no
 * usage (a local model, a paired computer) is unknown, never a failure.
 *
 * WHAT IS NOT GRADED. 'pending' (still in flight, no end yet) and 'cancelled'
 * (the person pressed Stop or left the page) are not failures of the chat.
 * 'expired' IS one: the call began and its end was never recorded.
 *
 * NO DATA IS NOT HEALTH, AND NOT AN ALERT. The verdict vocabulary has no
 * "unknown" (ok / degraded / failing / check_broken), and a workspace nobody
 * chatted in for six hours has not broken. So no graded turns is `ok` whose
 * reason says in words that nothing was graded; it carries no number that
 * looks like a reading. A READ that fails is the opposite: check_broken with
 * the reason, never ok (checks-core evaluate: an errored check is not a pass).
 *
 * WINDOW. 6 hours, ending at the run time. Rule (b) therefore keeps a past
 * burst of failures visible for up to 6 h after a fix, until healthy turns
 * outnumber it; the alert says whether each department is answering again.
 *
 * RUNNING. These are not in OASIS_GLOBAL_CHECKS: that list runs under one
 * tenant, and each workspace must be graded on its own turns (own
 * health_alert_state ladder, own health_check_runs). The cron route runs
 * DEPARTMENT_CHAT_CHECKS once per tenant returned by departmentChatTenantIds,
 * and pages only the workspaces whose alerts belong in OASIS's operator chat
 * (see the route); the rest are recorded, not paged.
 */

import "server-only";
import { ENGINE_SETTINGS_HREF } from "@/lib/ai/agent-engine";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { getTursoClient } from "@/lib/turso";
import { isRetiredTenant } from "@/lib/tenant/retired";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";
import type { DripCheck } from "./drip-checks";

type Db = Parameters<DripCheck["observe"]>[0];

/** How far back a turn still counts. */
export const DEPARTMENT_CHAT_WINDOW_MS = 6 * 60 * 60_000;
/** Rule (b): this share of the window's turns failing is an alert... */
export const DEPARTMENT_CHAT_FAILURE_RATE = 0.5;
/** ...but only on at least this many turns; one failure in one turn is rule (a)'s job. */
export const DEPARTMENT_CHAT_MIN_TURNS_FOR_RATE = 2;
/** A busy workspace's window is bounded; newest rows are read first, so the latest turns always count. */
const READ_LIMIT = 5000;

export type DepartmentTurn = {
  occurredAt: string;
  department: string;
  outcome: string;
  errorCode: string | null;
  /** null = the provider reported none (unknown), which is NOT zero. */
  outputTokens: number | null;
  fallbackReason: string | null;
};

/** Rows whose end has not happened, or that nobody can fault the chat for. */
const UNGRADED_OUTCOMES: ReadonlySet<string> = new Set(["pending", "cancelled"]);

/** An empty success counts as a failure: see the header. */
export function isFailedTurn(t: DepartmentTurn): boolean {
  return t.outcome !== "ok" || t.outputTokens === 0;
}

function isGradedTurn(t: DepartmentTurn): boolean {
  return !UNGRADED_OUTCOMES.has(t.outcome);
}

// ── Plain words ─────────────────────────────────────────────────────────────

const HTTP_STATUS_WORDS: Record<number, string> = {
  400: "the AI provider rejected the request",
  401: "the AI key was refused",
  402: "the AI account is out of credits",
  403: "the AI key is not allowed to do this",
  404: "the AI model was not found",
  429: "the AI account is rate-limited or out of quota",
};

const CODE_WORDS: Record<string, string> = {
  empty_reply_empty: "the model sent back an empty reply",
  empty_body: "the model sent back an empty reply",
  empty_reply_thinking: "the model spent its whole answer budget thinking and sent no answer",
  empty_reply_blocked: "the provider's safety filter blocked the reply",
  stream_failed: "the reply stopped partway",
  timeout: "the call timed out",
  network: "the AI provider could not be reached",
  ai_budget_exhausted: "this month's AI budget is used",
  ai_budget_unpriced_model: "the model has no verified price under the budget",
  reservation_expired: "the call started and never finished",
  bridge_unreachable: "the paired computer could not be reached",
  cli_failed: "the AI app on the paired computer could not answer",
  provider_400_credit: "the AI account is out of credits",
};

/** One failed turn in words the owner can act on, with the raw code kept for whoever debugs it. */
export function plainFailure(t: DepartmentTurn): string {
  if (t.outcome === "ok") return "the model answered ok but sent no text (an empty reply)";
  const code = t.errorCode;
  if (code) {
    const exact = CODE_WORDS[code];
    if (exact) return `${exact} (${code})`;
    const status = /^(?:http|provider)_(\d{3})$/.exec(code);
    if (status) {
      const n = Number(status[1]);
      const words = HTTP_STATUS_WORDS[n] ?? (n >= 500 ? "the AI provider is down" : "the AI provider rejected the request");
      return `${words} (${code})`;
    }
    return `an error this monitor has no wording for (${code})`;
  }
  if (t.outcome === "timeout") return "the call timed out (no error code recorded)";
  if (t.outcome === "refused") return "the call was refused (no error code recorded)";
  if (t.outcome === "expired") return "the call started and never finished (no error code recorded)";
  return `the call ended as "${t.outcome}" and recorded no error code`;
}

const FALLBACK_WHY: Record<string, string> = {
  retired: "retired",
  access_limited: "not available to this AI account",
  expired: "expired",
};

/** A fallback_reason ("model_retired:<id>") in words. Unknown shapes are shown, not hidden. */
export function plainFallback(reason: string): string {
  const m = /^model_([a-z_]+):(.+)$/.exec(reason);
  if (m) return `the chosen model ${m[2]} is ${FALLBACK_WHY[m[1]] ?? m[1].replace(/_/g, " ")} (${reason})`;
  return `a fallback this monitor has no wording for (${reason})`;
}

// ── Grading (pure) ──────────────────────────────────────────────────────────

function departmentLabel(key: string): string {
  return OS_DEPARTMENTS.find((d) => d.key === key)?.label ?? key;
}

function fmtWhen(iso: string, nowMs: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const hhmm = new Date(ms).toISOString().slice(11, 16);
  const mins = Math.max(0, Math.round((nowMs - ms) / 60_000));
  const ago = mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
  return `${hhmm} UTC, ${ago}`;
}

type DepartmentState = {
  department: string;
  latest: DepartmentTurn;
  latestFailed: boolean;
  failures: DepartmentTurn[];
  lastGood: DepartmentTurn | null;
};

export type DepartmentChatReading = {
  graded: number;
  failed: number;
  rateTripped: boolean;
  /** Departments to name in the alert, worst first. Empty = no alert. */
  trouble: DepartmentState[];
  /** Departments whose most recent turn failed (rule a). */
  failingNow: number;
  departments: number;
};

/** Newest first; a stable tie-break keeps two turns in the same millisecond deterministic. */
function newestFirst(turns: readonly DepartmentTurn[]): DepartmentTurn[] {
  return turns
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.occurredAt < b.t.occurredAt ? 1 : a.t.occurredAt > b.t.occurredAt ? -1 : a.i - b.i))
    .map((x) => x.t);
}

export function gradeDepartmentTurns(allTurns: readonly DepartmentTurn[]): DepartmentChatReading {
  const graded = newestFirst(allTurns.filter(isGradedTurn));
  const states = new Map<string, DepartmentState>();
  for (const t of graded) {
    let s = states.get(t.department);
    if (!s) {
      s = { department: t.department, latest: t, latestFailed: isFailedTurn(t), failures: [], lastGood: null };
      states.set(t.department, s);
    }
    if (isFailedTurn(t)) s.failures.push(t);
    else if (!s.lastGood) s.lastGood = t;
  }
  const failed = graded.filter(isFailedTurn).length;
  const rateTripped =
    graded.length >= DEPARTMENT_CHAT_MIN_TURNS_FOR_RATE && failed / graded.length >= DEPARTMENT_CHAT_FAILURE_RATE;
  const all = [...states.values()];
  const failingNow = all.filter((s) => s.latestFailed);
  // Rule (a) names the departments failing now. Rule (b) widens it to every
  // department that failed in the window, so a burst that has since eased
  // still says who it hit and whether they answer again.
  const trouble = (rateTripped ? all.filter((s) => s.failures.length > 0) : failingNow).sort(
    (a, b) => Number(b.latestFailed) - Number(a.latestFailed) || b.failures.length - a.failures.length
      || a.department.localeCompare(b.department),
  );
  return { graded: graded.length, failed, rateTripped, trouble, failingNow: failingNow.length, departments: all.length };
}

function pct(n: number, d: number): number {
  return Math.round((n / d) * 100);
}

function troubleLine(s: DepartmentState, nowMs: number): string {
  const good = s.lastGood
    ? `last good turn ${fmtWhen(s.lastGood.occurredAt, nowMs)}`
    : "no good turn in the last 6 h";
  if (s.latestFailed) {
    return `- ${departmentLabel(s.department)}: failing now, ${plainFailure(s.latest)}; ${good}`;
  }
  const worst = s.failures[0];
  return (
    `- ${departmentLabel(s.department)}: answering again after ${s.failures.length} failed turn(s) ` +
    `(latest: ${plainFailure(worst)}); ${good}`
  );
}

/** The alert/history text for department_chat_outcomes. Pure: the same reading always says the same thing. */
export function outcomesReason(reading: DepartmentChatReading, nowMs: number, workspace: string | null): string {
  const names = reading.trouble.map((s) => departmentLabel(s.department)).join(", ");
  return [
    `${workspace ? `${workspace}: ` : ""}department chat is broken for ${names}.`,
    `Last 6 h: ${reading.failed} of ${reading.graded} turns failed (${pct(reading.failed, reading.graded)}%).`,
    ...reading.trouble.map((s) => troubleLine(s, nowMs)),
  ].join("\n");
}

function countsByDepartment(turns: readonly DepartmentTurn[]): string {
  const counts = new Map<string, number>();
  for (const t of turns) counts.set(t.department, (counts.get(t.department) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([d, n]) => `${departmentLabel(d)} (${n})`)
    .join(", ");
}

/** The alert/history text for department_chat_fallback. */
export function fallbackReason(
  fallbackTurns: readonly DepartmentTurn[],
  totalTurns: number,
  nowMs: number,
  workspace: string | null,
): string {
  const newest = newestFirst(fallbackTurns);
  const why = [...new Set(newest.map((t) => plainFallback(t.fallbackReason ?? "")))].slice(0, 3);
  return [
    `${workspace ? `${workspace}: ` : ""}${fallbackTurns.length} of ${totalTurns} department chat turns in the last 6 h ` +
      `were answered by a fallback, not what was chosen: ${countsByDepartment(fallbackTurns)}.`,
    ...why.map((w) => `- ${w}`),
    `Latest ${fmtWhen(newest[0].occurredAt, nowMs)}.`,
  ].join("\n");
}

// ── I/O ─────────────────────────────────────────────────────────────────────

type TurnRow = {
  occurred_at: string;
  department_key: string;
  outcome: string;
  error_code: string | null;
  output_tokens: number | string | null;
  fallback_reason: string | null;
};

type TurnRead = { ok: true; turns: DepartmentTurn[] } | { ok: false; error: string };

/** One tenant's department turns in the window. Never throws: a failed read is a value the check turns into check_broken. */
async function readDepartmentTurns(db: Db, tenantId: string, endMs: number): Promise<TurnRead> {
  try {
    const r = await db
      .from("ai_usage_events")
      .select("occurred_at, department_key, outcome, error_code, output_tokens, fallback_reason")
      .eq("tenant_id", tenantId)
      .not("department_key", "is", null)
      .gte("occurred_at", new Date(endMs - DEPARTMENT_CHAT_WINDOW_MS).toISOString())
      .lt("occurred_at", new Date(endMs).toISOString())
      .order("occurred_at", { ascending: false })
      .limit(READ_LIMIT);
    if (r.error) return { ok: false, error: r.error.message || String(r.error) };
    const turns = ((r.data ?? []) as TurnRow[])
      .filter((row) => typeof row.department_key === "string" && row.department_key !== "")
      .map((row) => ({
        occurredAt: row.occurred_at,
        department: row.department_key,
        outcome: row.outcome,
        errorCode: row.error_code ?? null,
        // libSQL over HTTP can return integers as strings (a number-typed
        // column would otherwise read "0" as truthy-and-nonzero).
        outputTokens: row.output_tokens === null || row.output_tokens === undefined ? null : Number(row.output_tokens),
        fallbackReason: row.fallback_reason ?? null,
      }));
    return { ok: true, turns };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** "" for OASIS's own workspace; a client workspace is named so the page says whose chat broke. Best effort: a failed lookup never changes a verdict. */
async function workspaceLabel(db: Db, tenantId: string): Promise<string | null> {
  if (tenantId === WEBDEV_TENANT_ID) return null;
  try {
    const r = await db.from("tenants").select("name").eq("id", tenantId).maybeSingle();
    const name = (r.data as { name?: string | null } | null)?.name;
    return name ? `${name} (${tenantId.slice(0, 8)})` : `workspace ${tenantId.slice(0, 8)}`;
  } catch {
    return `workspace ${tenantId.slice(0, 8)}`;
  }
}

function readFailed(table: string, error: string): { observed: null; reason: string } {
  return {
    observed: null,
    reason: `could not read ${table}, so department chat is NOT being watched: ${error}`.slice(0, 400),
  };
}

const NO_TURNS = "no department chat turns in the last 6 h, so there is nothing to grade (this is not a health reading)";
const NO_FINISHED_TURNS =
  "no finished department chat turns in the last 6 h (none, or only ones still in flight or cancelled), so there is nothing to grade (this is not a health reading)";

function chatLink(): string {
  const base = (process.env.PUBLIC_APP_URL || "https://oasisai.work").replace(/\/+$/, "");
  return `${base}${ENGINE_SETTINGS_HREF}`;
}

export const DEPARTMENT_CHAT_CHECKS: DripCheck[] = [
  {
    id: "department_chat_outcomes",
    severity: "critical",
    // CC's lane (OASIS's own workspace; the route does not page the others).
    // Adon's lane is SunBiz ops, which is retired.
    lane: "operator",
    rule: { kind: "must_be_zero" },
    observe: async (db, tenantId, endMs) => (await outcomesObservation(db, tenantId, endMs)).observed,
    observeDetailed: (db, tenantId, endMs) => outcomesObservation(db, tenantId, endMs),
    describe: (r) =>
      r.verdict === "check_broken"
        ? r.reason
        : `${r.reason}\nCheck the AI engine: ${chatLink()}`,
  },
  {
    id: "department_chat_fallback",
    severity: "medium",
    lane: "operator",
    // A warning, not an outage: the chat is answering, just not on the engine
    // that was picked.
    rule: { kind: "warn_above_zero" },
    observe: async (db, tenantId, endMs) => (await fallbackObservation(db, tenantId, endMs)).observed,
    observeDetailed: (db, tenantId, endMs) => fallbackObservation(db, tenantId, endMs),
    describe: (r) =>
      r.verdict === "check_broken"
        ? r.reason
        : `${r.reason}\nThe engine you chose is not what is answering. Check it: ${chatLink()}`,
  },
];

async function outcomesObservation(
  db: Db,
  tenantId: string,
  endMs: number,
): Promise<{ observed: number | null; reason: string }> {
  const read = await readDepartmentTurns(db, tenantId, endMs);
  if (!read.ok) return readFailed("ai_usage_events", read.error);
  const reading = gradeDepartmentTurns(read.turns);
  if (reading.graded === 0) return { observed: 0, reason: read.turns.length === 0 ? NO_TURNS : NO_FINISHED_TURNS };
  if (reading.trouble.length === 0) {
    return {
      observed: 0,
      reason:
        `${reading.graded} department chat turn(s) across ${reading.departments} department(s) in the last 6 h; ` +
        `${reading.failed} failed; the latest turn of every department was healthy`,
    };
  }
  return {
    // Departments to name; the rate rule alone still counts as at least one.
    observed: Math.max(reading.failingNow, 1),
    reason: outcomesReason(reading, endMs, await workspaceLabel(db, tenantId)),
  };
}

async function fallbackObservation(
  db: Db,
  tenantId: string,
  endMs: number,
): Promise<{ observed: number | null; reason: string }> {
  const read = await readDepartmentTurns(db, tenantId, endMs);
  if (!read.ok) return readFailed("ai_usage_events", read.error);
  // Every row counts here, ungraded ones included: a cancelled turn that was
  // sent to a fallback still shows the fallback is happening.
  if (read.turns.length === 0) return { observed: 0, reason: NO_TURNS };
  const swapped = read.turns.filter((t) => t.fallbackReason !== null && t.fallbackReason !== "");
  if (swapped.length === 0) {
    return { observed: 0, reason: `${read.turns.length} department chat turn(s) in the last 6 h, none answered by a fallback` };
  }
  return {
    observed: swapped.length,
    reason: fallbackReason(swapped, read.turns.length, endMs, await workspaceLabel(db, tenantId)),
  };
}

/**
 * Every workspace that had a department turn in the window, plus OASIS, which
 * is always graded (its chats are the ones CC uses; a quiet OASIS reads as
 * "nothing to grade", and an unreadable ledger reads as check_broken).
 *
 * A failed discovery read returns just OASIS and says so via `error`: the
 * OASIS run reads the same table, so a ledger that is down surfaces there as
 * check_broken; the caller logs `error` for the narrower case where only this
 * query failed.
 */
export async function departmentChatTenantIds(
  nowMs: number = Date.now(),
): Promise<{ tenantIds: string[]; error: string | null }> {
  try {
    const r = await getTursoClient().execute({
      sql:
        `SELECT DISTINCT tenant_id FROM ai_usage_events ` +
        `WHERE department_key IS NOT NULL AND occurred_at >= ? AND occurred_at < ?`,
      args: [new Date(nowMs - DEPARTMENT_CHAT_WINDOW_MS).toISOString(), new Date(nowMs).toISOString()],
    });
    const found = r.rows.map((row) => String(row.tenant_id)).filter((id) => id && !isRetiredTenant(id));
    return { tenantIds: [...new Set([WEBDEV_TENANT_ID, ...found])], error: null };
  } catch (err) {
    return { tenantIds: [WEBDEV_TENANT_ID], error: err instanceof Error ? err.message : String(err) };
  }
}
