/**
 * promote-lead-to-application.ts — turn a lead into a shoppable application,
 * carrying the FULL UW-sheet field set, and regenerate the branded PDF.
 *
 * This is the shared helper behind the automatic live-sub path: when Ezra
 * approves a Breeze deal in Telegram, the VPS bridge injects the lead (at the
 * uw_sheet / "Live Subs" stage) and then calls the internal promote endpoint
 * (app/api/internal/live-subs/promote), which calls this. The same helper backs
 * the one-time backfill of already-approved leads.
 *
 * Why not just createApplicationFromLead: that helper copies a thin 12-key
 * whitelist and mis-keys the rest, so a live sub's EIN / addresses / owner PII /
 * entity type / positions were dropped. Here we map the lead_data across with
 * mapLeadDataToApplicationFields (canonical keys) + extractAppFields (normalize),
 * then gap-fill onto the application so operator edits are never clobbered.
 *
 * Live subs arrive without a phone (ISO sheets carry no contact PII). That does
 * NOT block creation — the application is shoppable without it — so we stamp
 * phone_status:"needs_lookup" as a visible flag the operator (and, later, the
 * ClearFunders lookup integration) can act on. Idempotent: reuses the lead's
 * existing application; only fills gaps.
 */

import "server-only";
import { getRecord, updateRecord } from "@/lib/manifest/data";
import { createApplicationFromLead } from "@/lib/applications/create-from-lead";
import { extractAppFields } from "@/lib/forms/application-upsert";
import { generateApplicationDocumentFromRecord } from "@/lib/forms/application-document";
import { mapLeadDataToApplicationFields } from "@/lib/applications/live-sub-mapping";

export type PromoteResult =
  | { ok: true; applicationId: string; created: boolean; phoneStatus: "on_file" | "needs_lookup"; appliedKeys: string[] }
  | { ok: false; error: string };

export async function promoteLeadToApplication(input: {
  tenantId: string;
  leadId: string;
  /** Provenance stamped on a NEWLY created application (default live_sub_auto). */
  source?: string;
}): Promise<PromoteResult> {
  const { tenantId, leadId } = input;
  const source = input.source || "live_sub_auto";
  if (!tenantId || !leadId) return { ok: false, error: "missing_tenant_or_lead" };

  try {
    // Load the lead (tenant-scoped — a lead outside this tenant resolves to null).
    const lead = await getRecord({ tenant_id: tenantId, entity: "lead", id: leadId }).catch(() => null);
    if (!lead) return { ok: false, error: "lead_not_found" };
    const leadData = (lead.data || {}) as Record<string, unknown>;

    // 1) Create (or reuse) the linked application. Idempotent.
    const appRes = await createApplicationFromLead({ tenantId, leadId });
    if (!appRes.ok) return { ok: false, error: appRes.error };
    const applicationId = appRes.applicationId;

    // 2) Map the full lead_data → canonical application fields, then normalize.
    const mapped = mapLeadDataToApplicationFields(leadData);
    const fields = extractAppFields({ ...leadData, ...mapped });

    const hasPhone = typeof fields.phone === "string" && (fields.phone as string).trim().length > 0;
    const phoneStatus: "on_file" | "needs_lookup" = hasPhone ? "on_file" : "needs_lookup";

    // 3) Gap-fill onto the application — never clobber a value the operator (or a
    //    prior form submission) already set on a reused application.
    const app = await getRecord({ tenant_id: tenantId, entity: "application", id: applicationId }).catch(() => null);
    const appData = (app?.data || {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      const cur = appData[k];
      // On a FRESHLY created application there's no operator data to protect, so
      // the mapped + normalized values are authoritative — e.g. business_state
      // "AZ" must win over the raw "Arizona" that createApplicationFromLead just
      // copied off the lead (the SOP §4 restricted-states filter needs the
      // 2-letter code). On a REUSED application, only fill gaps so an operator's
      // edits are never clobbered.
      if (appRes.created || cur === undefined || cur === null || cur === "") {
        patch[k] = v;
      }
    }
    patch.lead_id = leadId;
    if (!appData.status) patch.status = "application_in";
    // Provenance: mark a freshly created app as the live-sub auto path; leave a
    // reused app's existing created_via (e.g. form_submission) intact.
    if (appRes.created) patch.created_via = source;
    if (!appData.promoted_at) patch.promoted_at = new Date().toISOString();
    if (!appData.phone_status) patch.phone_status = phoneStatus;

    await updateRecord({ tenant_id: tenantId, entity: "application", id: applicationId, patch });

    // 4) Move the lead off the Leads board (the board filters on transferred_at),
    //    linking it to the application. Only stamp if not already transferred.
    const leadPatch: Record<string, unknown> = { application_id: applicationId };
    if (!leadData.transferred_at) leadPatch.transferred_at = new Date().toISOString();
    await updateRecord({ tenant_id: tenantId, entity: "lead", id: leadId, patch: leadPatch });

    // 5) (Re)generate the branded application PDF from the now-populated record.
    await generateApplicationDocumentFromRecord({ tenantId, applicationId, replace: true }).catch(() => {});

    return { ok: true, applicationId, created: appRes.created, phoneStatus, appliedKeys: Object.keys(patch) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "promote_failed" };
  }
}
