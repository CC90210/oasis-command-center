/**
 * lib/ai-audit/ownership.ts — does a Free AI Audit own this lead's deal?
 *
 * While an engagement is open on a lead, the audit's proposal and checkout are
 * the deal's only price and payment request; the website-sales route refuses
 * its own quote and payment-link actions (409 ai_audit_owns_deal). A database
 * without the ai_audit tables (the migration not yet applied) has no audits,
 * so website sales keep working exactly as before. Any other failure is
 * thrown: guessing "no audit" could let two payment requests reach a client.
 */
import "server-only";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export async function aiAuditOwnsLead(tenantId: string, leadId: string): Promise<boolean> {
  if (!tursoConfigured()) return false;
  try {
    const rs = await getTursoClient().execute({
      sql: "SELECT 1 AS owned FROM ai_audit_engagements WHERE tenant_id = ? AND lead_id = ? AND closed_at IS NULL LIMIT 1",
      args: [tenantId, leadId],
    });
    return rs.rows.length > 0;
  } catch (err) {
    if (/no such table/i.test(err instanceof Error ? err.message : String(err))) return false;
    throw err;
  }
}
