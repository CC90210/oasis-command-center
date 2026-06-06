/**
 * Generic multi-entity import service.
 *
 * Companion to lib/import/entities.ts + lib/import/csv-parser.ts. The
 * caller (the API route at /api/import/[entity]) sends already-mapped
 * rows; this module does:
 *
 *   1. Per-field normalization (money / phone / email / URL / date / tags)
 *   2. Per-entity required-field validation (required + one-of-required)
 *   3. Dedup against the tenant's existing tenant_records rows of the
 *      same entity_type, using the entity's defaultDedupBy keys
 *   4. Bulk insert (or dry-run report when caller passes dryRun=true)
 *
 * Idempotent: re-uploading the same file is a no-op because the dedup
 * step matches on email/phone/business/lender_name and skips matches.
 */

import { type EntityDefinition } from "./entities";
import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_ROWS = 5_000;
const DEDUP_LOOKBACK = 20_000;

export type IncomingRow = Record<string, unknown>;

export type ImportResult = {
  ok: true;
  inserted: number;
  skipped_duplicate: number;
  skipped_malformed: number;
  duplicate_keys: string[];
  errors: string[];
  dry_run?: boolean;
};

export type ImportFailure = {
  ok: false;
  error: string;
  message?: string;
  detail?: string;
  would_have_inserted?: number;
};

// ---------------- normalizers (mirror the leads importer to keep
// behaviour identical for leads while extending to other entities) ----

function parseMoney(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const raw = String(v)
    .trim()
    .replace(/[,$%]/g, "")
    .replace(/[–—]/g, "-")
    .toLowerCase();
  if (!raw) return null;
  const matches = Array.from(raw.matchAll(/(\d+(?:\.\d+)?)\s*([km])?/g));
  if (matches.length === 0) return null;
  const lastSuffix = matches.findLast((m) => m[2])?.[2] || "";
  const values = matches
    .map((m) => {
      const base = Number(m[1]);
      if (!Number.isFinite(base)) return null;
      const suffix = m[2] || lastSuffix;
      if (suffix === "k") return base * 1_000;
      if (suffix === "m") return base * 1_000_000;
      return base;
    })
    .filter((n): n is number => n != null && Number.isFinite(n));
  if (values.length === 0) return null;
  // Range → midpoint; single value → value.
  const value =
    values.length > 1
      ? values.reduce((sum, n) => sum + n, 0) / values.length
      : values[0];
  return Number.isFinite(value) ? value : null;
}

function normEmail(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const e = s.trim().toLowerCase();
  return e && /\S+@\S+\.\S+/.test(e) ? e : null;
}

function normPhone(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const digits = s.replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 7 ? digits : null;
}

function normBusiness(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const v = s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(llc|inc|corp|corporation|ltd|co|company)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return v || null;
}

/** Normalize an Employer Identification Number to 9 digits. Accepts
 *  formats like "12-3456789", "123456789", "12 345 6789". Returns null
 *  for anything that doesn't yield exactly 9 digits — EIN is a fixed
 *  width per IRS Pub 1635, so partial values are rejected rather than
 *  truncated/padded (they'd be wrong, not just shorter). */
function normEin(s: unknown): string | null {
  if (typeof s !== "string" && typeof s !== "number") return null;
  const digits = String(s).replace(/\D+/g, "");
  return digits.length === 9 ? digits : null;
}

/** Normalize a US state to its 2-letter postal code. Accepts "FL",
 *  "Florida", "fla", "florida". Common case-insensitive name lookup
 *  with fallback to first-two-letters when nothing matches. This is a
 *  pragmatic normalizer — the canonical state list lives in the
 *  underwriting layer; this is just enough to align dedup keys. */
const STATE_NAME_TO_CODE: Readonly<Record<string, string>> = {
  alabama:"AL", alaska:"AK", arizona:"AZ", arkansas:"AR", california:"CA",
  colorado:"CO", connecticut:"CT", delaware:"DE", florida:"FL", georgia:"GA",
  hawaii:"HI", idaho:"ID", illinois:"IL", indiana:"IN", iowa:"IA",
  kansas:"KS", kentucky:"KY", louisiana:"LA", maine:"ME", maryland:"MD",
  massachusetts:"MA", michigan:"MI", minnesota:"MN", mississippi:"MS", missouri:"MO",
  montana:"MT", nebraska:"NE", nevada:"NV", "new hampshire":"NH", "new jersey":"NJ",
  "new mexico":"NM", "new york":"NY", "north carolina":"NC", "north dakota":"ND",
  ohio:"OH", oklahoma:"OK", oregon:"OR", pennsylvania:"PA", "rhode island":"RI",
  "south carolina":"SC", "south dakota":"SD", tennessee:"TN", texas:"TX", utah:"UT",
  vermont:"VT", virginia:"VA", washington:"WA", "west virginia":"WV",
  wisconsin:"WI", wyoming:"WY", "district of columbia":"DC", "puerto rico":"PR",
};
function normState(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const v = s.trim().toLowerCase();
  if (!v) return null;
  // Already a 2-letter code.
  if (/^[a-z]{2}$/.test(v)) return v.toUpperCase();
  // Full name lookup.
  const hit = STATE_NAME_TO_CODE[v];
  if (hit) return hit;
  // Last-ditch: first 2 letters when input is alpha-only and 3+ chars.
  if (/^[a-z ]{3,}$/.test(v)) {
    const compact = v.replace(/\s+/g, "");
    if (compact.length >= 2) return compact.slice(0, 2).toUpperCase();
  }
  return null;
}

function cleanString(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

function cleanUrl(v: unknown, max = 1000): string | null {
  const s = cleanString(v, max);
  if (!s) return null;
  // Bare-host autoshift: "example.com/foo" -> "https://example.com/foo"
  if (!/^https?:\/\//i.test(s) && /^[\w-]+\.[a-z]{2,}/i.test(s)) {
    return `https://${s}`.slice(0, max);
  }
  return s;
}

function cleanDate(v: unknown): string | null {
  const s = cleanString(v, 80);
  if (!s) return null;
  // Pass through anything that parses as a date; tenant_records.data is
  // free-form so we keep the original string + the ISO form when valid.
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s;
}

function cleanTagList(v: unknown): string[] | null {
  if (Array.isArray(v)) {
    const out = v.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
    return out.length ? out.slice(0, 24) : null;
  }
  if (typeof v !== "string") return null;
  const parts = v.split(/[;,|]/).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts.slice(0, 24) : null;
}

/** Run a raw value through the type-appropriate normalizer. */
function normalizeField(
  type: EntityDefinition["canonicalFields"][number]["type"],
  raw: unknown,
  maxLen?: number,
): string | number | string[] | null {
  switch (type) {
    case "email":
      return normEmail(raw);
    case "phone":
      return normPhone(raw);
    case "money":
      return parseMoney(raw);
    case "url":
      return cleanUrl(raw, maxLen);
    case "date":
      return cleanDate(raw);
    case "tag-list":
      return cleanTagList(raw);
    case "json":
      // JSON-stringify if it's already a string we can keep, else null
      return cleanString(raw, maxLen ?? 2000);
    case "text":
    default:
      return cleanString(raw, maxLen ?? 500);
  }
}

// ---------------- dedup ----

type DedupBuckets = {
  emails: Set<string>;
  phones: Set<string>;
  businesses: Set<string>;
  lender_names: Set<string>;
  names: Set<string>;
  // Build B (2026-06-06) — EIN is the most reliable merchant identifier
  // for funding deals (one EIN per business entity per the IRS). Add as
  // its own bucket so the dedup signal is exact-match without dragging
  // in normalized-name false positives.
  eins: Set<string>;
  // Composite key: normalized-legal-name + 2-letter state. The
  // canonical lookup when EIN isn't available — same business name in
  // two states is two separate entities (e.g. Pearl Capital LLC in FL
  // vs Pearl Capital LLC in NY are distinct).
  legal_state_keys: Set<string>;
};

function emptyDedupBuckets(): DedupBuckets {
  return {
    emails: new Set(),
    phones: new Set(),
    businesses: new Set(),
    lender_names: new Set(),
    names: new Set(),
    eins: new Set(),
    legal_state_keys: new Set(),
  };
}

function dedupKeyFor(
  field: string,
  data: Record<string, unknown>,
): { kind: keyof DedupBuckets; key: string } | null {
  switch (field) {
    case "email": {
      const k = normEmail(data.email ?? data.contact_email ?? null);
      return k ? { kind: "emails", key: k } : null;
    }
    case "phone": {
      const k = normPhone(data.phone ?? data.contact_phone ?? null);
      return k ? { kind: "phones", key: k } : null;
    }
    case "business": {
      const k = normBusiness(
        data.business_name ?? data.company ?? data.name ?? null,
      );
      return k ? { kind: "businesses", key: k } : null;
    }
    case "lender_name": {
      const k = normBusiness(data.lender_name ?? null);
      return k ? { kind: "lender_names", key: k } : null;
    }
    case "name": {
      const k = normBusiness(data.name ?? data.contact_name ?? null);
      return k ? { kind: "names", key: k } : null;
    }
    case "ein": {
      // EIN can land under any of these field names depending on which
      // template the operator used. IRS canonical is "EIN"; HubSpot
      // uses "federal_tax_id"; SBA forms say "tax_id".
      const k = normEin(
        data.ein ?? data.federal_tax_id ?? data.tax_id ?? data.fein ?? null,
      );
      return k ? { kind: "eins", key: k } : null;
    }
    case "legal_state": {
      const legal = normBusiness(
        data.legal_name ?? data.business_name ?? data.company ?? data.name ?? null,
      );
      const state = normState(
        data.state ?? data.business_state ?? data.physical_state ?? null,
      );
      if (!legal || !state) return null;
      return { kind: "legal_state_keys", key: `${legal}|${state}` };
    }
    default:
      return null;
  }
}

/**
 * Secondary lookup: hydrate the dedup buckets with rows from the
 * merchant_summary view (migration 066) — the aggregate that includes
 * leads + applications + funded deals across the tenant. Without this,
 * an EIN that's known on a funded deal but not on a fresh tenant_records
 * row would re-import as a duplicate merchant.
 *
 * Cheap: one query per tenant per import, paginated to the same
 * DEDUP_LOOKBACK ceiling. Failures here NEVER abort the import — the
 * tenant_records pass is still authoritative. We just lose some recall.
 */
async function hydrateBucketsFromMerchantSummary(
  db: SupabaseClient,
  tenantId: string,
  buckets: DedupBuckets,
): Promise<void> {
  try {
    // Only pull the columns we actually use for dedup keys — keeps the
    // wire payload small even for tenants with hundreds of merchants.
    const res = await db
      .from("merchant_summary")
      .select("ein, legal_name, dba, state, email, phone")
      .eq("tenant_id", tenantId)
      .limit(DEDUP_LOOKBACK);
    if (res.error || !res.data) return;
    for (const row of res.data as Array<{
      ein: string | null;
      legal_name: string | null;
      dba: string | null;
      state: string | null;
      email: string | null;
      phone: string | null;
    }>) {
      const ein = normEin(row.ein);
      if (ein) buckets.eins.add(ein);
      const legal = normBusiness(row.legal_name ?? row.dba);
      const state = normState(row.state);
      if (legal && state) {
        buckets.legal_state_keys.add(`${legal}|${state}`);
      }
      // Also seed email/phone/business so a merchant present in
      // merchant_summary but not in the recent tenant_records window
      // still dedups by those keys.
      const email = normEmail(row.email);
      if (email) buckets.emails.add(email);
      const phone = normPhone(row.phone);
      if (phone) buckets.phones.add(phone);
      if (legal) buckets.businesses.add(legal);
    }
  } catch {
    // Soft-fail.
  }
}

// ---------------- main entry point ----

export async function importRowsForTenant(input: {
  db: SupabaseClient;
  tenantId: string;
  entity: EntityDefinition;
  rows: IncomingRow[];
  dedupBy?: string[];
  defaultSource?: string;
  dryRun?: boolean;
}): Promise<ImportResult | ImportFailure> {
  const { db, tenantId, entity, rows, dryRun = false } = input;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, error: "no_rows" };
  }
  if (rows.length > MAX_ROWS) {
    return {
      ok: false,
      error: "too_many_rows",
      message: `Max ${MAX_ROWS.toLocaleString()} rows per import. Split the file.`,
    };
  }

  const dedupBy =
    Array.isArray(input.dedupBy) && input.dedupBy.length > 0
      ? input.dedupBy
      : entity.defaultDedupBy;
  const defaultSource = input.defaultSource || "csv_import";

  // ----- 1. Pull existing tenant_records of this entity_type for dedup -----
  const existingRes = await db
    .from("tenant_records")
    .select("data")
    .eq("tenant_id", tenantId)
    .eq("entity_type", entity.entity_type)
    .order("updated_at", { ascending: false })
    .limit(DEDUP_LOOKBACK);
  if (existingRes.error) {
    return {
      ok: false,
      error: "dedup_lookup_failed",
      detail: existingRes.error.message,
    };
  }

  const existing = emptyDedupBuckets();
  for (const row of (existingRes.data || []) as Array<{ data: Record<string, unknown> | null }>) {
    const d = row.data || {};
    for (const field of dedupBy) {
      const k = dedupKeyFor(field, d);
      if (k) existing[k.kind].add(k.key);
    }
  }

  // Build B (2026-06-06) — hydrate dedup buckets from the merchant_summary
  // view as a secondary pass. This catches funded merchants whose
  // tenant_records row falls outside DEDUP_LOOKBACK and surfaces EIN +
  // legal+state matches the tenant_records pass alone can't see (the
  // merchant_summary aggregates lead + application + funded_deal entities).
  // Only fires when the entity's dedup strategy actually consults merchant
  // signals — skip for pure lender imports where it's noise.
  const dedupTouchesMerchant =
    dedupBy.includes("ein") ||
    dedupBy.includes("legal_state") ||
    dedupBy.includes("business");
  if (dedupTouchesMerchant) {
    await hydrateBucketsFromMerchantSummary(db, tenantId, existing);
  }

  // ----- 2. Walk + normalize + dedup the incoming rows -----
  const toInsert: Array<{ tenant_id: string; entity_type: string; data: Record<string, unknown> }> = [];
  const seen = emptyDedupBuckets();
  let skippedDuplicate = 0;
  let skippedMalformed = 0;
  const duplicateKeys: string[] = [];
  const errors: string[] = [];

  for (const [i, raw] of rows.entries()) {
    // Normalize every canonical field per its declared type.
    const data: Record<string, unknown> = {};
    for (const f of entity.canonicalFields) {
      const v = normalizeField(f.type, raw[f.key], f.maxLen);
      if (v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)) {
        data[f.key] = v;
      }
    }

    // Source + entity_type metadata
    data.source = data.source || defaultSource;

    // Required-field check.
    const requiredFields = entity.canonicalFields.filter((f) => f.requirement === "required");
    const oneOfRequiredFields = entity.canonicalFields.filter((f) => f.requirement === "one-of-required");
    const missingRequired = requiredFields.filter((f) => data[f.key] == null);
    if (missingRequired.length > 0) {
      skippedMalformed += 1;
      if (errors.length < 20) {
        errors.push(`row ${i + 1}: missing required ${missingRequired.map((f) => f.label).join(", ")}`);
      }
      continue;
    }
    if (oneOfRequiredFields.length > 0) {
      const anyPresent = oneOfRequiredFields.some((f) => data[f.key] != null);
      if (!anyPresent) {
        skippedMalformed += 1;
        if (errors.length < 20) {
          errors.push(
            `row ${i + 1}: at least one of ${oneOfRequiredFields
              .map((f) => f.label)
              .join(" / ")} is required`,
          );
        }
        continue;
      }
    }

    // Dedup
    let isDupe = false;
    let dupeKey = "";
    for (const field of dedupBy) {
      const k = dedupKeyFor(field, data);
      if (!k) continue;
      if (existing[k.kind].has(k.key) || seen[k.kind].has(k.key)) {
        isDupe = true;
        dupeKey = `${field}:${k.key}`;
        break;
      }
    }
    if (isDupe) {
      skippedDuplicate += 1;
      if (duplicateKeys.length < 50) duplicateKeys.push(dupeKey);
      continue;
    }
    for (const field of dedupBy) {
      const k = dedupKeyFor(field, data);
      if (k) seen[k.kind].add(k.key);
    }

    toInsert.push({
      tenant_id: tenantId,
      entity_type: entity.entity_type,
      data: {
        ...data,
        imported_at: new Date().toISOString(),
      },
    });
  }

  // ----- 3. Insert (or dry-run) -----
  if (dryRun) {
    return {
      ok: true,
      inserted: 0,
      skipped_duplicate: skippedDuplicate,
      skipped_malformed: skippedMalformed,
      duplicate_keys: duplicateKeys,
      errors: errors.slice(0, 20),
      dry_run: true,
    };
  }

  let inserted = 0;
  if (toInsert.length > 0) {
    const insRes = await db.from("tenant_records").insert(toInsert).select("id");
    if (insRes.error) {
      return {
        ok: false,
        error: "insert_failed",
        detail: insRes.error.message,
        would_have_inserted: toInsert.length,
      };
    }
    inserted = (insRes.data || []).length;
  }

  return {
    ok: true,
    inserted,
    skipped_duplicate: skippedDuplicate,
    skipped_malformed: skippedMalformed,
    duplicate_keys: duplicateKeys,
    errors: errors.slice(0, 20),
  };
}
