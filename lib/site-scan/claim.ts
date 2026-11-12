/**
 * lib/site-scan/claim.ts — a visitor claims their report: the lead the forms route already
 * created (the browser POSTed /api/forms/submit, step 0 of the ai-audit funnel, and holds its
 * minted token) is linked to the scan, and the scan becomes the first step of an AI audit
 * engagement so the paid audit continues from it.
 *
 * The token is the proof: it is signed by this deployment and names the lead. No lead id is ever
 * accepted from the browser directly.
 */
import type { Client } from "@libsql/client";
import { verifyFormLink } from "@/lib/form-links";
import { AUDIT_FUNNEL } from "@/lib/marketing/routes";
import { aiAuditTablesInstalled, openEngagement, readLead, recordEvent } from "@/lib/ai-audit/store";
import { attachLead, getScan } from "@/lib/site-scan/store";

export type ClaimResult =
  | { ok: true; engagementId: string | null; alreadyClaimed: boolean }
  | { ok: false; error: "scan_not_found" | "bad_token" | "lead_not_found" | "wrong_workspace" };

export async function claimScan(db: Client, input: { tenantId: string; scanId: string; token: string; now: Date }): Promise<ClaimResult> {
  const scan = await getScan(db, input.tenantId, input.scanId);
  if (!scan) return { ok: false, error: "scan_not_found" };
  const verified = verifyFormLink(input.token);
  if (!verified.ok) return { ok: false, error: "bad_token" };
  if (verified.payload.tenant !== AUDIT_FUNNEL.tenantSlug) return { ok: false, error: "wrong_workspace" };
  const lead = await readLead(db, input.tenantId, verified.payload.lead_id);
  if (!lead) return { ok: false, error: "lead_not_found" };
  if (scan.leadRecordId && scan.leadRecordId !== lead.id) {
    // Someone else's report cannot be re-claimed under a new lead; the first claim stands.
    return { ok: true, engagementId: scan.engagementId, alreadyClaimed: true };
  }

  let engagementId: string | null = scan.engagementId;
  if (!engagementId) {
    try {
      if (await aiAuditTablesInstalled(db)) {
        const opened = await openEngagement(db, { tenantId: input.tenantId, leadId: lead.id, actor: { type: "system", id: null }, now: input.now });
        if (opened.ok) {
          engagementId = opened.engagement.id;
          await recordEvent(db, {
            tenantId: input.tenantId,
            engagementId,
            event: "free_scan_attached",
            actor: { type: "system", id: null },
            now: input.now,
            refType: "site_scan",
            refId: scan.id,
            meta: { domain: scan.domain, score: scan.score?.total ?? null, created: opened.created },
          });
        }
      }
    } catch (err) {
      // The lead link is the claim; the engagement is a convenience the board can also open by hand.
      console.error("[site-scan.claim] engagement not opened", { scanId: scan.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  await attachLead(db, { tenantId: input.tenantId, id: scan.id, leadRecordId: lead.id, engagementId, now: input.now });
  return { ok: true, engagementId, alreadyClaimed: scan.leadRecordId === lead.id };
}
