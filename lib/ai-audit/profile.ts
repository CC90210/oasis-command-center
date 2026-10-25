/**
 * lib/ai-audit/profile.ts — the discovery profile's fields.
 *
 * ONE DICTIONARY. The live-call screen, transcript extraction (phase 2), the
 * profile review screen and the audit writer all use these keys. A field has a
 * type, an optional unit, and the group it is shown in. Every stored value
 * carries one of the four evidence labels and where it came from.
 *
 * The keys cover the brief's question categories (section 3B): business
 * context, daily operations, technology, sales and marketing, financial and
 * performance figures, priorities and decision-making, plus consent.
 *
 * PURE.
 */
import { EVIDENCE_LABELS, isOneOf, type EvidenceLabel } from "@/lib/ai-audit/rules";

export const PROFILE_FIELD_TYPES = ["text", "number", "money", "list", "boolean", "rows"] as const;
export type ProfileFieldType = (typeof PROFILE_FIELD_TYPES)[number];

export const PROFILE_GROUPS = [
  "business",
  "goals",
  "operations",
  "technology",
  "sales",
  "finance",
  "decision",
  "consent",
] as const;
export type ProfileGroup = (typeof PROFILE_GROUPS)[number];

export const PROFILE_GROUP_LABELS: Readonly<Record<ProfileGroup, string>> = {
  business: "Business context",
  goals: "Objectives",
  operations: "Daily operations",
  technology: "Technology and infrastructure",
  sales: "Sales and marketing",
  finance: "Financial and performance figures",
  decision: "Priorities and decision-making",
  consent: "Consent",
};

export type ProfileFieldDef = {
  key: string;
  group: ProfileGroup;
  label: string;
  type: ProfileFieldType;
  unit?: string;
  /** For "rows": the columns of one row, e.g. task | hours per week | who. */
  columns?: readonly string[];
  /** The audit needs this figure for an estimate. Shown on the call screen's coverage meter. */
  needed_for_estimates?: boolean;
};

export const PROFILE_FIELDS: readonly ProfileFieldDef[] = [
  { key: "business.description", group: "business", label: "What the business does", type: "text" },
  { key: "business.services", group: "business", label: "Main services or products", type: "list" },
  { key: "business.customer_segments", group: "business", label: "Customer segments", type: "list" },
  { key: "business.revenue_model", group: "business", label: "How it makes money", type: "text" },
  { key: "business.team_size", group: "business", label: "Team size", type: "number", unit: "people" },
  { key: "business.locations", group: "business", label: "Locations served", type: "text" },
  { key: "goals.immediate", group: "goals", label: "Immediate objectives", type: "text" },
  { key: "goals.long_term", group: "goals", label: "Long-term objectives", type: "text" },
  { key: "goals.first_fix", group: "goals", label: "What they would fix first", type: "text" },
  { key: "ops.repetitive_tasks", group: "operations", label: "Repetitive tasks", type: "rows", columns: ["task", "hours per week", "who"], needed_for_estimates: true },
  { key: "ops.manual_workflows", group: "operations", label: "Workflows that need manual work", type: "list" },
  { key: "ops.delays", group: "operations", label: "Where delays or breakdowns happen", type: "text" },
  { key: "ops.admin_hours_per_week", group: "operations", label: "Admin hours per week", type: "number", unit: "hours/week", needed_for_estimates: true },
  { key: "tech.tools", group: "technology", label: "Tools in use", type: "rows", columns: ["tool", "what it is for", "monthly cost"] },
  { key: "tech.disconnected", group: "technology", label: "Systems that do not talk to each other", type: "text" },
  { key: "tech.frustrations", group: "technology", label: "Biggest frustrations with the tools", type: "text" },
  { key: "sales.lead_sources", group: "sales", label: "Where leads come from", type: "rows", columns: ["source", "per month"] },
  { key: "sales.leads_per_month", group: "sales", label: "New leads per month", type: "number", unit: "leads/month", needed_for_estimates: true },
  { key: "sales.lead_handling", group: "sales", label: "What happens when a lead comes in", type: "text" },
  { key: "sales.response_time_hours", group: "sales", label: "Typical first response time", type: "number", unit: "hours", needed_for_estimates: true },
  { key: "sales.close_rate_pct", group: "sales", label: "Share of leads that become customers", type: "number", unit: "%", needed_for_estimates: true },
  { key: "sales.avg_job_value", group: "sales", label: "Average job or order value", type: "money", needed_for_estimates: true },
  { key: "sales.lost_points", group: "sales", label: "Where customers are lost", type: "text" },
  { key: "sales.missed_calls_per_week", group: "sales", label: "Missed calls per week", type: "number", unit: "calls/week", needed_for_estimates: true },
  { key: "finance.staff_hourly_cost", group: "finance", label: "Cost of an hour of staff time", type: "money", needed_for_estimates: true },
  { key: "finance.relevant_costs", group: "finance", label: "Relevant operating costs", type: "text" },
  { key: "finance.kpis", group: "finance", label: "Figures they track", type: "list" },
  { key: "decision.makers", group: "decision", label: "Who approves new technology", type: "text" },
  { key: "decision.budget", group: "decision", label: "Budget (only if they volunteered it)", type: "text" },
  { key: "decision.timeline", group: "decision", label: "Timeline", type: "text" },
  { key: "decision.constraints", group: "decision", label: "Constraints", type: "text" },
  { key: "decision.past_attempts", group: "decision", label: "What they tried before, and why it stopped", type: "text" },
  { key: "consent.recording", group: "consent", label: "Agreed to recording", type: "boolean" },
  { key: "consent.ai_processing", group: "consent", label: "Agreed to AI analysis of the call", type: "boolean" },
];

const BY_KEY = new Map(PROFILE_FIELDS.map((f) => [f.key, f]));

export function profileFieldDef(key: string): ProfileFieldDef | null {
  return BY_KEY.get(key) ?? null;
}

export const PROFILE_SOURCE_TYPES = ["transcript", "call_notes", "form", "research", "owner"] as const;
export type ProfileSourceType = (typeof PROFILE_SOURCE_TYPES)[number];

export type ProfileValue = string | number | boolean | string[] | Array<Record<string, string>>;

export type ProfileFieldInput = {
  field_key: string;
  value: ProfileValue;
  label: EvidenceLabel;
  source_type: ProfileSourceType;
  /** Free-form pointer: transcript line range, form field, or a note. */
  source_note?: string;
  /** Required when label is "verified": what confirmed it. */
  verified_note?: string;
};

type V<T> = { ok: true; value: T } | { ok: false; field: string; error: string };

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\r\n/g, "\n").trim();
  return s && s.length <= max ? s : null;
}

/** One field as the browser sent it, checked against its definition. */
export function validateProfileField(raw: unknown): V<ProfileFieldInput> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, field: "", error: "not a field" };
  const r = raw as Record<string, unknown>;
  const def = typeof r.field_key === "string" ? profileFieldDef(r.field_key) : null;
  if (!def) return { ok: false, field: "field_key", error: "unknown field" };
  if (!isOneOf(EVIDENCE_LABELS, r.label)) return { ok: false, field: "label", error: "one of the four labels" };
  if (r.label === "estimate") return { ok: false, field: "label", error: "a discovery fact is never an estimate; estimates are calculated in the audit" };
  if (!isOneOf(PROFILE_SOURCE_TYPES, r.source_type)) return { ok: false, field: "source_type", error: "unknown source" };
  let value: ProfileValue;
  switch (def.type) {
    case "text": {
      const s = cleanText(r.value, 4_000);
      if (!s) return { ok: false, field: "value", error: "text up to 4000 characters" };
      value = s;
      break;
    }
    case "number": {
      const n = typeof r.value === "number" ? r.value : Number(String(r.value ?? "").replace(/,/g, ""));
      if (!Number.isFinite(n) || n < 0 || n > 1e9) return { ok: false, field: "value", error: "a number" };
      if (def.unit === "%" && n > 100) return { ok: false, field: "value", error: "a percentage up to 100" };
      value = n;
      break;
    }
    case "money": {
      const n = typeof r.value === "number" ? r.value : Number(String(r.value ?? "").replace(/[$,\s]/g, ""));
      if (!Number.isFinite(n) || n < 0 || n > 1e9) return { ok: false, field: "value", error: "an amount" };
      value = Math.round(n * 100) / 100;
      break;
    }
    case "boolean": {
      if (typeof r.value !== "boolean") return { ok: false, field: "value", error: "yes or no" };
      value = r.value;
      break;
    }
    case "list": {
      const raw2 = Array.isArray(r.value) ? r.value : typeof r.value === "string" ? r.value.split("\n") : null;
      if (!raw2) return { ok: false, field: "value", error: "a list" };
      const items = raw2.map((x) => String(x ?? "").trim()).filter(Boolean);
      if (!items.length || items.length > 30 || items.some((x) => x.length > 300)) return { ok: false, field: "value", error: "1 to 30 lines of up to 300 characters" };
      value = items;
      break;
    }
    case "rows": {
      const cols = def.columns ?? [];
      const rawRows = Array.isArray(r.value)
        ? r.value
        : typeof r.value === "string"
          ? r.value.split("\n").map((line) => line.split("|").map((c) => c.trim()))
          : null;
      if (!rawRows) return { ok: false, field: "value", error: "rows" };
      const rows: Array<Record<string, string>> = [];
      for (const row of rawRows) {
        const cells: string[] = Array.isArray(row)
          ? row.map((c) => String(c ?? "").trim())
          : row && typeof row === "object"
            ? cols.map((c) => String((row as Record<string, unknown>)[c] ?? "").trim())
            : [];
        if (!cells.some(Boolean)) continue;
        if (cells.some((c) => c.length > 300)) return { ok: false, field: "value", error: "a cell is longer than 300 characters" };
        const rec: Record<string, string> = {};
        cols.forEach((c, i) => {
          if (cells[i]) rec[c] = cells[i];
        });
        rows.push(rec);
      }
      if (!rows.length || rows.length > 30) return { ok: false, field: "value", error: "1 to 30 rows" };
      value = rows;
      break;
    }
  }
  const sourceNote = r.source_note === undefined || r.source_note === null || r.source_note === "" ? "" : cleanText(r.source_note, 500);
  if (sourceNote === null) return { ok: false, field: "source_note", error: "up to 500 characters" };
  const verifiedNote = r.verified_note === undefined || r.verified_note === null || r.verified_note === "" ? "" : cleanText(r.verified_note, 500);
  if (verifiedNote === null) return { ok: false, field: "verified_note", error: "up to 500 characters" };
  if (r.label === "verified" && !verifiedNote) {
    return { ok: false, field: "verified_note", error: "say what confirmed it (a document, a report, a check)" };
  }
  return {
    ok: true,
    value: {
      field_key: def.key,
      value,
      label: r.label,
      source_type: r.source_type,
      ...(sourceNote ? { source_note: sourceNote } : {}),
      ...(verifiedNote ? { verified_note: verifiedNote } : {}),
    },
  };
}

/** The estimate-critical figures still missing from a set of captured keys. */
export function missingEstimateFigures(capturedKeys: ReadonlySet<string>): ProfileFieldDef[] {
  return PROFILE_FIELDS.filter((f) => f.needed_for_estimates && !capturedKeys.has(f.key));
}
