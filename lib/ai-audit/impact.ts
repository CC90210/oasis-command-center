/**
 * lib/ai-audit/impact.ts — the Free AI Audit's impact calculator.
 *
 * Every estimate is a typed formula over figures the client gave (or CC
 * verified) and assumptions CC can change. No code is evaluated from data,
 * nothing is invented: a formula whose input is missing is a gap that names
 * the input, never a guess. Each result is a low-to-high range with its
 * inputs, its assumptions and what it leaves out (lib/ai-audit/doc.ts
 * DocEstimate), labelled a Reasonable estimate wherever it is shown.
 *
 * PURE: no I/O.
 */
import type { DocEstimate, DocEstimateInput } from "@/lib/ai-audit/doc";
import type { EvidenceLabel } from "@/lib/ai-audit/rules";

/** A month's weeks, as an average (52 / 12): a constant, not an assumption. */
export const WEEKS_PER_MONTH = 52 / 12;

/** The assumptions the formulas use, each a range CC may change. */
export const ASSUMPTION_KEYS = ["missed_call_recovery", "admin_automation_share", "fast_reply_uplift"] as const;
export type AssumptionKey = (typeof ASSUMPTION_KEYS)[number];
export type Assumption = { key: AssumptionKey; label: string; low: number; high: number; unit: "share"; why: string };

export const DEFAULT_ASSUMPTIONS: Readonly<Record<AssumptionKey, Assumption>> = {
  missed_call_recovery: {
    key: "missed_call_recovery",
    label: "Share of missed calls an instant reply wins back",
    low: 0.2,
    high: 0.5,
    unit: "share",
    why: "A caller who gets a text back within minutes often books; some have already called someone else.",
  },
  admin_automation_share: {
    key: "admin_automation_share",
    label: "Share of admin time automation takes off",
    low: 0.2,
    high: 0.4,
    unit: "share",
    why: "Repetitive steps (copying, chasing, reminders) automate well; judgement and exceptions stay with people.",
  },
  fast_reply_uplift: {
    key: "fast_reply_uplift",
    label: "Relative lift in the close rate from replying within minutes",
    low: 0.05,
    high: 0.15,
    unit: "share",
    why: "Leads answered first convert better; the lift depends on how slow replies are today.",
  },
};

/** CC's own ranges, where he changed one. Out-of-range or reversed values are refused. */
export type AssumptionOverrides = Partial<Record<AssumptionKey, { low: number; high: number }>>;

export function validateOverrides(v: unknown): { ok: true; value: AssumptionOverrides } | { ok: false; error: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "assumptions_invalid" };
  const out: AssumptionOverrides = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!(ASSUMPTION_KEYS as readonly string[]).includes(k)) return { ok: false, error: "assumption_unknown" };
    const r = raw as { low?: unknown; high?: unknown };
    const low = typeof r?.low === "number" ? r.low : NaN;
    const high = typeof r?.high === "number" ? r.high : NaN;
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high > 1 || low > high) return { ok: false, error: "assumption_range" };
    out[k as AssumptionKey] = { low, high };
  }
  return { ok: true, value: out };
}

export function assumptionsWith(overrides: AssumptionOverrides = {}): Record<AssumptionKey, Assumption> {
  const out = {} as Record<AssumptionKey, Assumption>;
  for (const k of ASSUMPTION_KEYS) out[k] = { ...DEFAULT_ASSUMPTIONS[k], ...(overrides[k] ?? {}) };
  return out;
}

/** A profile figure as the calculator reads it: its value, its evidence label, and the source it is cited by. */
export type ImpactInput = { value: number; label: EvidenceLabel; sourceId: string | null };
export type ImpactInputs = Partial<
  Record<
    "sales.missed_calls_per_week" | "sales.close_rate_pct" | "sales.avg_job_value" | "ops.admin_hours_per_week" | "finance.staff_hourly_cost" | "sales.leads_per_month" | "sales.response_time_hours",
    ImpactInput
  >
>;

const NAMES: Readonly<Record<keyof ImpactInputs, { name: string; unit: string }>> = {
  "sales.missed_calls_per_week": { name: "Missed calls per week", unit: "calls" },
  "sales.close_rate_pct": { name: "Share of leads that become customers", unit: "%" },
  "sales.avg_job_value": { name: "Average job value", unit: "$" },
  "ops.admin_hours_per_week": { name: "Admin hours per week", unit: "hours" },
  "finance.staff_hourly_cost": { name: "Cost of an hour of staff time", unit: "$" },
  "sales.leads_per_month": { name: "New leads per month", unit: "leads" },
  "sales.response_time_hours": { name: "Typical first response time", unit: "hours" },
};

const inputOf = (key: keyof ImpactInputs, v: ImpactInput): DocEstimateInput => ({
  name: NAMES[key].name,
  value: v.value,
  unit: NAMES[key].unit,
  label: v.label,
  ...(v.sourceId ? { basis: v.sourceId } : {}),
});
const assumptionInput = (a: Assumption, which: "range"): DocEstimateInput => ({
  name: a.label,
  value: Math.round(((a.low + a.high) / 2) * 100) / 100,
  unit: "share",
  label: "estimate",
  basis: `assumption, ${which} ${Math.round(a.low * 100)} to ${Math.round(a.high * 100)}%, editable`,
});

/** Money to the nearest $10 (to the dollar under $100); hours to the nearest half hour. */
function round(n: number, unit: string): number {
  if (unit === "$") return Math.abs(n) >= 100 ? Math.round(n / 10) * 10 : Math.round(n);
  if (unit === "hours") return Math.round(n * 2) / 2;
  return Math.round(n * 10) / 10;
}

export type ImpactResult = { estimates: DocEstimate[]; gaps: Array<{ topic: string; why: string }> };

/**
 * The estimates the client's figures support, and a gap for each one they do
 * not (naming the figures to ask for). Ids are stable, so a document that
 * cites "est-missed-calls" keeps its citation across a recompute.
 */
export function estimateImpact(inputs: ImpactInputs, overrides: AssumptionOverrides = {}): ImpactResult {
  const a = assumptionsWith(overrides);
  const estimates: DocEstimate[] = [];
  const gaps: ImpactResult["gaps"] = [];
  const need = (topic: string, keys: Array<keyof ImpactInputs>) => {
    const missing = keys.filter((k) => !inputs[k]);
    if (missing.length) gaps.push({ topic, why: `To estimate this, the audit needs: ${missing.map((k) => NAMES[k].name.toLowerCase()).join(", ")}.` });
    return missing.length === 0;
  };
  const limits = "A range, not a promise: it rests on the client's own figures and the assumptions shown.";

  // 1. Missed calls answered automatically.
  if (need("Revenue from missed calls", ["sales.missed_calls_per_week", "sales.close_rate_pct", "sales.avg_job_value"])) {
    const calls = inputs["sales.missed_calls_per_week"]!;
    const rate = inputs["sales.close_rate_pct"]!;
    const value = inputs["sales.avg_job_value"]!;
    const base = calls.value * WEEKS_PER_MONTH * (rate.value / 100) * value.value;
    const r = a.missed_call_recovery;
    estimates.push({
      id: "est-missed-calls",
      title: "Revenue won back from missed calls",
      formula: "missed calls per week x weeks in a month x share won back x close rate x average job value",
      low: round(base * r.low, "$"),
      high: round(base * r.high, "$"),
      unit: "$",
      period: "per month",
      inputs: [inputOf("sales.missed_calls_per_week", calls), inputOf("sales.close_rate_pct", rate), inputOf("sales.avg_job_value", value), assumptionInput(r, "range")],
      assumptions: [`${r.label}: ${Math.round(r.low * 100)} to ${Math.round(r.high * 100)}%. ${r.why}`, `A month is ${WEEKS_PER_MONTH.toFixed(2)} weeks on average.`, limits],
    });
  }

  // 2. Admin time taken off by automation, in hours and, with an hourly cost, in dollars.
  if (need("Admin time saved", ["ops.admin_hours_per_week"])) {
    const hours = inputs["ops.admin_hours_per_week"]!;
    const r = a.admin_automation_share;
    estimates.push({
      id: "est-admin-hours",
      title: "Admin hours saved",
      formula: "admin hours per week x share automation takes off",
      low: round(hours.value * r.low, "hours"),
      high: round(hours.value * r.high, "hours"),
      unit: "hours",
      period: "per week",
      inputs: [inputOf("ops.admin_hours_per_week", hours), assumptionInput(r, "range")],
      assumptions: [`${r.label}: ${Math.round(r.low * 100)} to ${Math.round(r.high * 100)}%. ${r.why}`, limits],
    });
    if (need("Cost of admin time saved", ["finance.staff_hourly_cost"])) {
      const cost = inputs["finance.staff_hourly_cost"]!;
      const base = hours.value * WEEKS_PER_MONTH * cost.value;
      estimates.push({
        id: "est-admin-cost",
        title: "Staff cost of the admin time saved",
        formula: "admin hours per week x weeks in a month x share automation takes off x cost of an hour",
        low: round(base * r.low, "$"),
        high: round(base * r.high, "$"),
        unit: "$",
        period: "per month",
        inputs: [inputOf("ops.admin_hours_per_week", hours), inputOf("finance.staff_hourly_cost", cost), assumptionInput(r, "range")],
        assumptions: [`${r.label}: ${Math.round(r.low * 100)} to ${Math.round(r.high * 100)}%.`, "Time saved is time back for other work; it is money only if it is used or not paid for.", limits],
      });
    }
  }

  // 3. Replying to new leads within minutes, when replies take over an hour today.
  const slow = inputs["sales.response_time_hours"];
  if (!slow || slow.value > 1) {
    if (need("Revenue from faster replies", ["sales.leads_per_month", "sales.close_rate_pct", "sales.avg_job_value", "sales.response_time_hours"])) {
      const leads = inputs["sales.leads_per_month"]!;
      const rate = inputs["sales.close_rate_pct"]!;
      const value = inputs["sales.avg_job_value"]!;
      const base = leads.value * (rate.value / 100) * value.value;
      const r = a.fast_reply_uplift;
      estimates.push({
        id: "est-fast-replies",
        title: "Revenue from replying to leads within minutes",
        formula: "new leads per month x close rate x lift from fast replies x average job value",
        low: round(base * r.low, "$"),
        high: round(base * r.high, "$"),
        unit: "$",
        period: "per month",
        inputs: [inputOf("sales.leads_per_month", leads), inputOf("sales.close_rate_pct", rate), inputOf("sales.avg_job_value", value), inputOf("sales.response_time_hours", slow!), assumptionInput(r, "range")],
        assumptions: [`${r.label}: ${Math.round(r.low * 100)} to ${Math.round(r.high * 100)}%. ${r.why}`, "Counted only because first replies take over an hour today.", limits],
      });
    }
  }
  return { estimates, gaps };
}
