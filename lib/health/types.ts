/**
 * lib/health/types.ts — the shared vocabulary for global feature-health.
 *
 * Health is a weighted score over four components, not a liveness bit. See
 * database/112_feature_health.sql for why (short version: "the process is up"
 * was true throughout both of the outages this system exists to catch).
 *
 * Types and constants only — no "server-only" so the pure modules that depend
 * on it stay unit-testable.
 */

export type HealthSurface = "oasis" | "jarvis" | "client" | "external";
export type HealthSeverity = "critical" | "high" | "medium" | "low";
export type HealthStatus = "healthy" | "degraded" | "down" | "unknown";
export type AlertChannel = "telegram" | "email" | "sms" | "webhook" | "log";

/** The four scoreable components. */
export type ComponentKey = "uptime" | "error_rate" | "latency" | "outcome";

export type HealthWeights = Record<ComponentKey, number>;

export type HealthThresholds = {
  /** Alert under this share of the trailing median. 0.25 = 25%. */
  outcome_floor_pct: number;
  /** p95 at/under budget scores 1.0; 3x budget scores 0.0. */
  latency_budget_ms: number;
  /** Error share at/above this scores 0.0. */
  error_rate_ceiling: number;
  /**
   * Absolute floor for outcome. For low-volume checks a median-relative rule
   * is pure noise (median 1 -> a single miss reads as a 100% collapse), so an
   * absolute floor overrides it when set.
   */
  min_absolute: number | null;
  /** Freshness checks: minutes before the newest row counts as stale. */
  stale_after_min: number | null;
  /**
   * A dominant component at exactly zero forces status 'down', whatever the
   * weighted average says.
   *
   * Without this, the average hides the failure: a feature that is up, fast and
   * error-free but producing NOTHING scores 0.6 under the default weights —
   * three cheap liveness signals outvoting the one signal that matters — and
   * reports 'degraded'. Amber is ignorable. That is precisely the shape of the
   * outages this system exists to catch, so it gets an explicit override rather
   * than a weight-tuning exercise every operator would have to redo.
   */
  dominant_zero_is_down: boolean;
  /** Minimum effective weight for a component to count as dominant. */
  dominant_weight_min: number;
};

/**
 * What an observer reports. EVERY field is optional on purpose.
 *
 * A missing component means "this check does not measure that", and the scorer
 * excludes it and renormalizes the remaining weights. It must never be coerced
 * to 0 — that would manufacture a fake outage out of a check that simply has
 * no latency to report. This is the single most load-bearing rule in the file.
 */
export type Observation = {
  uptime?: number; // 0..1
  errorRate?: number; // 0..1
  latencyP95Ms?: number;
  /** Raw observed outcome volume (rows written, messages delivered, ...). */
  outcomeValue?: number;
  /** Trailing 14d median for the same check, supplied by the runner. */
  outcomeMedian?: number;
  /** Observer-level failure. Non-null forces status='unknown', never 'down'. */
  error?: string;
  durationMs?: number;
};

export type ObserverKind = "sql_count" | "sql_ratio" | "http_probe" | "freshness" | "custom";

export type HealthCheckDefinition = {
  checkKey: string;
  feature: string;
  surface: HealthSurface;
  severity: HealthSeverity;
  observerKind: ObserverKind;
  /** Declarative observer config. Shape depends on observerKind. */
  observerCfg: Record<string, unknown>;
  /** Code-suggested defaults; operator edits in the DB win over these. */
  defaultWeights?: Partial<HealthWeights>;
  defaultThresholds?: Partial<HealthThresholds>;
  notes?: string;
};

/** A check as it exists at scan time: code definition merged with DB overrides. */
export type ResolvedCheck = {
  checkKey: string;
  feature: string;
  surface: HealthSurface;
  severity: HealthSeverity;
  enabled: boolean;
  tenantId: string | null;
  observerKind: ObserverKind;
  observerCfg: Record<string, unknown>;
  weights: HealthWeights;
  thresholds: HealthThresholds;
  healthyAt: number;
  degradedAt: number;
  alertChannels: AlertChannel[];
};

/** Per-component detail behind a score. Persisted so a drop is explainable. */
export type ScoreBreakdown = {
  components: Partial<
    Record<
      ComponentKey,
      {
        raw: number | null;
        normalized: number;
        weight: number;
        effectiveWeight: number;
      }
    >
  >;
  excluded: ComponentKey[];
  /** Sum of weights before renormalization, for debugging odd configs. */
  weightSum: number;
  /**
   * Set when a dominant component hit zero and forced 'down' despite a
   * survivable average. The UI shows this so a 60%-scoring DOWN check is
   * explainable rather than looking like a bug.
   */
  dominantFailure?: ComponentKey;
};

export type ScoreResult = {
  score: number;
  status: HealthStatus;
  breakdown: ScoreBreakdown;
};

export const DEFAULT_WEIGHTS: HealthWeights = {
  uptime: 0.2,
  error_rate: 0.3,
  latency: 0.1,
  outcome: 0.4,
};

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  outcome_floor_pct: 0.25,
  latency_budget_ms: 2000,
  error_rate_ceiling: 0.1,
  min_absolute: null,
  stale_after_min: null,
  dominant_zero_is_down: true,
  dominant_weight_min: 0.4,
};
