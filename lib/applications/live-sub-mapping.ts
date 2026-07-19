/**
 * live-sub-mapping.ts — translate a scrubber lead_data record into the
 * canonical application field names.
 *
 * Breeze "live subs" arrive via the VPS scrubber (build_lead_data in
 * SunBiz-Agent scripts/mca_lead_scrubber.py). That record uses lead-side key
 * names — `ein`, `credit_score`, `legal_name`, `tib`, `mca_positions`,
 * `home_address`, `state` — which differ from the application entity's
 * canonical keys (APPLICATION_FIELD_KEYS in lib/forms/application-upsert.ts).
 * createApplicationFromLead only copies a thin 12-key whitelist, so most of the
 * UW-sheet data (EIN, addresses, owner PII, entity type, positions) never
 * reached the application. This maps the FULL set across, keyed canonically.
 *
 * Output is a raw application-shaped object — the caller runs it through
 * extractAppFields() for the whitelist + per-key normalization, so nothing
 * here needs to coerce types. Only string/number values that are actually
 * present are emitted (undefined keys are omitted, never written as blanks).
 *
 * Live subs characteristically arrive WITHOUT contact PII (phone/email/SSN/DOB
 * are 0-fill on ISO-forwarded sheets). That's expected — the application is
 * created anyway (shoppable without a phone) and flagged phone_status by the
 * promote helper; the missing number is filled later via edit + lookup.
 *
 * Pure module (string/number transforms + the pinned field contract) — no
 * secrets, no I/O — so it carries no `server-only` guard and is unit-testable
 * directly (tests/live-sub-mapping.test.ts), matching its sibling
 * lib/forms/application-upsert.ts. Its only importers are server-side.
 */

function str(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t || undefined;
  }
  if (typeof v === "number" && isFinite(v)) return String(v);
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[$,%\s]/g, ""));
    return isNaN(n) ? undefined : n;
  }
  return undefined;
}

/** First defined string among the given lead keys. */
function firstStr(lead: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(lead[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** First defined number among the given lead keys. */
function firstNum(lead: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = num(lead[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}

function set(out: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== "") out[key] = value;
}

/** Whole months between an ISO business-start date and today (backstop for when
 * the parser emitted business_start_date but not time_in_business_months, e.g.
 * an older lead_data row). Returns undefined for a missing/unparseable date. */
function monthsFromStart(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const start = new Date(iso);
  if (isNaN(start.getTime())) return undefined;
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  return months >= 0 ? months : undefined;
}

/**
 * Map a scrubber/lead_data record to canonical application fields. The result
 * is merged over the raw lead_data and handed to extractAppFields(), so a lead
 * that already uses a canonical key (e.g. business_name) still flows through.
 */
export function mapLeadDataToApplicationFields(
  lead: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // — Business identity —
  set(out, "business_name", firstStr(lead, "business_name", "company", "legal_name", "business_legal_name"));
  set(out, "business_legal_name", firstStr(lead, "legal_name", "business_legal_name", "business_name", "company"));
  set(out, "dba", firstStr(lead, "dba"));
  // Prefer the 2-letter code: extractAppFields normalizes business_state to a
  // 2-char uppercase value and DROPS anything else, so a full state name
  // ("Arizona") would be silently lost — state_code carries "AZ".
  set(out, "business_state", firstStr(lead, "state_code", "business_state", "state"));
  set(out, "industry", firstStr(lead, "industry"));
  set(out, "business_address", firstStr(lead, "business_address", "address"));
  set(out, "entity_type", firstStr(lead, "entity_type"));
  set(out, "tax_id_ein", firstStr(lead, "tax_id_ein", "ein", "federal_tax_id"));
  set(out, "iso_broker", firstStr(lead, "iso_broker"));
  // Time in business: `tib` is the RAW sheet cell (a start DATE like
  // "2024-06-01", but also bare years / durations / mangled dates), NOT a date
  // we can trust — the VPS parser already resolves it into `business_start_date`
  // (a clean ISO date, only when the cell was a real date) and
  // `time_in_business_months` (numeric months, incl. from duration phrases).
  // Map those. NEVER fall back tib→business_start_date: that wrote garbage like
  // "Over 10 years" / "2009" into the date field (the pre-fix D5 bug). If months
  // is missing but a real start date is present, derive it here as a backstop.
  set(out, "business_start_date", firstStr(lead, "business_start_date"));
  set(out, "time_in_business_months", firstNum(lead, "time_in_business_months") ?? monthsFromStart(firstStr(lead, "business_start_date")));
  set(out, "time_in_business", firstStr(lead, "time_in_business"));
  set(out, "product_service_description", firstStr(lead, "product_service_description"));

  // — Financials —
  set(out, "monthly_revenue", firstNum(lead, "monthly_revenue", "true_revenue_monthly", "avg_monthly_revenue"));
  set(out, "requested_amount", firstNum(lead, "requested_amount", "requested_advance"));
  set(out, "applicant_fico", firstNum(lead, "applicant_fico", "credit_score", "owner_credit_score"));
  set(out, "position_count", firstNum(lead, "position_count", "mca_positions", "open_mca_positions"));
  set(out, "positions_payment", firstNum(lead, "positions_payment"));
  set(out, "positions_payment_frequency", firstStr(lead, "positions_payment_frequency"));
  set(out, "positions_balance", firstNum(lead, "positions_balance"));
  set(out, "leverage_ratio", firstNum(lead, "leverage_ratio", "leverage_pct"));

  // — Contact / owner —
  const ownerName = firstStr(lead, "owner_name", "owner_full_name", "contact_name");
  set(out, "contact_name", firstStr(lead, "contact_name", "owner_name", "owner_full_name"));
  set(out, "owner_full_name", ownerName);
  set(out, "owner_name", ownerName);
  set(out, "email", firstStr(lead, "email", "contact_email"));
  set(out, "phone", firstStr(lead, "phone", "contact_phone", "owner_cell"));
  set(out, "owner_cell", firstStr(lead, "owner_cell", "phone", "contact_phone"));
  set(out, "owner_dob", firstStr(lead, "owner_dob", "dob"));
  set(out, "owner_ssn", firstStr(lead, "owner_ssn", "ssn"));
  set(out, "owner_home_address", firstStr(lead, "owner_home_address", "home_address"));
  set(out, "owner_ownership_pct", firstNum(lead, "owner_ownership_pct", "ownership_pct"));

  return out;
}

/**
 * ── PARSER CONTRACT (pinned) ──────────────────────────────────────────────
 * These are the canonical application fields a COMPLETE Breeze live sub is
 * expected to carry after mapping + extractAppFields. Pinned against the VPS
 * `build_lead_data` output in SunBiz-Agent scripts/mca_lead_scrubber.py — keep
 * the two in lockstep. Split by criticality so a promote can log every empty
 * field (silent-data-loss guard) and alert only when a load-bearing one is
 * blank. Some listed fields are legitimately absent on the UW Sheet 2.5
 * template (applicant_fico is usually an Experian *link*, requested_amount +
 * positions_balance aren't on the sheet at all) — those surface in the log, not
 * as an alert-by-default, via LIVE_SUB_CRITICAL_FIELDS.
 */
export const LIVE_SUB_EXPECTED_FIELDS = [
  "business_name",
  "business_state",
  "industry",
  "tax_id_ein",
  "entity_type",
  "business_address",
  "monthly_revenue",
  "time_in_business_months",
  "time_in_business",
  "position_count",
  "positions_payment",
  "positions_payment_frequency",
  "leverage_ratio",
  "applicant_fico",
  "owner_name",
  "iso_broker",
  "business_start_date",
] as const;

/** The subset whose absence means the promoted deal is materially broken (not
 * merely thin). Blank business_name / monthly_revenue is alarming; the others
 * are commonly absent on Breeze sheets and only warn. */
export const LIVE_SUB_CRITICAL_FIELDS = [
  "business_name",
  "monthly_revenue",
  "position_count",
  "applicant_fico",
  "tax_id_ein",
] as const;

export type LiveSubReconciliation = {
  /** Expected application fields that came back empty after mapping. */
  emptyExpected: string[];
  /** Critical fields (LIVE_SUB_CRITICAL_FIELDS) that came back empty. */
  missingCritical: string[];
  /** True when a field NO deal should lack (business_name/monthly_revenue) is empty. */
  severe: boolean;
};

/**
 * Reconcile the extracted application fields against the pinned contract so a
 * promote never silently drops data. Call with the post-extractAppFields object.
 */
export function reconcileLiveSubFields(fields: Record<string, unknown>): LiveSubReconciliation {
  const present = (k: string): boolean => {
    const v = fields[k];
    return v !== undefined && v !== null && v !== "";
  };
  const emptyExpected = LIVE_SUB_EXPECTED_FIELDS.filter((k) => !present(k));
  const missingCritical = LIVE_SUB_CRITICAL_FIELDS.filter((k) => !present(k));
  const severe = !present("business_name") || !present("monthly_revenue");
  return { emptyExpected, missingCritical, severe };
}
