/**
 * lib/health/registry.ts — the code-defined check catalogue.
 *
 * A check is a DECLARATION, not code. That is what makes the system turnkey:
 * adding coverage is adding a literal to this array, and the scanner
 * self-registers it into feature_health_checks on the next tick. No migration,
 * no per-service instrumentation, no deploy of the monitor itself.
 *
 * The 2026-08-06 post-mortem's first lesson was that a hand-maintained watch
 * list always lags the estate — nine services listed against ~40 cron routes.
 * The mitigation here is that observers query the tables a feature ALREADY
 * writes, so a feature nobody thought to instrument is still coverable, and
 * `discoverChecks()` can expand one declaration into many (per brand, per
 * sequence) from the data itself.
 *
 * Operator edits in the DB (weights, thresholds, bands, channels) are NOT
 * overwritten by this file — see syncRegistry() in evaluate.ts. Only the
 * code-owned columns (observer kind/config, feature, surface, severity) resync.
 */
// Not "server-only": a static declaration list with no I/O, kept importable so
// the catalogue can be asserted over in tests.
import type { HealthCheckDefinition } from "./types";

/**
 * Seed catalogue.
 *
 * Deliberately weighted toward OUTCOME for anything that sends, because
 * "the worker is up" was true through every outage this system exists to catch.
 * Latency is weighted 0 on batch features — a nightly job has no meaningful p95
 * and a nonzero weight there would just add noise.
 */
export const CHECK_REGISTRY: HealthCheckDefinition[] = [
  {
    checkKey: "leads.intake",
    feature: "Lead intake",
    surface: "oasis",
    severity: "critical",
    observerKind: "sql_count",
    observerCfg: { table: "leads", timeColumn: "created_at", windowMinutes: 1440 },
    defaultWeights: { uptime: 0, error_rate: 0, latency: 0, outcome: 1 },
    notes: "New leads landing at all. Zero for a day is the loudest signal in the system.",
  },
  {
    checkKey: "forms.submissions",
    feature: "Merchant forms",
    surface: "oasis",
    severity: "critical",
    observerKind: "sql_count",
    observerCfg: { table: "form_submissions", timeColumn: "created_at", windowMinutes: 1440 },
    defaultWeights: { uptime: 0, error_rate: 0, latency: 0, outcome: 1 },
    notes:
      "R2 CORS took every merchant upload down for 3.5 days in Aug 2026 while every process stayed green. This is the check that would have caught it.",
  },
  {
    checkKey: "email.outbound",
    feature: "Outbound email",
    surface: "oasis",
    severity: "critical",
    observerKind: "sql_count",
    observerCfg: { table: "email_log", timeColumn: "created_at", windowMinutes: 1440 },
    defaultWeights: { uptime: 0, error_rate: 0.3, latency: 0, outcome: 0.7 },
    notes: "Volume against its own 14d median.",
  },
  {
    checkKey: "email.delivery_failures",
    feature: "Outbound email",
    surface: "oasis",
    severity: "high",
    observerKind: "sql_ratio",
    observerCfg: {
      table: "email_log",
      timeColumn: "created_at",
      windowMinutes: 1440,
      errorFilter: { column: "status", operator: "in", value: ["failed", "bounced", "error"] },
    },
    defaultWeights: { uptime: 0, error_rate: 1, latency: 0, outcome: 0 },
    defaultThresholds: { error_rate_ceiling: 0.05 },
    notes:
      "Bounce/complaint ceiling. Distinct from volume: a feature can send plenty and fail all of it.",
  },
  {
    checkKey: "drip.enrollments",
    feature: "Follow-up drips",
    surface: "oasis",
    severity: "high",
    observerKind: "sql_count",
    observerCfg: {
      table: "followup_drip_enrollments",
      timeColumn: "created_at",
      windowMinutes: 1440,
    },
    defaultWeights: { uptime: 0, error_rate: 0, latency: 0, outcome: 1 },
    defaultThresholds: { min_absolute: 1 },
  },
  {
    checkKey: "drip.send_failures",
    feature: "Follow-up drips",
    surface: "oasis",
    severity: "critical",
    observerKind: "sql_ratio",
    observerCfg: {
      table: "followup_drip_sends",
      timeColumn: "created_at",
      windowMinutes: 1440,
      errorFilter: { column: "status", operator: "eq", value: "failed" },
    },
    defaultWeights: { uptime: 0, error_rate: 1, latency: 0, outcome: 0 },
    defaultThresholds: { error_rate_ceiling: 0.05 },
    notes:
      "The SMS engine once marked failed sends as 'sent'. Any check that trusts a self-reported success flag inherits that lie — prefer provider status columns.",
  },
  {
    checkKey: "shopout.threads",
    feature: "Shop-out",
    surface: "oasis",
    severity: "high",
    observerKind: "sql_count",
    observerCfg: {
      table: "application_lender_threads",
      timeColumn: "created_at",
      windowMinutes: 1440,
    },
    defaultWeights: { uptime: 0, error_rate: 0, latency: 0, outcome: 1 },
    defaultThresholds: { min_absolute: 1 },
  },
  {
    checkKey: "cron.freshness",
    feature: "Scheduled jobs",
    surface: "oasis",
    severity: "critical",
    observerKind: "freshness",
    observerCfg: { table: "cron_jobs", timeColumn: "last_run_at" },
    defaultWeights: { uptime: 1, error_rate: 0, latency: 0, outcome: 0 },
    defaultThresholds: { stale_after_min: 180 },
    notes: "Newest cron run across the fleet. Catches the scheduler itself dying.",
  },
  {
    checkKey: "app.http",
    feature: "OASIS web app",
    surface: "oasis",
    severity: "critical",
    observerKind: "http_probe",
    observerCfg: { path: "/api/health", timeoutMs: 8000 },
    defaultWeights: { uptime: 0.6, error_rate: 0, latency: 0.4, outcome: 0 },
    defaultThresholds: { latency_budget_ms: 1500 },
    notes: "The one check where liveness IS the question. Everything else asks about outcomes.",
  },
];

export function findCheck(checkKey: string): HealthCheckDefinition | undefined {
  return CHECK_REGISTRY.find((c) => c.checkKey === checkKey);
}
