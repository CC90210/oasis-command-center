/**
 * /ai-audits/settings — the setup checklist (what a real audit still needs),
 * then the tax rule, default currency, deposit and turnaround.
 * Founders see it; only the workspace owner saves it.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageFrame } from "@/components/os/PageFrame";
import { aiAuditPageSession } from "@/lib/ai-audit/access";
import { getSettings } from "@/lib/ai-audit/store";
import { SettingsForm } from "@/components/ai-audit/workspace/SettingsForm";
import { setupChecks } from "@/lib/ai-audit/setup";
import { SetupChecklist } from "@/components/ai-audit/SetupChecklist";

export const dynamic = "force-dynamic";

export default async function AiAuditSettingsPage() {
  const session = await aiAuditPageSession();
  if (!session) notFound();
  const [{ settings, rowVersion }, setup] = await Promise.all([getSettings(session.db, session.tenantId), setupChecks(session.db, session.tenantId, new Date())]);
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
      <div className="grid gap-5">
        <SetupChecklist checks={setup} open />
        <SettingsForm settings={settings} rowVersion={rowVersion} isOwner={session.isOwner} />
      </div>
    </PageFrame>
  );
}
