/**
 * lib/site-scan/claim.ts — a visitor claims their report: the lead the forms route already
 * created (the browser POSTed /api/forms/submit, step 0 of the scan's offer form, free-scan, or
 * of the ai-audit funnel while that form is off, and holds its minted token) gets an AI audit
 * engagement that continues from the scan.
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
import { randomUUID } from "node:crypto";
import { formLinkMac, formLinkMacMatches, verifyFormLink } from "@/lib/form-links";
import { AUDIT_FUNNEL } from "@/lib/marketing/routes";
import { aiAuditTablesInstalled, openEngagement, readLead } from "@/lib/ai-audit/store";
import { getScan, reserveClaim, setClaimEngagement } from "@/lib/site-scan/store";
import { SCAN_OFFER_SLUG } from "@/lib/site-scan/offer";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { dbBool } from "@/lib/db-bool";

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

/**
 * The forms whose token may claim a scan: the scan's own offer form (free-scan, the one the claim
 * uses while it is switched on) and the AI audit intake (the claim before the scan was its own
 * offer, and the fallback while free-scan is off). Both are this workspace's audit front doors.
 */
async function claimFormIds(db: Client, tenantId: string): Promise<string[]> {
  const rs = await db.execute({ sql: "SELECT id FROM forms WHERE tenant_id = ? AND slug IN (?, ?)", args: [tenantId, SCAN_OFFER_SLUG, AUDIT_FUNNEL.formSlug] });
  return rs.rows.map((r) => r.id).filter((id): id is string => typeof id === "string" && !!id);
}

/**
 * Which form "Send it to the OASIS team" submits: the scan's own offer form when it exists and is
 * switched on, so the lead and its count are filed under the free scan (never as an AI Automation
 * Audit submission); otherwise the audit intake, as before the scan was an offer. A read failure
 * answers the audit intake, which always accepts the claim.
 */
/** scanClaimFormSlug for the public scan pages: the audit intake when there is no database here. */
export async function scanPageClaimFormSlug(): Promise<string> {
  if (!tursoConfigured()) return AUDIT_FUNNEL.formSlug;
  return scanClaimFormSlug(getTursoClient(), AI_AUDIT_TENANT_ID);
}

export async function scanClaimFormSlug(db: Client, tenantId: string): Promise<string> {
  try {
    const rs = await db.execute({ sql: "SELECT enabled FROM forms WHERE tenant_id = ? AND slug = ? LIMIT 1", args: [tenantId, SCAN_OFFER_SLUG] });
    return rs.rows[0] && dbBool(rs.rows[0].enabled) ? SCAN_OFFER_SLUG : AUDIT_FUNNEL.formSlug;
  } catch (err) {
    console.error("[site-scan.claim] could not read the scan's offer form; the claim uses the audit intake", err instanceof Error ? err.message : String(err));
    return AUDIT_FUNNEL.formSlug;
  }
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
  // Only an audit front door opens an audit (the scan's offer form or the audit intake): a token
  // from the workspace's other forms is not one.
  const formIds = await claimFormIds(db, input.tenantId);
  if (!formIds.includes(verified.payload.form_id)) return { ok: false, error: "wrong_form" };
  const lead = await readLead(db, input.tenantId, verified.payload.lead_id);
  if (!lead) return { ok: false, error: "lead_not_found" };

  // The claimant's own engagement first: nothing is written to the scan for a claim whose audit
  // cannot open. openEngagement returns the lead's open one when there is one, so a retry lands on it.
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
  // Then the attachment, once per engagement and scan even when two retries race.
  await attachScan(db, { tenantId: input.tenantId, engagementId, scanId: scan.id, now: input.now, meta: { domain: scan.domain, score: scan.score?.total ?? null, created: opened.created } });
  // Last, the row's record of the first claim (a conditional UPDATE: of two racing, one wins).
  const reserved = await reserveClaim(db, { tenantId: input.tenantId, id: scan.id, leadRecordId: lead.id, now: input.now });
  if (reserved !== "taken") await setClaimEngagement(db, { tenantId: input.tenantId, id: scan.id, leadRecordId: lead.id, engagementId, now: input.now });
  return { ok: true, engagementId, alreadyClaimed: reserved === "mine" };
}

/**
 * Write `free_scan_attached` for this engagement and scan unless it is already there, in ONE
 * statement (INSERT ... SELECT ... WHERE NOT EXISTS runs under SQLite's write lock), so two
 * concurrent retries leave one event. Same columns as lib/ai-audit/store.ts eventStatement.
 */
async function attachScan(db: Client, input: { tenantId: string; engagementId: string; scanId: string; now: Date; meta: Record<string, unknown> }): Promise<void> {
  await db.execute({
    sql: `INSERT INTO ai_audit_events (id, tenant_id, engagement_id, event, from_stage, to_stage, actor_type, actor_id, ref_type, ref_id, meta, created_at)
          SELECT ?, ?, ?, 'free_scan_attached', NULL, NULL, 'system', NULL, 'site_scan', ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM ai_audit_events WHERE tenant_id = ? AND engagement_id = ? AND event = 'free_scan_attached' AND ref_id = ?)`,
    args: [randomUUID(), input.tenantId, input.engagementId, input.scanId, JSON.stringify(input.meta), input.now.toISOString(), input.tenantId, input.engagementId, input.scanId],
  });
}
