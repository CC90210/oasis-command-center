/**
 * /ai-audits/<engagementId> — one Free AI Audit engagement: discovery profile,
 * the 9-section audit draft, the proposal, delivery, payment and onboarding,
 * and the audit trail. Founders of OASIS's own workspaces only.
 */
import { notFound } from "next/navigation";
import { aiAuditPageSession } from "@/lib/ai-audit/access";
import { engagementView } from "@/lib/ai-audit/view";
import { EngagementWorkspace } from "@/components/ai-audit/workspace/EngagementWorkspace";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ engagementId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function EngagementPage({ params, searchParams }: Props) {
  const session = await aiAuditPageSession();
  if (!session) notFound();
  const { engagementId } = await params;
  const view = await engagementView(session.db, session.tenantId, engagementId, new Date());
  if (!view) notFound();
  // ?tab=call (an approval card's "Read the transcript lines") opens that tab; the workspace ignores any other value.
  const tab = (await searchParams).tab;
  return <EngagementWorkspace view={JSON.parse(JSON.stringify(view))} isOwner={session.isOwner} initialTab={typeof tab === "string" ? tab : undefined} />;
}
