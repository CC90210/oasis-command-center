/**
 * lib/ai-audit/view.ts — everything the engagement page and the board show,
 * read in one place. Plain data: it crosses the server/client boundary.
 */
import "server-only";
import type { Client } from "@libsql/client";
import {
  AI_AUDIT_STAGE_LABELS,
  nextActionFor,
  stageNumber,
} from "@/lib/ai-audit/rules";
import { auditDocIssues, type DocIssue } from "@/lib/ai-audit/doc";
import { proposalBlockers, proposalTotals, type ProposalTotals } from "@/lib/ai-audit/proposal";
import {
  getProfileVersion,
  listAuditVersions,
  listProfileFields,
  listProposalVersions,
  type AuditVersion,
  type ProfileField,
  type ProfileVersion,
  type ProposalVersion,
} from "@/lib/ai-audit/versions";
import { getEngagement, getSettings, listEngagements, listEvents, readLead, type AiAuditSettings, type AuditEvent, type Engagement } from "@/lib/ai-audit/store";
import { listCatalogue } from "@/lib/ai-audit/catalogue-store";
import type { CatalogueItem } from "@/lib/ai-audit/catalogue";
import { getShareLink, type ShareLink } from "@/lib/ai-audit/link";
import { listCheckouts, listReceipts, type Checkout, type Receipt } from "@/lib/ai-audit/payment";
import { getApprovalInTenant } from "@/lib/os/approvals/store";

export type BoardRow = {
  id: string;
  lead_id: string;
  business_name: string | null;
  contact_email: string | null;
  stage: Engagement["stage"];
  stage_label: string;
  stage_number: number | null;
  health: Engagement["health"];
  health_reason: string | null;
  payment_status: Engagement["payment_status"];
  next_action: string;
  is_fixture: boolean;
  updated_at: string;
};

export function boardRow(e: Engagement): BoardRow {
  return {
    id: e.id,
    lead_id: e.lead_id,
    business_name: e.business_name,
    contact_email: e.contact_email,
    stage: e.stage,
    stage_label: AI_AUDIT_STAGE_LABELS[e.stage],
    stage_number: stageNumber(e.stage),
    health: e.health,
    health_reason: e.health_reason,
    payment_status: e.payment_status,
    next_action: nextActionFor(e),
    is_fixture: e.is_fixture,
    updated_at: e.updated_at,
  };
}

export async function boardRows(db: Client, tenantId: string, includeClosed: boolean): Promise<BoardRow[]> {
  return (await listEngagements(db, tenantId, { includeClosed, limit: 300 })).map(boardRow);
}

export type EngagementView = {
  engagement: Engagement;
  row: BoardRow;
  lead: { id: string; stage: string; website: string | null; city: string | null } | null;
  events: AuditEvent[];
  profile: { version: ProfileVersion; fields: ProfileField[] } | null;
  audit: AuditVersion | null;
  auditVersions: Array<Pick<AuditVersion, "id" | "version_no" | "status" | "created_at" | "delivered_at" | "pdf_sha256">>;
  auditIssues: DocIssue[];
  proposal: ProposalVersion | null;
  proposalVersions: Array<Pick<ProposalVersion, "id" | "version_no" | "status" | "total_cents" | "currency" | "created_at">>;
  proposalBlockers: string[];
  totals: ProposalTotals | null;
  deliveryApproval: { id: string; status: string; outcome: string | null; reason: string | null; message: string | null } | null;
  link: ShareLink | null;
  checkouts: Checkout[];
  receipts: Receipt[];
  settings: AiAuditSettings;
  catalogue: CatalogueItem[];
};

export async function engagementView(db: Client, tenantId: string, engagementId: string, now: Date): Promise<EngagementView | null> {
  const engagement = await getEngagement(db, tenantId, engagementId);
  if (!engagement) return null;
  const [lead, events, auditVersions, proposalVersions, settings, catalogue, checkouts, receipts] = await Promise.all([
    readLead(db, tenantId, engagement.lead_id),
    listEvents(db, tenantId, engagement.id, 150),
    listAuditVersions(db, tenantId, engagement.id),
    listProposalVersions(db, tenantId, engagement.id),
    getSettings(db, tenantId),
    listCatalogue(db, tenantId, { includeFixture: engagement.is_fixture }),
    listCheckouts(db, tenantId, engagement.id),
    listReceipts(db, tenantId, engagement.id),
  ]);
  const profileVersion = engagement.current_profile_version_id ? await getProfileVersion(db, tenantId, engagement.current_profile_version_id) : null;
  const fields = profileVersion ? await listProfileFields(db, tenantId, profileVersion.id) : [];
  const audit = auditVersions.find((v) => v.id === engagement.current_audit_version_id) ?? null;
  const proposal = proposalVersions.find((v) => v.id === engagement.current_proposal_version_id) ?? null;
  const approval = engagement.delivery_approval_id ? await getApprovalInTenant(db, tenantId, engagement.delivery_approval_id) : null;
  const link = engagement.share_link_id ? await getShareLink(db, tenantId, engagement.share_link_id) : null;
  return {
    engagement,
    row: boardRow(engagement),
    lead: lead ? { id: lead.id, stage: lead.stage, website: lead.website, city: lead.city } : null,
    events,
    profile: profileVersion ? { version: profileVersion, fields } : null,
    audit,
    auditVersions: auditVersions.map((v) => ({ id: v.id, version_no: v.version_no, status: v.status, created_at: v.created_at, delivered_at: v.delivered_at, pdf_sha256: v.pdf_sha256 })),
    auditIssues: audit?.doc ? auditDocIssues(audit.doc) : [],
    proposal,
    proposalVersions: proposalVersions.map((v) => ({ id: v.id, version_no: v.version_no, status: v.status, total_cents: v.total_cents, currency: v.currency, created_at: v.created_at })),
    proposalBlockers: proposal?.content ? proposalBlockers(proposal.content, now.toISOString().slice(0, 10)) : [],
    totals: proposal?.content ? proposalTotals(proposal.content) : null,
    deliveryApproval: approval
      ? {
          id: approval.id,
          status: approval.status,
          outcome: (approval.execution_result as { outcome?: string } | null)?.outcome ?? null,
          reason: (approval.execution_result as { reason?: string } | null)?.reason ?? null,
          message: (approval.execution_result as { message?: string } | null)?.message ?? null,
        }
      : null,
    link,
    checkouts,
    receipts,
    settings: settings.settings,
    catalogue: catalogue.filter((i) => i.status === "confirmed"),
  };
}
