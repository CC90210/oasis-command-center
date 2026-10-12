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
import { JevCard, type JevCardFacts } from "@/components/settings/JevCard";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { findActiveConnection, toPublicConnection } from "@/lib/connections/store";
import { JEV_TEXT_PROCESSING_APPROVED, jevStats, readJevMode } from "@/lib/jev/mode";
import { isSlackSchemaMissing } from "@/lib/slack/routing";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" && v ? v : null;
}

/**
 * "Specialist models" (AI1 round 2, moved here from Settings > AI brain):
 * Jev, TypeSafe's System One classifier, as this workspace has it. Every
 * line is the workspace's real state or a sourced fact; one failed read
 * never blanks the others.
 */
async function loadJevFacts(tenantId: string, userId: string, nowMs: number): Promise<JevCardFacts> {
  // The same loader as the onboarding connections step and AI brain used to:
  // the card's drawer (ConnectorDrawerButton) is the Connections drawer itself.
  const jevStatuses = await loadConnectorStatuses({ tenantId, userId, nowMs });
  const facts: JevCardFacts = {
    status: jevStatuses.jev ?? { kind: "unknown", label: "Status unavailable" },
    connection: null,
    mode: null,
    stats: null,
    statsNote: null,
  };
  if (!tursoConfigured()) return { ...facts, statsNote: "The database is not configured on this deployment." };
  const db = getTursoClient();
  const [conn, mode, stats] = await Promise.allSettled([
    findActiveConnection(db, tenantId, "jev"),
    readJevMode(db, tenantId),
    jevStats(db, tenantId, new Date(nowMs)),
  ]);
  if (conn.status === "fulfilled") facts.connection = conn.value ? toPublicConnection(conn.value, nowMs) : null;
  else console.error("[settings.connections.jev.connection]", { tenantId, error: String(conn.reason) });
  if (mode.status === "fulfilled") facts.mode = mode.value;
  else console.error("[settings.connections.jev.mode]", { tenantId, error: String(mode.reason) });
  if (stats.status === "fulfilled") facts.stats = stats.value;
  else if (isSlackSchemaMissing(stats.reason)) facts.statsNote = "Jev's numbers are not recorded on this deployment yet (its table is not installed).";
  else console.error("[settings.connections.jev.stats]", { tenantId, error: String(stats.reason) });
  return facts;
}

export default async function SettingsConnectionsPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await requireSettingsSection("connections");
  const nowMs = Date.now();
  const jev = await loadJevFacts(viewer.tenantId, viewer.userId, nowMs);
  const specialistModels = (
    <div className="mt-6 space-y-2">
      <h2 className="text-sm font-semibold text-fg">Specialist models</h2>
      <JevCard facts={jev} nowMs={nowMs} canManage={viewer.access.canManage} oasis={viewer.access.oasisWorkspace} textApproved={JEV_TEXT_PROCESSING_APPROVED} />
    </div>
  );

  if (!viewer.access.canManage) {
    return (
      <PageFrame title="Connections" subtitle="The accounts OASIS uses on your behalf. Workspace apps are connected by an owner or admin.">
        <SettingsContent section="connections" viewerAccess={viewer.viewerAccess} />
        {specialistModels}
      </PageFrame>
    );
  }

  // The same loader as the onboarding connections step and AI brain, so an app
  // set up in any of them reads the same here (lib/os/connectors.ts resolver).
  // Worker secret names only for a verified platform operator.
  const statuses = await loadConnectorStatuses({ tenantId: viewer.tenantId, userId: viewer.userId, viewerIsOperator: viewer.access.isOperator });
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
      {specialistModels}
    </PageFrame>
  );
}
