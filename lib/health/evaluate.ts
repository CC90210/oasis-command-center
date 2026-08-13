/**
 * lib/health/evaluate.ts — observers + the scan runner.
 *
 * Request lifecycle for one scan tick:
 *
 *   cron (Vercel, authed) -> syncRegistry() -> loadChecks()
 *     -> for each check, in a bounded-concurrency pool:
 *          observe()  -> raw components (never throws)
 *          baseline() -> trailing 14d median of outcome_value
 *          scoreObservation() -> score + status + breakdown  [pure]
 *          persist sample + upsert status rollup
 *     -> evaluateAlerts(): consecutive-bad run -> ladder -> dispatcher
 *
 * DECOUPLING IS THE POINT. The brief requires that a target system's failure
 * cannot crash the monitor, so every observer is wrapped: a thrown error, a
 * missing table, or a timeout becomes `{ error }` on the observation, which
 * scores as status 'unknown' — never 'down'. "The monitor could not look" and
 * "the feature is broken" are different facts and must never page the same way.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CHECK_REGISTRY } from "./registry";
import { median, scoreObservation } from "./formula";
import { claimAlertSlot, clearCondition, conditionKey } from "./alert-backoff";
import { dispatchAlert } from "./dispatch";
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  type AlertChannel,
  type HealthStatus,
  type HealthThresholds,
  type HealthWeights,
  type Observation,
  type ResolvedCheck,
} from "./types";

/** Bad ticks in a row before a check may page. One bad tick is noise. */
const CONSECUTIVE_BAD_TO_ALERT = 2;
/** Cap concurrent observers so a scan cannot stampede the database. */
const OBSERVER_CONCURRENCY = 6;
const BASELINE_DAYS = 14;

/* ------------------------------------------------------------------ */
/* Registry sync                                                       */
/* ------------------------------------------------------------------ */

/**
 * Self-register code-defined checks.
 *
 * Writes ONLY code-owned columns. Operator edits to weights, thresholds, bands
 * and channels survive every deploy — otherwise tuning a threshold in the UI
 * would silently revert on the next push, which is the kind of thing that
 * teaches operators to stop trusting the dashboard.
 */
export async function syncRegistry(db: SupabaseClient): Promise<{ synced: number }> {
  let synced = 0;
  for (const def of CHECK_REGISTRY) {
    const { data: existing } = await db
      .from("feature_health_checks")
      .select("check_key")
      .eq("check_key", def.checkKey)
      .maybeSingle<{ check_key: string }>();

    if (existing) {
      const { error } = await db
        .from("feature_health_checks")
        .update({
          feature: def.feature,
          surface: def.surface,
          severity: def.severity,
          observer_kind: def.observerKind,
          observer_cfg: def.observerCfg,
          notes: def.notes ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("check_key", def.checkKey);
      if (!error) synced++;
      continue;
    }

    const { error } = await db.from("feature_health_checks").insert({
      check_key: def.checkKey,
      feature: def.feature,
      surface: def.surface,
      severity: def.severity,
      observer_kind: def.observerKind,
      observer_cfg: def.observerCfg,
      weights: { ...DEFAULT_WEIGHTS, ...(def.defaultWeights || {}) },
      thresholds: { ...DEFAULT_THRESHOLDS, ...(def.defaultThresholds || {}) },
      notes: def.notes ?? null,
    });
    if (!error) synced++;
  }
  return { synced };
}

type CheckRow = {
  check_key: string;
  feature: string;
  surface: string;
  severity: string;
  enabled: boolean;
  tenant_id: string | null;
  observer_kind: string;
  observer_cfg: Record<string, unknown> | null;
  weights: Partial<HealthWeights> | null;
  thresholds: Partial<HealthThresholds> | null;
  healthy_at: number;
  degraded_at: number;
  alert_channels: string[] | null;
};

export async function loadChecks(db: SupabaseClient): Promise<ResolvedCheck[]> {
  const { data, error } = await db
    .from("feature_health_checks")
    .select(
      "check_key, feature, surface, severity, enabled, tenant_id, observer_kind, observer_cfg, weights, thresholds, healthy_at, degraded_at, alert_channels",
    )
    .eq("enabled", true);

  if (error || !data) return [];

  return (data as CheckRow[]).map((r) => ({
    checkKey: r.check_key,
    feature: r.feature,
    surface: r.surface as ResolvedCheck["surface"],
    severity: r.severity as ResolvedCheck["severity"],
    enabled: r.enabled,
    tenantId: r.tenant_id,
    observerKind: r.observer_kind as ResolvedCheck["observerKind"],
    observerCfg: r.observer_cfg || {},
    // Merge over defaults so a partial jsonb edit in the UI cannot produce an
    // undefined weight and NaN its way through the scorer.
    weights: { ...DEFAULT_WEIGHTS, ...(r.weights || {}) },
    thresholds: { ...DEFAULT_THRESHOLDS, ...(r.thresholds || {}) },
    healthyAt: Number(r.healthy_at ?? 0.8),
    degradedAt: Number(r.degraded_at ?? 0.5),
    alertChannels: (r.alert_channels || []) as AlertChannel[],
  }));
}

/* ------------------------------------------------------------------ */
/* Observers                                                           */
/* ------------------------------------------------------------------ */

function cfgString(cfg: Record<string, unknown>, key: string, fallback = ""): string {
  const v = cfg[key];
  return typeof v === "string" ? v : fallback;
}
function cfgNumber(cfg: Record<string, unknown>, key: string, fallback: number): number {
  const v = Number(cfg[key]);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Identifier allowlist for anything interpolated into a PostgREST path.
 *
 * Table and column names come from operator-editable jsonb, so they are
 * untrusted input by the time they reach here. encodeURIComponent alone is
 * insufficient for PostgREST's filter grammar — charset-allowlist first.
 */
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;
function safeIdent(name: string): string | null {
  return IDENT_RE.test(name) ? name : null;
}

async function observeSqlCount(
  db: SupabaseClient,
  cfg: Record<string, unknown>,
  tenantId: string | null,
): Promise<Observation> {
  const table = safeIdent(cfgString(cfg, "table"));
  const timeColumn = safeIdent(cfgString(cfg, "timeColumn", "created_at"));
  if (!table || !timeColumn) return { error: "invalid_observer_cfg" };

  const windowMinutes = cfgNumber(cfg, "windowMinutes", 1440);
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();

  // Tenant-scoped checks MUST filter, or the service role counts every
  // tenant's rows and one tenant's score reflects another tenant's traffic
  // (Codex review 2026-08-13, P1). A table without a tenant_id column errors
  // here, which surfaces as 'unknown' — loud, and correct: declaring a check
  // tenant-scoped against an unscoped table is a config bug, not a pass.
  let q = db.from(table).select("*", { count: "exact", head: true }).gte(timeColumn, since);
  if (tenantId) q = q.eq("tenant_id", tenantId);

  const { count, error } = await q;

  if (error) return { error: `query_failed: ${error.message}`.slice(0, 200) };
  return { outcomeValue: count ?? 0 };
}

async function observeSqlRatio(
  db: SupabaseClient,
  cfg: Record<string, unknown>,
  tenantId: string | null,
): Promise<Observation> {
  const table = safeIdent(cfgString(cfg, "table"));
  const timeColumn = safeIdent(cfgString(cfg, "timeColumn", "created_at"));
  if (!table || !timeColumn) return { error: "invalid_observer_cfg" };

  const windowMinutes = cfgNumber(cfg, "windowMinutes", 1440);
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const filter = (cfg.errorFilter || {}) as {
    column?: string;
    operator?: string;
    value?: unknown;
  };
  const column = safeIdent(String(filter.column || ""));
  if (!column) return { error: "invalid_error_filter" };

  // Same tenant-isolation rule as observeSqlCount: scoped checks filter, and
  // BOTH the numerator and denominator get the filter or the ratio is
  // cross-tenant garbage.
  let totalQuery = db.from(table).select("*", { count: "exact", head: true }).gte(timeColumn, since);
  if (tenantId) totalQuery = totalQuery.eq("tenant_id", tenantId);

  const total = await totalQuery;
  if (total.error) return { error: `query_failed: ${total.error.message}`.slice(0, 200) };

  let errQuery = db.from(table).select("*", { count: "exact", head: true }).gte(timeColumn, since);
  if (tenantId) errQuery = errQuery.eq("tenant_id", tenantId);
  errQuery =
    filter.operator === "in" && Array.isArray(filter.value)
      ? errQuery.in(column, filter.value as string[])
      : errQuery.eq(column, filter.value as string);

  const errs = await errQuery;
  if (errs.error) return { error: `query_failed: ${errs.error.message}`.slice(0, 200) };

  const denom = total.count ?? 0;
  // No traffic means no error RATE exists. Reporting 0 would claim a clean bill
  // of health for a feature that did nothing; leaving it unreported lets the
  // volume check speak instead.
  if (denom === 0) return {};
  return { errorRate: (errs.count ?? 0) / denom, outcomeValue: denom };
}

async function observeFreshness(
  db: SupabaseClient,
  cfg: Record<string, unknown>,
  thresholds: HealthThresholds,
  tenantId: string | null,
): Promise<Observation> {
  const table = safeIdent(cfgString(cfg, "table"));
  const timeColumn = safeIdent(cfgString(cfg, "timeColumn", "updated_at"));
  if (!table || !timeColumn) return { error: "invalid_observer_cfg" };

  let q = db.from(table).select(timeColumn).order(timeColumn, { ascending: false }).limit(1);
  if (tenantId) q = q.eq("tenant_id", tenantId);

  const { data, error } = await q.maybeSingle<Record<string, string>>();

  if (error) return { error: `query_failed: ${error.message}`.slice(0, 200) };
  const newest = data?.[timeColumn];
  if (!newest) return { uptime: 0, outcomeValue: 0 };

  const ageMin = (Date.now() - new Date(newest).getTime()) / 60_000;
  const staleAfter = thresholds.stale_after_min ?? 180;
  // Linear decay across the staleness window rather than a cliff, so the
  // dashboard shows a job drifting late before it is declared dead.
  const uptime = ageMin <= staleAfter ? 1 : Math.max(0, 1 - (ageMin - staleAfter) / staleAfter);
  return { uptime, latencyP95Ms: Math.round(ageMin * 60_000) };
}

async function observeHttpProbe(cfg: Record<string, unknown>): Promise<Observation> {
  const path = cfgString(cfg, "path", "/api/health");
  const timeoutMs = cfgNumber(cfg, "timeoutMs", 8000);
  const base =
    process.env.HEALTH_PROBE_BASE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3100");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${base}${path}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    const durationMs = Date.now() - started;
    return { uptime: res.ok ? 1 : 0, latencyP95Ms: durationMs, durationMs };
  } catch (err) {
    // A probe timeout IS a real down signal (unlike a query error), because the
    // probe measures reachability directly.
    return {
      uptime: 0,
      latencyP95Ms: Date.now() - started,
      durationMs: Date.now() - started,
      ...(err instanceof Error && err.name === "AbortError" ? {} : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one check's observer. NEVER throws and never hangs the scan.
 *
 * This wrapper is the decoupling requirement made concrete: whatever the target
 * system does — throw, hang, return garbage — the monitor records a fact and
 * moves on.
 */
export async function observe(db: SupabaseClient, check: ResolvedCheck): Promise<Observation> {
  const started = Date.now();
  try {
    let obs: Observation;
    switch (check.observerKind) {
      case "sql_count":
        obs = await observeSqlCount(db, check.observerCfg, check.tenantId);
        break;
      case "sql_ratio":
        obs = await observeSqlRatio(db, check.observerCfg, check.tenantId);
        break;
      case "freshness":
        obs = await observeFreshness(db, check.observerCfg, check.thresholds, check.tenantId);
        break;
      case "http_probe":
        obs = await observeHttpProbe(check.observerCfg);
        break;
      default:
        obs = { error: `unsupported_observer: ${check.observerKind}` };
    }
    return { ...obs, durationMs: obs.durationMs ?? Date.now() - started };
  } catch (err) {
    return {
      error: (err instanceof Error ? err.message : "observer_threw").slice(0, 200),
      durationMs: Date.now() - started,
    };
  }
}

/** Trailing median of outcome_value, used as the baseline-relative reference. */
export async function baselineMedian(
  db: SupabaseClient,
  checkKey: string,
): Promise<number | undefined> {
  const since = new Date(Date.now() - BASELINE_DAYS * 24 * 60 * 60_000).toISOString();
  const { data, error } = await db
    .from("feature_health_samples")
    .select("outcome_value")
    .eq("check_key", checkKey)
    .gte("observed_at", since)
    .not("outcome_value", "is", null)
    .limit(2000);
  if (error || !data) return undefined;
  return median((data as { outcome_value: number }[]).map((r) => Number(r.outcome_value)));
}

/* ------------------------------------------------------------------ */
/* Scan                                                                */
/* ------------------------------------------------------------------ */

export type CheckOutcome = {
  checkKey: string;
  feature: string;
  severity: string;
  score: number;
  status: HealthStatus;
  consecutiveBad: number;
  error?: string;
};

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runScan(
  db: SupabaseClient,
  opts: { write?: boolean; now?: Date } = {},
): Promise<{
  outcomes: CheckOutcome[];
  alerted: string[];
  cleared: string[];
  /**
   * Persistence failures during the scan (sample insert / status upsert).
   * Non-empty means the dashboard may be serving STALE status rows — the
   * caller must NOT advance the scan heartbeat, or "monitoring is current"
   * becomes a lie layered over old data (Codex review 2026-08-13, P1).
   */
  persistFailures: string[];
}> {
  const now = opts.now ?? new Date();
  const write = opts.write !== false;
  const checks = await loadChecks(db);
  const persistFailures: string[] = [];

  const outcomes = await pool(checks, OBSERVER_CONCURRENCY, async (check) => {
    const obs = await observe(db, check);
    const outcomeMedian =
      obs.outcomeValue != null ? await baselineMedian(db, check.checkKey) : undefined;

    const result = scoreObservation({ ...obs, outcomeMedian }, check.weights, check.thresholds, {
      healthyAt: check.healthyAt,
      degradedAt: check.degradedAt,
    });

    let consecutiveBad = 0;
    if (write) {
      const sampleWrite = await db.from("feature_health_samples").insert({
        check_key: check.checkKey,
        observed_at: now.toISOString(),
        uptime: obs.uptime ?? null,
        error_rate: obs.errorRate ?? null,
        latency_p95_ms: obs.latencyP95Ms ?? null,
        outcome_value: obs.outcomeValue ?? null,
        outcome_median: outcomeMedian ?? null,
        score: result.score,
        status: result.status,
        breakdown: result.breakdown,
        error: obs.error ?? null,
        duration_ms: obs.durationMs ?? null,
      });
      if (sampleWrite.error) {
        persistFailures.push(`${check.checkKey}: sample_insert: ${sampleWrite.error.message}`);
      }

      const { data: prev, error: prevErr } = await db
        .from("feature_health_status")
        .select("consecutive_bad, consecutive_ok")
        .eq("check_key", check.checkKey)
        .maybeSingle<{ consecutive_bad: number; consecutive_ok: number }>();
      if (prevErr) {
        // A failed streak read silently resets consecutive counters, which can
        // delay or double an alert — record it as a persistence failure too.
        persistFailures.push(`${check.checkKey}: status_read: ${prevErr.message}`);
      }

      const isBad = result.status === "down" || result.status === "degraded";
      // 'unknown' breaks neither streak: the monitor failed to look, which is
      // not evidence either way about the feature.
      const isUnknown = result.status === "unknown";
      consecutiveBad = isUnknown
        ? (prev?.consecutive_bad ?? 0)
        : isBad
          ? (prev?.consecutive_bad ?? 0) + 1
          : 0;
      const consecutiveOk = isUnknown
        ? (prev?.consecutive_ok ?? 0)
        : isBad
          ? 0
          : (prev?.consecutive_ok ?? 0) + 1;

      const statusWrite = await db.from("feature_health_status").upsert(
        {
          check_key: check.checkKey,
          score: result.score,
          status: result.status,
          breakdown: result.breakdown,
          error: obs.error ?? null,
          consecutive_bad: consecutiveBad,
          consecutive_ok: consecutiveOk,
          last_ok_at: !isBad && !isUnknown ? now.toISOString() : undefined,
          last_bad_at: isBad ? now.toISOString() : undefined,
          observed_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
        { onConflict: "check_key" },
      );
      if (statusWrite.error) {
        persistFailures.push(`${check.checkKey}: status_upsert: ${statusWrite.error.message}`);
      }
    }

    return {
      checkKey: check.checkKey,
      feature: check.feature,
      severity: check.severity,
      score: result.score,
      status: result.status,
      consecutiveBad,
      error: obs.error,
      _check: check,
    };
  });

  const alerted: string[] = [];
  const cleared: string[] = [];

  if (write) {
    for (const o of outcomes) {
      const check = (o as CheckOutcome & { _check: ResolvedCheck })._check;
      // Key on the CONDITION. The rendered text below carries a score and a
      // timestamp; if that text were the key nothing would ever dedup.
      const key = conditionKey("feature_health", `${o.status === "down" ? "down" : "degraded"}`, o.checkKey);
      const healthyKey = conditionKey("feature_health", "down", o.checkKey);
      const degradedKey = conditionKey("feature_health", "degraded", o.checkKey);

      const isBad = o.status === "down" || o.status === "degraded";

      if (isBad && o.consecutiveBad >= CONSECUTIVE_BAD_TO_ALERT) {
        const text =
          `${o.feature} (${o.checkKey}) is ${o.status.toUpperCase()} — ` +
          `score ${(o.score * 100).toFixed(0)}%, ${o.consecutiveBad} bad ticks in a row.`;
        const slot = await claimAlertSlot(db, key, {
          component: "feature_health",
          scope: o.checkKey,
          text,
        });
        if (slot.notify) {
          await dispatchAlert(db, {
            conditionKey: key,
            rung: slot.rung,
            title: `${o.feature}: ${o.status}`,
            body: text,
            severity: o.severity,
            channels: check.alertChannels.length ? check.alertChannels : undefined,
            tenantId: check.tenantId,
          });
          alerted.push(key);
        }
      } else if (!isBad && o.status !== "unknown") {
        // CLEAR ON RECOVERY, both conditions. Skipping this is the classic bug:
        // a flapping check recovers once, keeps its daily rung, and the next
        // real breach stays silent for 24h.
        await clearCondition(db, healthyKey, now);
        await clearCondition(db, degradedKey, now);
        cleared.push(o.checkKey);
      }
    }
  }

  return {
    outcomes: outcomes.map(({ ...o }) => {
      delete (o as Record<string, unknown>)._check;
      return o as CheckOutcome;
    }),
    alerted,
    cleared,
    persistFailures,
  };
}
