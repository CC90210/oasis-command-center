/**
 * lib/applications/create-from-lead.ts — create (or reuse) the application
 * record linked to a lead, so underwriting can run from the lead's Bank tab.
 *
 * WHY (2026-06-18): the lead-first lifecycle (regression 2d89c4a) means a lead
 * — whether created manually via "+ New Lead" or via the intake form — no
 * longer auto-gets an `application`. The Bank-tab underwriting UI is gated on a
 * linked application, so underwriting became unavailable for ~every lead. Rather
 * than revert the (intentional) lead-first design, we create the application
 * ON DEMAND the moment an operator chooses to underwrite — the explicit action
 * that means "this inquiry is now a real application."
 *
 * The underwriting pipeline resolves application_id -> lead_id -> lead_documents,
 * so once this row exists the lead's already-uploaded bank statements are found
 * automatically — no document re-linking.
 *
 * Idempotent: reuses the most-recent application already linked to the lead.
 * Mirrors the create path in lib/forms/application-upsert.ts.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { createRecord } from "@/lib/manifest/data";
import { extractAppFields } from "@/lib/forms/application-upsert";
import {
  GENERATED_APPLICATION_OWNERSHIP_PCT,
  mapLeadDataToApplicationFields,
} from "@/lib/applications/live-sub-mapping";

export type CreateAppFromLeadResult =
  | { ok: true; applicationId: string; created: boolean }
  | { ok: false; error: string };

export async function createApplicationFromLead(input: {
  tenantId: string;
  leadId: string;
}): Promise<CreateAppFromLeadResult> {
  const { tenantId, leadId } = input;
  if (!tenantId || !leadId) return { ok: false, error: "missing_tenant_or_lead" };

  const db = getServiceSupabase();

  // Idempotent: if an application already exists for this lead, reuse it (don't
  // create duplicates on a second "Run underwriting" click).
  const existingRes = await db
    .from("tenant_records")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "application")
    .filter("data->>lead_id", "eq", leadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingRes.error) return { ok: false, error: existingRes.error.message };
  const existing = existingRes.data as { id: string } | null;
  if (existing?.id) return { ok: true, applicationId: existing.id, created: false };

  // Load the lead so the application carries its business identity + agent.
  const leadRes = await db
    .from("tenant_records")
    .select("data")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "lead")
    .eq("id", leadId)
    .maybeSingle();
  if (leadRes.error) return { ok: false, error: leadRes.error.message };
  const leadData = (leadRes.data as { data?: Record<string, unknown> } | null)?.data;
  if (!leadData) return { ok: false, error: "lead_not_found" };

  // Copy the FULL merchant-application identity (business legal name, DBA,
  // address, EIN, entity type, owner name/SSN/ownership%, partners, …) using the
  // one canonical map — the same extractor the form-submit + AI-autofill paths
  // use (aliases + normalization included). Previously a local 12-key allowlist
  // dropped ~20 fields, so the generated application PDF rendered blank for EIN /
  // address / owner even though the lead/underwriting-sheet had them.
  //
  // Run the lead through mapLeadDataToApplicationFields FIRST. A CSV-imported
  // lead carries its address as discrete `business_address` (street only) +
  // `business_city` + `business_zip` columns, and the application entity has a
  // single free-text address field with no home for the other two. Calling
  // extractAppFields on the raw lead therefore copied the bare street line and
  // dropped the city and ZIP permanently — one of the ways a lender ended up
  // reading "7930 Snow View Drive" as a business address.
  //
  // composeBusinessAddress() inside that mapper assembles "street, city zip"
  // and deliberately leaves the state out, because the renderer splices
  // `business_state` back in. This is the same call the live-subs promote path
  // already makes (promote-lead-to-application.ts) — this path was simply
  // missed.
  const copied: Record<string, unknown> = extractAppFields({
    ...leadData,
    ...mapLeadDataToApplicationFields(leadData),
  });
  // Ownership % is stamped, not inherited, on every application GENERATED from a
  // lead — see GENERATED_APPLICATION_OWNERSHIP_PCT. (Merchant-filled web-form
  // applications don't come through here and keep whatever they typed.)
  copied.owner_ownership_pct = GENERATED_APPLICATION_OWNERSHIP_PCT;
  // business_name is manifest-required on the application entity. Fall back to
  // the lead's legal_name, then a placeholder, so createRecord validation passes.
  if (!copied.business_name) {
    copied.business_name =
      (typeof leadData.legal_name === "string" && leadData.legal_name.trim()) ||
      "Untitled application";
  }
  const assignedTo =
    typeof leadData.assigned_to === "string" && leadData.assigned_to
      ? leadData.assigned_to
      : null;

  try {
    const created = await createRecord({
      tenant_id: tenantId,
      entity: "application",
      data: {
        lead_id: leadId,
        ...copied,
        ...(assignedTo ? { assigned_to: assignedTo } : {}),
        // First Opportunity-pipeline stage so the deal is visible on Applications.
        status: "application_in",
        created_via: "manual_lead_underwriting",
      },
    });
    return { ok: true, applicationId: created.id, created: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "create_failed" };
  }
}
