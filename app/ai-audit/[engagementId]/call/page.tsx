/**
 * /ai-audit/<engagementId>/call — the live-call screen for a discovery call
 * (components/ai-audit/call/LiveCall.tsx). Founders of OASIS's own workspaces
 * only. Read-only once the profile is authorized (Gate 1).
 */
import { notFound } from "next/navigation";
import { aiAuditPageSession } from "@/lib/ai-audit/access";
import { getEngagement } from "@/lib/ai-audit/store";
import { getProfileVersion, listProfileFields } from "@/lib/ai-audit/versions";
import { listCallNotes } from "@/lib/ai-audit/call-notes";
import { briefForPage } from "@/lib/ai-audit/briefs";
import { PROFILE_EDIT_STAGES } from "@/lib/ai-audit/rules";
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
  const version = e.current_profile_version_id ? await getProfileVersion(session.db, session.tenantId, e.current_profile_version_id) : null;
  const [fields, notes, brief] = await Promise.all([
    version ? listProfileFields(session.db, session.tenantId, version.id) : Promise.resolve([]),
    listCallNotes(session.db, session.tenantId, e.id),
    briefForPage(session.db, session.tenantId, e.id),
  ]);
  return (
    <PageFrame title={`Discovery call: ${e.business_name || "Unnamed business"}`} subtitle="Ask about the business first. Notes save as you type; figures go straight into the profile as Client-reported.">
      <LiveCall
        brief={brief ? { hypotheses: brief.content.hypotheses, confirm: brief.content.confirm, weight: brief.content.weight } : null}
        engagementId={e.id}
        businessType={e.business_type}
        callStartedAt={e.call_started_at}
        callEndedAt={e.call_ended_at}
        notes={notes.map((n) => ({ question_id: n.question_id, notes: n.notes, row_version: n.row_version }))}
        fields={fields.map((f) => ({ field_key: f.field_key, value: f.value, label: f.label }))}
        editable={PROFILE_EDIT_STAGES.includes(e.stage)}
      />
    </PageFrame>
  );
}
