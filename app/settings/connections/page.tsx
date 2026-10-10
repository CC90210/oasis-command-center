/**
 * /settings/connections — Settings › Connections, the hub for every app OASIS
 * talks to (plan pillar 4; docs/os-revamp/01 §(c) "Connections hub").
 *
 * One card per app, and the card is the one place that app is set up
 * (CC, 2026-09-29: the page used to list the same apps a second time under
 * "Keys and accounts"). Statuses are computed HERE, on the server, from real
 * sources only (lib/os/connectors.ts resolveConnectorStatus): an app with no
 * status source says "Not built yet", a failed lookup says "Status
 * unavailable", and nothing is ever "Connected" without a passing check.
 *
 * `?app=<slug>` opens that app's drawer (connectorHref), and Google's sign-in
 * comes back to it with `?gmail_oauth=…`.
 *
 * The hub is for owners and admins: it reports workspace-level state. Everyone
 * else sees their own Google connection only, exactly as before. The
 * integration heartbeats that used to sit under the hub moved to /health.
 * /integrations redirects here (lib/os/redirects.ts).
 */

import { SettingsContent } from "@/components/settings/SettingsContent";
import { requireSettingsSection } from "@/components/settings/settings-viewer";
import { PageFrame } from "@/components/os/PageFrame";
import { ConnectionsHub } from "@/components/os/connections/ConnectionsHub";
import { loadConnectorStatuses } from "@/components/os/connections/connector-facts";
import { SUPPORT_FORM_PATH } from "@/lib/delivery/support-form";
import { isSharedInboxTenant } from "@/lib/shared-inbox-tenants";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" && v ? v : null;
}

export default async function SettingsConnectionsPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await requireSettingsSection("connections");

  if (!viewer.access.canManage) {
    return (
      <PageFrame title="Connections" subtitle="The accounts OASIS uses on your behalf. Workspace apps are connected by an owner or admin.">
        <SettingsContent section="connections" viewerAccess={viewer.viewerAccess} />
      </PageFrame>
    );
  }

  // The same loader as the onboarding connections step and AI brain, so an app
  // set up in any of them reads the same here (lib/os/connectors.ts resolver).
  const statuses = await loadConnectorStatuses({ tenantId: viewer.tenantId, userId: viewer.userId });
  const sp = await searchParams;
  // Google's sign-in returns here with ?gmail_oauth=…; its drawer shows the result.
  // A sign-in popup that had to fall back to a full-window navigation (popup
  // blocked) returns with ?connection=<slug>&status=...&reason=...: that app's
  // drawer opens, and the hub shows the same banner the popup would have.
  const initialApp = one(sp.app) ?? one(sp.connection) ?? (one(sp.gmail_oauth) ? "google-workspace" : null);
  const initialStatus = one(sp.status);
  const initialReason = one(sp.reason);

  return (
    <PageFrame
      title="Connections"
      subtitle="The tools your business already runs on. Connect one and every department that uses it can work with it."
    >
      <ConnectionsHub
        statuses={statuses}
        supportHref={SUPPORT_FORM_PATH}
        initialApp={initialApp}
        initialStatus={initialStatus}
        initialReason={initialReason}
        personalGoogle={!isSharedInboxTenant(viewer.tenantSlug)}
      />
    </PageFrame>
  );
}
