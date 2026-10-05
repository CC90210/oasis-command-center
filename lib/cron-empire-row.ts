/**
 * Empire cron_jobs row → the UI's CronJob shape.
 *
 * Extracted from app/api/cron-jobs/route.ts so it can be TESTED. It had none,
 * and it is where the Automations tab died for weeks with
 * "b.toUpperCase is not a function".
 *
 * THE BUG THIS FILE EXISTS TO PREVENT. The old code read:
 *
 *     const lastResult = row.last_result || "";
 *     const upper = lastResult.toUpperCase();
 *
 * which is correct against Postgres, where a text column returns text. Against
 * Turso it is not. lib/turso-postgrest.ts fromSql (:129-135) JSON-parses any
 * TEXT value that starts with `{` or `[`, so a last_result holding JSON arrives
 * as an OBJECT or ARRAY. `|| ""` only rejects falsy values, and `{}` and `[]`
 * are both truthy — so the wrong-typed value reached .toUpperCase() and threw.
 *
 * Four live jobs store JSON there (Inbound Email Sweep, Event Bus Offline
 * Drain, Review Harvest, Booking Reminders — the last one stores a bare `[]`).
 * Inbound Email Sweep runs every five minutes, which is why the board broke
 * constantly rather than occasionally.
 *
 * The rule for anything crossing the shim: never call a string method on a
 * value the database handed you without coercing it first. The TypeScript
 * annotation says `string | null`; the runtime disagrees, and the runtime wins.
 */

import { coerceInferResultText } from "./infer-result-text";

/** Shape as DECLARED. Field types are aspirational — see the note above. */
export type EmpireCronRow = {
  id: string;
  name: string;
  description: string | null;
  schedule: string;
  action_type: string | null;
  action_config: Record<string, unknown> | null;
  owner_agent_key?: string | null;
  is_active: boolean;
  last_run_at: string | null;
  last_result: string | null;
  next_run_at: string | null;
  run_count: number | null;
  fail_count: number | null;
  created_at: string;
};

/** Any value → string, without assuming the database kept its word. */
function asText(v: unknown): string {
  return coerceInferResultText(v);
}

/**
 * INTEGER → boolean. The Postgres→SQLite transpiler collapsed booleans into
 * INTEGER and fromSql never restores them, so `is_active` arrives as 0 or 1
 * while every consumer's type says boolean. `!job.enabled` on the number 0 is
 * accidentally right; on any other shape it is quietly wrong, and the toggle
 * is the whole point of this screen.
 */
export function asBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "t" || s === "1";
  }
  return false;
}

function asCount(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Infer the owning agent from the job name for UI grouping. Tenant scoping is
 * done by the query's tenant_id filter, never by this function.
 */
/**
 * Content and brand work belongs to Maven (CMO), whatever the job is called.
 *
 * The prefix rules below only catch a job NAMED after its agent, and the
 * empire's content jobs are not: "Marketing Publish Drain", "Post Analytics
 * Sync", "Library Post Linker" and "Training Corpus Ingest" are all Maven's by
 * their own descriptions — they drive CMO-Agent's send_gateway, pull per-post
 * platform metrics, link founders Library assets to what actually published,
 * and write style exemplars into CMO-Agent/brain/exemplars/. All four were
 * filing under Bravo, so the board credited the CEO lane with the CMO's work
 * and CC could not see his marketing automation as a group.
 *
 * Matched on distinctive domain words rather than a name list, so a new content
 * job does not silently land in the wrong lane the day someone adds it.
 */
const MAVEN_MARKERS = [
  "marketing",
  "carousel media retention",
  "post analytics",
  "library post",
  "training corpus",
  "publish drain",
  "content",
  "caption",
  "exemplar",
];

export function inferEmpireAgentKey(name: unknown, actionType: unknown): string {
  const n = asText(name).toLowerCase();
  const t = asText(actionType).toLowerCase();
  if (n.startsWith("atlas") || t.startsWith("atlas_")) return "atlas";
  if (n.startsWith("maven") || t.startsWith("maven_")) return "maven";
  if (n.startsWith("aura") || n.includes("pow wow") || t.startsWith("morning_powwow")) return "aura";
  // Domain match runs AFTER the explicit agent prefixes, so an
  // "Atlas — marketing spend" job stays with Atlas rather than being
  // reassigned by a keyword in its description.
  if (MAVEN_MARKERS.some((m) => n.includes(m))) return "maven";
  return "bravo";
}

/**
 * FAILURE IS A SHAPE, NOT A PREFIX.
 *
 * This classifier used to be `upper.startsWith("ERROR") || startsWith("FAILED")`
 * and nothing else, which made the tab strictly weaker than the watchdog that
 * pages CC. scripts/core/cron_health_check.py:classify_last_result learned the
 * shapes on 2026-08-21 after eight SunBiz crons sat enabled-and-dead for fifteen
 * days; the dashboard never learned them. The gap is not academic: Inbound Email
 * Sweep runs every five minutes and writes `{"errors": 3, "sent": 0}`, which has
 * no "ERROR" anywhere in it. Python flagged that row and Telegrammed CC; the tab
 * drew it with a green tick and a neutral border. CC opened the tab to confirm
 * the alert and the tab told him the fleet was fine — which is worse than having
 * no tab, because it actively contradicts a correct page.
 *
 * Ported from the Python, detector for detector, so the two cannot drift:
 *
 *   1. A PRE-DECODED object/array, handled FIRST. lib/turso-postgrest.ts fromSql
 *      JSON-parses any TEXT starting with `{` or `[`, so `last_result` arrives
 *      here as a real object for exactly the rows this function exists to catch.
 *      The Python had this same bug and its hand-written string fixtures never
 *      saw it — only a live delivery probe did.
 *   2. The legacy ERROR/FAILED prefix, still what scheduler.run_script stamps on
 *      a non-zero exit.
 *   3. A JSON summary reporting its own errors/failures count, `ok: false`, or
 *      `status: error|failed`.
 *   4. A plain-text counter, "failed: 3". Anchored so "synced: 157 · failed: 0"
 *      reads as zero and stays green.
 *
 * An OPAQUE result is a third verdict, not a green one. script_run keeps only
 * the last stdout line, so a handler that pretty-prints JSON stores a lone "}".
 * That is not a failure — flagging it would paint three healthy jobs red — but
 * it is not evidence of health either, so it renders un-verdicted instead of
 * earning the success tick it used to get by default.
 *
 * Parity fixtures live in tests/cron-result-shape-parity.test.ts, taken verbatim
 * from scripts/tests/test_cron_health_shape_detection.py.
 */

/**
 * Keys whose non-zero value means the run reported its own failures. Read off
 * the shapes actually stored in cron_jobs.last_result, not guessed — same list
 * as the Python's _FAILURE_COUNT_KEYS.
 */
const FAILURE_COUNT_KEYS = new Set([
  "errors", "error", "error_count", "errors_count",
  "failures", "failure", "failure_count", "failures_count",
  "failed", "failed_count", "exceptions", "dead_lettered",
]);

/** `status`/`state`/`result` values that mean the run did not succeed. */
const FAILURE_STATUS_VALUES = new Set([
  "error", "errored", "failed", "failure", "fatal", "crash", "crashed",
]);

/**
 * Plain-text counters: "failed: 3", "errors = 12". The separator is required and
 * the word boundary anchored, so "no failures" prose cannot trip it and the very
 * common healthy shape "synced: 157 · failed: 0" reads as the zero it is.
 */
const TEXT_COUNT_RE = /\b(errors?|failures?|failed)\s*[:=]\s*(\d+)\b/gi;

/** The stored tails that carry no verdict either way. */
const OPAQUE_RESULTS = new Set(["}", "]", "})", "}]"]);

/**
 * How many failures does this JSON value represent? Null = not a counter at all.
 *
 * `{"errors": 2}` is 2. `{"errors": []}` is 0 and `{"errors": ["boom"]}` is 1 —
 * a list of errors is a count of errors. `{"error": "timeout"}` is 1, because a
 * populated error string is a failure even though it carries no number, while
 * `{"error": null}` and `{"error": ""}` are 0.
 */
function coerceFailureCount(value: unknown): number | null {
  if (value === null || value === undefined || value === false) return 0;
  if (value === true) return 1;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return 0;
    if (/^\d+$/.test(s)) return Number(s);
    return ["none", "null", "0", "false", "ok"].includes(s.toLowerCase()) ? 0 : 1;
  }
  return null;
}

/**
 * Walk a decoded JSON summary for self-reported failure; returns the reason, or
 * null when the payload looks clean. Bounded at three levels because handlers
 * wrap their counts (`{"summary": {"errors": 2}}`) — unbounded recursion over
 * data we did not write is how a health check becomes the outage.
 */
function scanJsonForFailure(value: unknown, depth = 0): string | null {
  if (depth > 3) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = scanJsonForFailure(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  for (const [rawKey, entry] of Object.entries(record)) {
    const key = String(rawKey).trim().toLowerCase();
    if (key === "ok" && entry === false) return "reported ok=false";
    if ((key === "status" || key === "state" || key === "result") && typeof entry === "string") {
      if (FAILURE_STATUS_VALUES.has(entry.trim().toLowerCase())) {
        return `reported ${key}=${entry.trim()}`;
      }
    }
    if (FAILURE_COUNT_KEYS.has(key)) {
      const count = coerceFailureCount(entry);
      if (count !== null && count > 0) {
        return `reported ${key}=${typeof entry === "string" ? entry.slice(0, 60) : count}`;
      }
    }
  }

  for (const entry of Object.values(record)) {
    if (entry !== null && typeof entry === "object") {
      const hit = scanJsonForFailure(entry, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export type LastResultVerdict = {
  text: string;
  /** `unknown` means the stored tail cannot carry a verdict — never a green tick. */
  status: "success" | "error" | "unknown" | null;
  /** Why the shape scan called it a failure. Null when the text says so itself. */
  reason: string | null;
};

export function classifyLastResult(raw: unknown): LastResultVerdict {
  // The shim already decoded it. Scan the object we were handed rather than its
  // serialized form — round-tripping is what let the Python's detector pass
  // every unit test while being dead against every production row.
  if (raw !== null && typeof raw === "object") {
    const text = asText(raw);
    const hit = scanJsonForFailure(raw);
    if (hit) return { text, status: "error", reason: hit };
    return { text, status: "success", reason: null };
  }

  const text = asText(raw);
  if (!text.trim()) return { text, status: null, reason: null };

  const upper = text.toUpperCase();
  if (upper.startsWith("ERROR") || upper.startsWith("FAILED")) {
    return { text, status: "error", reason: null };
  }

  if (OPAQUE_RESULTS.has(text.trim())) {
    return { text, status: "unknown", reason: "last_result is a truncated JSON tail" };
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let decoded: unknown = undefined;
    try {
      decoded = JSON.parse(trimmed);
    } catch {
      decoded = undefined;
    }
    if (decoded !== undefined) {
      const hit = scanJsonForFailure(decoded);
      if (hit) return { text, status: "error", reason: hit };
    }
  }

  TEXT_COUNT_RE.lastIndex = 0;
  for (const match of text.matchAll(TEXT_COUNT_RE)) {
    if (Number(match[2]) > 0) return { text, status: "error", reason: `reported ${match[1]}=${match[2]}` };
  }
  return { text, status: "success", reason: null };
}

export function normalizeEmpireRow(row: EmpireCronRow) {
  const {
    text: lastResult,
    status: classifiedStatus,
    reason: failureReason,
  } = classifyLastResult(row.last_result);
  const unresolvedFailures = Math.max(0, asCount(row.fail_count));
  const status = unresolvedFailures > 0 ? "error" as const : classifiedStatus;
  const unresolvedError = unresolvedFailures > 0
    ? `${unresolvedFailures} unresolved failure${unresolvedFailures === 1 ? "" : "s"}.` +
      (lastResult ? ` Latest scheduler result: ${lastResult}` : " No later successful run has cleared the counter.")
    : null;
  // A shape-detected failure needs to say WHICH shape. `{"errors":3,"sent":0}`
  // in a red box with no explanation reads as a debugging puzzle; "reported
  // errors=3" reads as the verdict the watchdog already texted CC. The legacy
  // ERROR/FAILED prefix carries no reason because the text already is one.
  const shapeError = failureReason && status === "error"
    ? `${failureReason} — ${lastResult}`
    : lastResult;
  const storedOwner = asText(row.owner_agent_key).trim().toLowerCase();
  return {
    id: row.id,
    agent_key: storedOwner || inferEmpireAgentKey(row.name, row.action_type),
    name: asText(row.name),
    description: row.description,
    schedule: asText(row.schedule),
    action_type: row.action_type,
    action_payload: row.action_config || {},
    enabled: asBool(row.is_active),
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
    last_run_status: status,
    // `unknown` still shows its text — un-verdicted output, not a hidden row.
    // Hiding an opaque tail is how the blind spot stops being visible at all.
    last_run_output: status === "success" || status === "unknown" ? lastResult : null,
    last_run_error: unresolvedError ?? (status === "error" ? shapeError : null),
    run_count: asCount(row.run_count),
    unresolved_failures: unresolvedFailures,
    created_at: row.created_at,
    updated_at: row.created_at,
    source: "empire" as const,
  };
}

/** Normalize the SQLite-backed tenant lane to the same UI contract. */
export function normalizeTenantCronRow<T extends Record<string, unknown>>(row: T) {
  return {
    ...row,
    enabled: asBool(row.enabled),
    last_run_output: row.last_run_output == null ? null : asText(row.last_run_output),
    last_run_error: row.last_run_error == null ? null : asText(row.last_run_error),
    run_count: asCount(row.run_count),
    source: "tenant" as const,
  };
}
