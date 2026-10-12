/**
 * lib/offers/save-basin.ts - the one lead_interactions row /go/community
 * writes (HANDOVER section 1.3 / 5.4): "save_basin.enrolled", recorded only
 * when the visit clicking through already resolved to a lead (findLeadForVisit
 * in lib/offers/tracking-store.ts). An anonymous visitor who never submitted
 * anything gets the community_click funnel event and nothing more — there is
 * no lead to attach an interaction to.
 *
 * ONE ROW PER LEAD, EVER (CodeRabbit, PRRT_kwDOSgetsc6rd9Dc, 2026-10-12).
 * /go/community is a public, unauthenticated GET that needs only a visit id
 * already mapped to a lead -- a page refresh, a repeated click, or a link
 * prefetcher hitting it again must never add a second row to that lead's
 * timeline. A separate "does it exist" read before the INSERT is racy (two
 * concurrent hits both see no row and both insert), so this is ONE statement:
 * `INSERT ... SELECT ... WHERE NOT EXISTS (...)`, scoped to (tenant_id,
 * lead_id, type) -- the database itself refuses the second row, there is no
 * window between a check and a write for two requests to both win.
 *
 * Raw Turso client, not the Supabase-shim query builder: the builder's
 * fluent `.insert()` has no `WHERE NOT EXISTS` shape, and a conditional
 * single-statement insert is the whole point here.
 *
 * Never throws: a failed write here must not fail the redirect it rides
 * alongside (lib/offers/community-link.ts decides the destination
 * independently of this call).
 */
import type { Client } from "@libsql/client";

export async function recordSaveBasinEnrolled(
  db: Client,
  input: { tenantId: string; leadId: string; formId: string; visitId: string; stepIndex: number | null },
): Promise<void> {
  try {
    await db.execute({
      sql: `INSERT INTO lead_interactions (tenant_id, lead_id, type, channel, direction, agent_source, metadata, created_at)
            SELECT ?, ?, 'save_basin.enrolled', 'system', 'system', 'offer_funnel_tracking', ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM lead_interactions
              WHERE tenant_id = ? AND lead_id = ? AND type = 'save_basin.enrolled'
            )`,
      args: [
        input.tenantId,
        input.leadId,
        JSON.stringify({ visit_id: input.visitId, form_id: input.formId, step_index: input.stepIndex }),
        new Date().toISOString(),
        input.tenantId,
        input.leadId,
      ],
    });
  } catch (err) {
    console.error("[offer-funnel] save_basin interaction failed", {
      tenantId: input.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
