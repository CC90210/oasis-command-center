/**
 * /ai-audits/settings — tax rule, default currency, deposit and turnaround.
 * Founders see it; only the workspace owner saves it.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageFrame } from "@/components/os/PageFrame";
import { aiAuditPageSession } from "@/lib/ai-audit/access";
import { getSettings } from "@/lib/ai-audit/store";
import { SettingsForm } from "@/components/ai-audit/workspace/SettingsForm";

export const dynamic = "force-dynamic";

export default async function AiAuditSettingsPage() {
  const session = await aiAuditPageSession();
  if (!session) notFound();
  const { settings, rowVersion } = await getSettings(session.db, session.tenantId);
  return (
    <PageFrame
      title="AI audit settings"
      subtitle="The tax rule is required before the first real proposal."
      actions={
        <Link href="/ai-audits" className="btn-secondary">
          Back to AI audits
        </Link>
      }
    >
      <SettingsForm settings={settings} rowVersion={rowVersion} isOwner={session.isOwner} />
    </PageFrame>
  );
}
