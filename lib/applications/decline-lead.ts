import { createApplicationFromLead } from "@/lib/applications/create-from-lead";
import { getRecord, updateRecord } from "@/lib/manifest/data";
import { extractAppFields } from "@/lib/forms/application-upsert";

/**
 * Decline a lead: promote it to an application and set status="declined" so it lands
 * in Applications › Declined. `declined` is not a valid lead stage (it lives on the
 * Applications board), so this is the only way to decline from the leads side.
 *
 * Shared by POST /api/leads/[id]/decline (single) and POST /api/leads/bulk op:"decline".
 * Auth is the CALLER's responsibility. Idempotent — createApplicationFromLead reuses the
 * linked application, so re-declining never makes a duplicate. Stamps the application
 * FIRST (status=declined + promoted_at) so a failure moving the lead leaves the deal on
 * Applications rather than nowhere.
 */
export async function declineLeadToApplication({
  tenantId,
  leadId,
  leadData,
}: {
  tenantId: string;
  leadId: string;
  leadData: Record<string, unknown>;
}): Promise<{ ok: true; applicationId: string } | { ok: false; error: string }> {
  const result = await createApplicationFromLead({ tenantId, leadId });
  if (!result.ok) return { ok: false, error: result.error };
  const appId = result.applicationId;

  // Guarantee the lead link, force status="declined", gap-fill identity from the lead
  // (never clobber a value already set) — same canonical extractor /promote uses.
  const patch: Record<string, unknown> = { lead_id: leadId, status: "declined" };
  try {
    const app = await getRecord({ tenant_id: tenantId, entity: "application", id: appId });
    const appData = (app?.data || {}) as Record<string, unknown>;
    const leadFields = extractAppFields(leadData);
    for (const [k, leadVal] of Object.entries(leadFields)) {
      const cur = appData[k];
      if (
        (cur === undefined || cur === null || cur === "") &&
        leadVal !== undefined && leadVal !== null && leadVal !== ""
      ) {
        patch[k] = leadVal;
      }
    }
  } catch {
    /* best-effort backfill — the link + status below are still guaranteed */
  }

  await updateRecord({
    tenant_id: tenantId,
    entity: "application",
    id: appId,
    patch: { ...patch, promoted_at: new Date().toISOString() },
  });
  await updateRecord({
    tenant_id: tenantId,
    entity: "lead",
    id: leadId,
    patch: { transferred_at: new Date().toISOString(), application_id: appId },
  });
  return { ok: true, applicationId: appId };
}
