/**
 * application-upsert.ts — bridge form payload to application record.
 *
 * The Adon MCA SOP §4 match-fitness scorer reads business_state +
 * industry off tenant_records.data on the APPLICATION record (not the
 * form_submissions row). Forms collect these fields (post-2026-06-11
 * seed CLI in /srv/sunbiz/ceo-agent/scripts/seed_sunbiz_application_form_fields.py),
 * but pre-fix nothing copied them onto an application row. The SOP §4
 * restricted-states / restricted-industries filter was therefore dormant
 * on every form-originated deal — only CSV-imported (lib/import/service.ts)
 * applications had the fields populated.
 *
 * This helper closes that "last seam" (VPS-agent 2026-06-11 final report).
 * Called on EVERY form-submit step, not just the last one: step-0 typically
 * carries business_state + industry + monthly_revenue + business_name, so
 * the application row gets the SOP §4 inputs as soon as the prospect
 * completes step 0. Subsequent steps add whatever extra app-shaped data
 * they collect.
 *
 * Best-effort by contract: caller wraps in try/catch and absorbs failures
 * so a DB hiccup doesn't fail the public form submission. The form
 * submission's own data persistence (form_submissions row) is the
 * source-of-truth audit trail; this helper is the convenience copy for
 * downstream scorers.
 *
 * Idempotent: re-running with the same step's payload no-ops if the
 * application already has the same field values. Picks the most-recent
 * application for the lead when multiple exist (legacy fallback).
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import { createRecord } from "@/lib/manifest/data";

/**
 * Whitelist of payload keys the application record cares about. Anything
 * outside this list stays on form_submissions.payload only — applications
 * don't carry document references or file uploads directly; lead_documents
 * + application_lender_threads.attachments handle those.
 */
const APPLICATION_FIELD_KEYS = [
  "business_name",
  "business_state",
  "industry",
  "contact_name",
  "email",
  "phone",
  "monthly_revenue",
  "time_in_business_months",
  "applicant_fico",
  "requested_amount",
  "desired_product",
  "position_count",
] as const;

/**
 * Per-key normalization so the application row carries canonical shapes
 * (uppercase 2-letter state, lowercase slug industry, parsed currency).
 * Returns undefined to signal "don't write this key" — caller filters
 * those out before persisting.
 */
function normalize(key: string, value: unknown): unknown {
  if (key === "business_state" && typeof value === "string") {
    const v = value.trim().toUpperCase();
    return v.length === 2 ? v : undefined;
  }
  if (key === "industry" && typeof value === "string") {
    return value.trim().toLowerCase() || undefined;
  }
  if (key === "email" && typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v.includes("@") ? v : undefined;
  }
  if (key === "monthly_revenue" || key === "requested_amount") {
    if (typeof value === "number" && isFinite(value)) return value;
    if (typeof value === "string") {
      const n = parseFloat(value.replace(/[$,\s]/g, ""));
      return isNaN(n) ? undefined : n;
    }
    return undefined;
  }
  if (key === "time_in_business_months" || key === "applicant_fico" || key === "position_count") {
    if (typeof value === "number" && isFinite(value)) return value;
    if (typeof value === "string") {
      const n = parseInt(value.replace(/[,\s]/g, ""), 10);
      return isNaN(n) ? undefined : n;
    }
    return undefined;
  }
  if (typeof value === "string") {
    const v = value.trim();
    return v || undefined;
  }
  return value;
}

/**
 * Form fields whose NAME differs from the canonical application key.
 * The SunBiz full-application form collects `requested_advance` (MCA
 * vocabulary), but every downstream reader — match-fitness.ts (max-funded
 * gate), the lender-submission builder, and the CSV import path — reads
 * `requested_amount`. Map at extraction so the form value lands under the
 * canonical key WITHOUT renaming the whitelist (which would break all of
 * those consumers). Keyed canonical-key -> accepted source field names.
 */
const FIELD_ALIASES: Record<string, string[]> = {
  requested_amount: ["requested_advance"],
};

/** Read a whitelisted key from the payload, falling back to any aliased
 * source name. The canonical key wins if both are present. */
function readField(payload: Record<string, unknown>, key: string): unknown {
  if (key in payload) return payload[key];
  for (const alias of FIELD_ALIASES[key] ?? []) {
    if (alias in payload) return payload[alias];
  }
  return undefined;
}

function extractAppFields(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of APPLICATION_FIELD_KEYS) {
    const raw = readField(payload, key);
    if (raw !== undefined) {
      const normalized = normalize(key, raw);
      if (normalized !== undefined && normalized !== null && normalized !== "") {
        out[key] = normalized;
      }
    }
  }
  return out;
}

export type UpsertResult =
  | { ok: true; created: boolean; updated_keys: string[] }
  | { ok: true; skipped: true; reason: string };

export async function upsertApplicationFromFormStep(input: {
  tenantId: string;
  leadId: string;
  formId: string;
  stepIndex: number;
  payload: Record<string, unknown>;
}): Promise<UpsertResult> {
  // Defensive: the form-link token's lead_id should always be present
  // (it's part of the verified token shape) but a missing value would
  // make the application orphan or upsert the wrong row. Skip cleanly.
  if (!input.leadId || typeof input.leadId !== "string" || !input.leadId.trim()) {
    return { ok: true, skipped: true, reason: "missing or invalid lead_id" };
  }
  if (!input.tenantId || typeof input.tenantId !== "string" || !input.tenantId.trim()) {
    return { ok: true, skipped: true, reason: "missing or invalid tenant_id" };
  }
  const fields = extractAppFields(input.payload);
  if (Object.keys(fields).length === 0) {
    return { ok: true, skipped: true, reason: "no application-shaped fields in this step's payload" };
  }

  const db = getServiceSupabase();

  // Propagate the lead's agent assignment to the application so the
  // Opportunity Pipeline shows the deal under the right agent's name (the
  // pipeline injects assigned_to_name from assigned_to via
  // lib/assigned-names.ts). Best-effort — never blocks the upsert.
  let leadAssignedTo: string | null = null;
  try {
    const leadRow = await db
      .from("tenant_records")
      .select("data")
      .eq("tenant_id", input.tenantId)
      .eq("entity_type", "lead")
      .eq("id", input.leadId)
      .maybeSingle();
    const ld = (leadRow.data as { data?: Record<string, unknown> } | null)?.data;
    if (ld && typeof ld.assigned_to === "string" && ld.assigned_to) {
      leadAssignedTo = ld.assigned_to;
    }
  } catch {
    // best-effort
  }

  // Pick the most-recent application linked to this lead. Multiple rows
  // shouldn't happen but the .order().limit(1) is a defensive choice — if
  // a duplicate ever lands (operator manually created one + form created
  // another), we update the newest so the most recent operator intent wins.
  const existingRes = await db
    .from("tenant_records")
    .select("id, data, created_at")
    .eq("tenant_id", input.tenantId)
    .eq("entity_type", "application")
    .filter("data->>lead_id", "eq", input.leadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingRes.error) {
    throw new Error(`application lookup failed: ${existingRes.error.message}`);
  }
  const existing = existingRes.data as { id: string; data: Record<string, unknown> | null } | null;

  if (existing) {
    // Merge new fields into existing data. Newer values win (e.g. if the
    // operator edited the application then a stale form re-submission
    // arrives, the form values overwrite — but typically the form leads
    // the operator, not the other way around).
    const existingData = existing.data || {};
    const merged: Record<string, unknown> = {
      ...existingData,
      ...fields,
      last_form_step_index: input.stepIndex,
      last_form_submitted_at: new Date().toISOString(),
    };
    // Set assigned_to only if the application doesn't already have one — don't
    // clobber an operator's manual reassignment with the lead's value.
    if (leadAssignedTo && !existingData.assigned_to) {
      merged.assigned_to = leadAssignedTo;
    }
    // Backfill a pipeline status if the application never got one — don't
    // clobber an operator who has already advanced the deal.
    if (!existingData.status) {
      merged.status = "application_in";
    }
    const updateRes = await db
      .from("tenant_records")
      .update({ data: merged })
      .eq("id", existing.id)
      .eq("tenant_id", input.tenantId);
    if (updateRes.error) {
      throw new Error(`application update failed: ${updateRes.error.message}`);
    }
    return { ok: true, created: false, updated_keys: Object.keys(fields) };
  }

  // No existing application — create one. createRecord enforces the
  // entity validation per the tenant's manifest.
  await createRecord({
    tenant_id: input.tenantId,
    entity: "application",
    data: {
      lead_id: input.leadId,
      ...fields,
      ...(leadAssignedTo ? { assigned_to: leadAssignedTo } : {}),
      // Land in the first Opportunity Pipeline stage so the deal actually shows
      // up on the Applications page (the pipeline groups by `status`; a null
      // status would leave the form-created application invisible).
      status: "application_in",
      created_via: "form_submission",
      source_form_id: input.formId,
      last_form_step_index: input.stepIndex,
      last_form_submitted_at: new Date().toISOString(),
    },
  });
  return { ok: true, created: true, updated_keys: Object.keys(fields) };
}
