/**
 * /audit-print/<versionId>?t&exp&sig — the print view the Mac runner turns
 * into the audit's PDF (lib/ai-audit/pdf.ts, CEO-Agent scripts/ai_audit).
 *
 * Refuses everything without a valid 15-minute HMAC over tenant, version and
 * expiry (lib/ai-audit/link.ts verifyRenderSignature): the signature is the
 * only credential, handed to the runner at claim time. It draws the version
 * with the proposal submitted alongside it, through the same component as the
 * client's page, in PDF mode (no Pay button, no links that need a session).
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { offerFontVariables } from "@/app/fonts/offer-fonts";
import { AuditDocument } from "@/components/ai-audit/doc/AuditDocument";
import { aiAuditLinkSecret } from "@/lib/ai-audit/env";
import { verifyRenderSignature } from "@/lib/ai-audit/link";
import { getAuditVersion, getProposalVersion } from "@/lib/ai-audit/versions";
import { proposalTotals } from "@/lib/ai-audit/proposal";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Free AI Audit | OASIS AI",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

type Props = { params: Promise<{ versionId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AuditPrintPage({ params, searchParams }: Props) {
  const { versionId } = await params;
  const sp = await searchParams;
  const secret = aiAuditLinkSecret();
  if (!secret || !tursoConfigured()) notFound();
  const tenantId = typeof sp.t === "string" ? sp.t : "";
  const ok = verifyRenderSignature(secret, { tenantId, versionId, exp: sp.exp, sig: sp.sig }, new Date());
  if (!ok) notFound();
  const db = getTursoClient();
  const audit = await getAuditVersion(db, tenantId, versionId);
  if (!audit?.doc || !["awaiting_approval", "approved", "delivered"].includes(audit.status)) notFound();
  const row = (
    await db.execute({
      sql: `SELECT id FROM ai_audit_proposal_versions WHERE tenant_id = ? AND audit_version_id = ? AND status IN ('awaiting_approval', 'approved', 'delivered')
            ORDER BY version_no DESC LIMIT 1`,
      args: [tenantId, audit.id],
    })
  ).rows[0];
  const proposal = row ? await getProposalVersion(db, tenantId, String(row.id)) : null;
  if (!proposal?.content) notFound();
  return (
    <div className={offerFontVariables}>
      <AuditDocument doc={audit.doc} proposal={proposal.content} totals={proposalTotals(proposal.content)} mode="pdf" />
    </div>
  );
}
