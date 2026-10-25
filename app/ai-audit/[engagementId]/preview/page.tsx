/**
 * /ai-audit/<engagementId>/preview — CC's view of the current audit and
 * proposal exactly as the client will see them (draft or submitted), drawn by
 * the same component as the client's page and the PDF, with the Pay button
 * replaced by a note. Founders only.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageFrame } from "@/components/os/PageFrame";
import { aiAuditPageSession } from "@/lib/ai-audit/access";
import { getEngagement, getSettings } from "@/lib/ai-audit/store";
import { getAuditVersion, getProposalVersion } from "@/lib/ai-audit/versions";
import { emptyProposal, proposalTotals } from "@/lib/ai-audit/proposal";
import { offerFontVariables } from "@/app/fonts/offer-fonts";
import { AuditDocument } from "@/components/ai-audit/doc/AuditDocument";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Audit preview", robots: { index: false, follow: false } };

type Props = { params: Promise<{ engagementId: string }> };

export default async function AuditPreviewPage({ params }: Props) {
  const session = await aiAuditPageSession();
  if (!session) notFound();
  const { engagementId } = await params;
  const e = await getEngagement(session.db, session.tenantId, engagementId);
  if (!e) notFound();
  const audit = e.current_audit_version_id ? await getAuditVersion(session.db, session.tenantId, e.current_audit_version_id) : null;
  if (!audit?.doc) notFound();
  const proposalVersion = e.current_proposal_version_id ? await getProposalVersion(session.db, session.tenantId, e.current_proposal_version_id) : null;
  const { settings } = await getSettings(session.db, session.tenantId);
  const proposal =
    proposalVersion?.content ??
    emptyProposal({ currency: settings.default_currency, tax: settings.tax, to: e.contact_email ?? "", businessName: e.business_name ?? "", contactName: e.contact_name ?? "", validUntil: new Date().toISOString().slice(0, 10) });
  return (
    <PageFrame
      title="Audit preview"
      subtitle={`${e.business_name || "Unnamed business"}, version ${audit.version_no} (${audit.status.replace(/_/g, " ")}). The client sees this page with a Pay button.`}
      actions={
        <Link href={`/ai-audit/${e.id}`} className="btn-secondary">
          Back to the engagement
        </Link>
      }
    >
      <div className={offerFontVariables}>
        <AuditDocument doc={audit.doc} proposal={proposal} totals={proposalTotals(proposal)} mode="preview" notice={`Preview of version ${audit.version_no} (${audit.status.replace(/_/g, " ")}). The client sees the same page with a Pay button.`} />
      </div>
    </PageFrame>
  );
}
