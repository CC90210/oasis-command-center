/**
 * lib/site-scan/claim.ts — a visitor claims their report: the lead the forms route already
 * created (the browser POSTed /api/forms/submit, step 0 of the ai-audit funnel, and holds its
 * minted token) is linked to the scan, and the scan becomes the first step of an AI audit
 * engagement so the paid audit continues from it.
 *
 * Two proofs, each for its own question. The minted token proves which lead this is (signed by
 * this deployment; no lead id is ever taken from the browser). The claim key proves the visitor
 * started this scan: POST /api/scan hands it only to the browser that asked for the scan, so a
 * stranger holding the permalink can read the report but cannot attach their lead to it.
 */
import type { Client } from "@libsql/client";
import { formLinkMac, formLinkMacMatches, verifyFormLink } from "@/lib/form-links";
import { AUDIT_FUNNEL } from "@/lib/marketing/routes";
import { aiAuditTablesInstalled, openEngagement, readLead, recordEvent } from "@/lib/ai-audit/store";
import { getScan, reserveClaim, setClaimEngagement } from "@/lib/site-scan/store";

const CLAIM_PURPOSE = "site_scan_claim/v1";

/** The claim key for a scan, for the browser that started (or re-started) it. Null when signing is not configured. */
export function claimKeyFor(scanId: string): string | null {
  return formLinkMac(CLAIM_PURPOSE, scanId);
}

export type ClaimResult =
  | { ok: true; engagementId: string | null; alreadyClaimed: boolean }
  | { ok: false; error: "scan_not_found" | "bad_token" | "bad_claim_key" | "lead_not_found" | "wrong_workspace" | "claimed_by_another" };

export async function claimScan(
  db: Client,
  input: { tenantId: string; scanId: string; token: string; claimKey: string; now: Date },
): Promise<ClaimResult> {
  const scan = await getScan(db, input.tenantId, input.scanId);
  if (!scan) return { ok: false, error: "scan_not_found" };
  if (!formLinkMacMatches(CLAIM_PURPOSE, scan.id, input.claimKey)) return { ok: false, error: "bad_claim_key" };
  const verified = verifyFormLink(input.token);
  if (!verified.ok) return { ok: false, error: "bad_token" };
  if (verified.payload.tenant !== AUDIT_FUNNEL.tenantSlug) return { ok: false, error: "wrong_workspace" };
  const lead = await readLead(db, input.tenantId, verified.payload.lead_id);
  if (!lead) return { ok: false, error: "lead_not_found" };

  // Reserve first. Of two claims racing, one lead wins; the loser opens nothing and learns nothing
  // about the winner (its lead or its engagement).
  const reserved = await reserveClaim(db, { tenantId: input.tenantId, id: scan.id, leadRecordId: lead.id, now: input.now });
  if (reserved === "taken") return { ok: false, error: "claimed_by_another" };

  const current = reserved === "mine" ? await getScan(db, input.tenantId, scan.id) : scan;
  let engagementId: string | null = current?.engagementId ?? null;
  if (!engagementId) {
    try {
      if (await aiAuditTablesInstalled(db)) {
        // openEngagement returns the lead's open engagement when there is one, so a retry lands on it.
        const opened = await openEngagement(db, { tenantId: input.tenantId, leadId: lead.id, actor: { type: "system", id: null }, now: input.now });
        if (opened.ok) {
          engagementId = opened.engagement.id;
          if (await setClaimEngagement(db, { tenantId: input.tenantId, id: scan.id, leadRecordId: lead.id, engagementId, now: input.now })) {
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
      }
    } catch (err) {
      // The lead link is the claim; the engagement is a convenience the board can also open by hand.
      console.error("[site-scan.claim] engagement not opened", { scanId: scan.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ok: true, engagementId, alreadyClaimed: reserved === "mine" };
}
