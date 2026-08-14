import { notFound } from "next/navigation";
import { PageHeader, Tag } from "@/components/Card";
import { IntegrationKeysPanel } from "@/components/settings/IntegrationKeysPanel";
import { resolveFounder } from "@/lib/founders/gate";
import { MARKETING_CONNECTION_SERVICES } from "@/lib/founders/growth-shell";
import { getActiveProfile } from "@/lib/queries";
import { canManageTeam, type TeamRole } from "@/lib/team";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const founder = await resolveFounder();
  if (!founder) notFound();
  const profile = await getActiveProfile();
  const roleProfile = profile as typeof profile & {
    is_owner?: boolean | null;
    team_role?: TeamRole | null;
    admin_access?: boolean | null;
  };
  const canManage = Boolean(
    profile?.tenant_id === founder.tenantId &&
      (roleProfile?.is_owner ||
        canManageTeam(roleProfile?.team_role || "member", roleProfile?.admin_access === true)),
  );

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Account Connections"
        subtitle="Marketing providers · one encrypted tenant vault"
        action={<Tag tone="accent">Build 2</Tag>}
      />
      <IntegrationKeysPanel
        canManage={canManage}
        serviceFilter={MARKETING_CONNECTION_SERVICES}
        includeAdvanced
        title="Marketing connections"
        description="Connect the providers used by Organic, Paid Ads, and Outreach. Values are write-only, encrypted with AES-256-GCM, and never returned to this page. Connection tests are read-only and cannot publish, send, or spend."
      />
      <div className="rounded-xl border border-bg-border bg-bg-panel px-5 py-4 text-xs leading-5 text-fg-muted">
        Connecting an account does not activate it. Outreach remains dry-run, social publishing remains approval-gated, and paid campaigns still require the CFO spend gate.
      </div>
    </div>
  );
}
