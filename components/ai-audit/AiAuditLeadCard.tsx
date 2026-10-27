/**
 * The lead page's Free AI Audit card: where the lead's audit stands, or a
 * button to start one. Draws nothing outside OASIS's own workspaces, for
 * anyone who is not a founder, or before the ai_audit tables exist.
 */
import Link from "next/link";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import { aiAuditTablesInstalled, getOpenEngagementForLead } from "@/lib/ai-audit/store";
import { AI_AUDIT_STAGE_LABELS, nextActionFor, stageNumber } from "@/lib/ai-audit/rules";
import { StartAiAuditButton } from "./StartAiAuditButton";

export async function AiAuditLeadCard({ tenantId, leadId, canWork }: { tenantId: string | null; leadId: string; canWork: boolean }) {
  if (!canWork || !tenantId || !isOasisInternalTenant(tenantId) || !tursoConfigured()) return null;
  let engagement: Awaited<ReturnType<typeof getOpenEngagementForLead>> = null;
  try {
    const db = getTursoClient();
    if (!(await aiAuditTablesInstalled(db))) return null;
    engagement = await getOpenEngagementForLead(db, tenantId, leadId);
  } catch (err) {
    console.error("[ai-audit.lead-card] could not read the engagement", err instanceof Error ? err.message : err);
    return null;
  }
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline bg-bg-panel px-4 py-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-fg">Free AI Audit</h2>
        {engagement ? (
          <div className="text-[13px] text-fg-muted">
            {stageNumber(engagement.stage) ? `${stageNumber(engagement.stage)}. ` : ""}
            {AI_AUDIT_STAGE_LABELS[engagement.stage]}. Next: <span className="text-fg">{nextActionFor(engagement)}</span>
          </div>
        ) : (
          <div className="text-[13px] text-fg-muted">No audit yet. Start one to prepare the discovery call, the audit and the proposal.</div>
        )}
      </div>
      {engagement ? (
        <Link href={`/ai-audits/${engagement.id}`} className="btn-secondary">
          Open AI audit
        </Link>
      ) : (
        <StartAiAuditButton leadId={leadId} />
      )}
    </section>
  );
}
