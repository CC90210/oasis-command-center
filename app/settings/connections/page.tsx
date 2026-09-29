/**
 * /settings/connections — Settings › Connections, the hub for every app OASIS
 * talks to (plan pillar 4; docs/os-revamp/01 §(c) "Connections hub").
 *
 * Top: the app grid with each app's real logo — "Your tools" first, then the
 * catalog grouped by purpose. Statuses are computed HERE, on the server, from
 * real sources only (lib/os/connectors.ts resolveConnectorStatus): an app with
 * no status source says "Coming soon", a failed lookup says "Status
 * unavailable", and nothing is ever "Connected" without a passing check.
 *
 * Below: the existing Credentials (shared keys, your own Google, custom
 * secrets), Kixie and Integration health — SettingsContent's own cards, which
 * the live cards in the grid open.
 *
 * The grid is for owners and admins: it reports workspace-level state. Everyone
 * else sees their own Google connection only, exactly as before the split.
 * /integrations redirects here (lib/os/redirects.ts).
 */

import { SettingsContent } from "@/components/settings/SettingsContent";
import { requireSettingsSection } from "@/components/settings/settings-viewer";
import { PageFrame } from "@/components/os/PageFrame";
import { ConnectionsHub } from "@/components/os/connections/ConnectionsHub";
import { loadConnectorFacts } from "@/components/os/connections/connector-facts";
import { CONNECTOR_CATALOG, resolveConnectorStatus, type ConnectorStatus } from "@/lib/os/connectors";
import { SUPPORT_FORM_PATH } from "@/lib/delivery/support-form";

export const dynamic = "force-dynamic";

export default async function SettingsConnectionsPage() {
  const viewer = await requireSettingsSection("connections");

  let statuses: Record<string, ConnectorStatus> | null = null;
  if (viewer.access.canManage) {
    const facts = await loadConnectorFacts({ tenantId: viewer.tenantId, userId: viewer.userId });
    const now = Date.now();
    statuses = Object.fromEntries(
      CONNECTOR_CATALOG.map((def) => [def.slug, resolveConnectorStatus(def, facts, now)]),
    );
  }

  return (
    <PageFrame
      title="Connections"
      subtitle={
        statuses
          ? "The tools your business already runs on. Connect one and every department that uses it can work with it."
          : "The accounts OASIS uses on your behalf. Workspace apps are connected by an owner or admin."
      }
    >
      <div className="space-y-10">
        {statuses && <ConnectionsHub statuses={statuses} supportHref={SUPPORT_FORM_PATH} />}
        <section aria-label="Credentials and health" className="space-y-4">
          {statuses && (
            <div>
              <h2 className="text-sm font-semibold text-fg">Keys and accounts</h2>
              <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
                Where the connections above are set up, and the health of every system your agents use.
              </p>
            </div>
          )}
          <SettingsContent section="connections" viewerAccess={viewer.viewerAccess} />
        </section>
      </div>
    </PageFrame>
  );
}
