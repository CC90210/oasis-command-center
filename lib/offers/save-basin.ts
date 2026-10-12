/**
 * lib/offers/save-basin.ts - the one lead_interactions row /go/community
 * writes (HANDOVER section 1.3 / 5.4): "save_basin.enrolled", recorded only
 * when the visit clicking through already resolved to a lead (findLeadForVisit
 * in lib/offers/tracking-store.ts). An anonymous visitor who never submitted
 * anything gets the community_click funnel event and nothing more — there is
 * no lead to attach an interaction to.
 *
 * Never throws: a failed write here must not fail the redirect it rides
 * alongside (lib/offers/community-link.ts decides the destination
 * independently of this call).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export async function recordSaveBasinEnrolled(
  db: SupabaseClient,
  input: { tenantId: string; leadId: string; formId: string; visitId: string; stepIndex: number | null },
): Promise<void> {
  try {
    const { error } = await db.from("lead_interactions").insert({
      tenant_id: input.tenantId,
      lead_id: input.leadId,
      type: "save_basin.enrolled",
      channel: "system",
      direction: "system",
      agent_source: "offer_funnel_tracking",
      metadata: { visit_id: input.visitId, form_id: input.formId, step_index: input.stepIndex },
      created_at: new Date().toISOString(),
    });
    if (error) {
      console.error("[offer-funnel] save_basin interaction failed", { tenantId: input.tenantId, error: error.message });
    }
  } catch (err) {
    console.error("[offer-funnel] save_basin interaction threw", {
      tenantId: input.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
