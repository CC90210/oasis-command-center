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
 */

import "server-only";

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
  set(out, "business_start_date", firstStr(lead, "business_start_date", "tib"));
  set(out, "product_service_description", firstStr(lead, "product_service_description"));

  // — Financials —
  set(out, "monthly_revenue", firstNum(lead, "monthly_revenue", "true_revenue_monthly", "avg_monthly_revenue"));
  set(out, "requested_amount", firstNum(lead, "requested_amount", "requested_advance"));
  set(out, "applicant_fico", firstNum(lead, "applicant_fico", "credit_score", "owner_credit_score"));
  set(out, "position_count", firstNum(lead, "position_count", "mca_positions"));

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

  return out;
}
