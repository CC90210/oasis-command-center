/**
 * /ai-audits/<engagementId>/call — the live-call screen for a discovery call
 * (components/ai-audit/call/LiveCall.tsx). Founders of OASIS's own workspaces
 * only. Read-only once the profile is authorized (Gate 1).
 */
import { notFound } from "next/navigation";
import { aiAuditPageSession } from "@/lib/ai-audit/access";
import { getEngagement } from "@/lib/ai-audit/store";
import { liveCallProps } from "@/lib/ai-audit/view";
import { PageFrame } from "@/components/os/PageFrame";
import { LiveCall } from "@/components/ai-audit/call/LiveCall";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ engagementId: string }> };

export default async function LiveCallPage({ params }: Props) {
  const session = await aiAuditPageSession();
  if (!session) notFound();
  const { engagementId } = await params;
  const e = await getEngagement(session.db, session.tenantId, engagementId);
  if (!e) notFound();
  const props = await liveCallProps(session.db, session.tenantId, e);
  return (
    <PageFrame title={`Discovery call: ${e.business_name || "Unnamed business"}`} subtitle="Ask about the business first. Notes save as you type; figures go straight into the profile as Client-reported.">
      <LiveCall {...props} />
    </PageFrame>
  );
}
