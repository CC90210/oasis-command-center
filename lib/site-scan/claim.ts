/**
 * lib/site-scan/claim.ts — a visitor claims their report: the lead the forms route already
 * created (the browser POSTed /api/forms/submit, step 0 of the ai-audit funnel, and holds its
 * minted token) gets an AI audit engagement that continues from the scan.
 *
 * Proofs. The minted token proves which lead this is, and that it came from the audit form
 * (signed by this deployment; no lead id is ever taken from the browser). The claim key proves
 * the visitor asked for this scan: POST /api/scan returns it to whoever requested the domain, so
 * a stranger holding only the permalink can read the report but cannot claim it.
 *
 * Claims are not exclusive. A domain is scanned once a day and the row is shared by everyone who
 * scans it, so two people at one business (or a competitor) may claim the same report. Each lead
 * gets ITS OWN engagement with the scan attached (the free_scan_attached event names the scan);
 * nobody can take a report away from someone else, and nobody learns about another claim. The
 * row's lead_record_id/engagement_id record the first claim, which is what learn.py's outcome
 * re-ranking reads.
 */
import type { Client } from "@libsql/client";
import { formLinkMac, formLinkMacMatches, verifyFormLink } from "@/lib/form-links";
import { AUDIT_FUNNEL } from "@/lib/marketing/routes";
import { aiAuditTablesInstalled, openEngagement, readLead, recordEvent } from "@/lib/ai-audit/store";
import { getScan, reserveClaim, setClaimEngagement } from "@/lib/site-scan/store";

const CLAIM_PURPOSE = "site_scan_claim/v1";

/** The claim key for a scan, for a browser that requested it. Null when signing is not configured. */
export function claimKeyFor(scanId: string): string | null {
  return formLinkMac(CLAIM_PURPOSE, scanId);
}

export type ClaimResult =
  | { ok: true; engagementId: string; alreadyClaimed: boolean }
  | {
      ok: false;
      error: "scan_not_found" | "bad_token" | "bad_claim_key" | "lead_not_found" | "wrong_workspace" | "wrong_form" | "audit_not_opened";
    };

async function auditFormId(db: Client, tenantId: string): Promise<string | null> {
  const rs = await db.execute({ sql: "SELECT id FROM forms WHERE tenant_id = ? AND slug = ? LIMIT 1", args: [tenantId, AUDIT_FUNNEL.formSlug] });
  const id = rs.rows[0]?.id;
  return typeof id === "string" && id ? id : null;
}

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
  // Only the audit intake opens an audit: a token from the workspace's other forms is not one.
  const formId = await auditFormId(db, input.tenantId);
  if (!formId || verified.payload.form_id !== formId) return { ok: false, error: "wrong_form" };
  const lead = await readLead(db, input.tenantId, verified.payload.lead_id);
  if (!lead) return { ok: false, error: "lead_not_found" };

  // The first claim is recorded on the row (a conditional UPDATE: of two racing, one wins).
  const reserved = await reserveClaim(db, { tenantId: input.tenantId, id: scan.id, leadRecordId: lead.id, now: input.now });

  // Every claimant's own engagement. openEngagement returns the lead's open one when there is one,
  // so a retry lands on it; the attachment event is written once per engagement and scan.
  if (!(await aiAuditTablesInstalled(db))) return { ok: false, error: "audit_not_opened" };
  let opened: Awaited<ReturnType<typeof openEngagement>>;
  try {
    opened = await openEngagement(db, { tenantId: input.tenantId, leadId: lead.id, actor: { type: "system", id: null }, now: input.now });
  } catch (err) {
    console.error("[site-scan.claim] engagement not opened", { scanId: scan.id, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: "audit_not_opened" };
  }
  if (!opened.ok) {
    // A lost lead, for one: the details reached the pipeline, but no audit is queued for them.
    console.error("[site-scan.claim] engagement refused", { scanId: scan.id, reason: opened.error });
    return { ok: false, error: "audit_not_opened" };
  }
  const engagementId = opened.engagement.id;
  if (reserved !== "taken") await setClaimEngagement(db, { tenantId: input.tenantId, id: scan.id, leadRecordId: lead.id, engagementId, now: input.now });
  if (!(await scanAlreadyAttached(db, input.tenantId, engagementId, scan.id))) {
    await recordEvent(db, {
      tenantId: input.tenantId,
      engagementId,
      event: "free_scan_attached",
      actor: { type: "system", id: null },
      now: input.now,
      refType: "site_scan",
      refId: scan.id,
      meta: { domain: scan.domain, score: scan.score?.total ?? null, created: opened.created, first_claim: reserved === "reserved" },
    });
  }
  return { ok: true, engagementId, alreadyClaimed: reserved === "mine" };
}

async function scanAlreadyAttached(db: Client, tenantId: string, engagementId: string, scanId: string): Promise<boolean> {
  const rs = await db.execute({
    sql: "SELECT 1 FROM ai_audit_events WHERE tenant_id = ? AND engagement_id = ? AND event = 'free_scan_attached' AND ref_id = ? LIMIT 1",
    args: [tenantId, engagementId, scanId],
  });
  return rs.rows.length > 0;
}
