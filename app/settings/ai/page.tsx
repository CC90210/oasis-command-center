/**
 * /settings/ai — Settings › AI brain: which AI account powers the agents, any
 * per-agent override, which agents this workspace has, and Jev, the
 * specialist classifier (components/settings/JevCard.tsx).
 *
 * `/settings#providers` and `/settings#agents` (linked from chat failure
 * states) are forwarded here by /settings, and SettingsContent's
 * OpenSectionOnHash opens the section the fragment names.
 */

import { SettingsContent } from "@/components/settings/SettingsContent";
import { JevCard, type JevCardFacts } from "@/components/settings/JevCard";
import { requireSettingsSection } from "@/components/settings/settings-viewer";
import { PageFrame } from "@/components/os/PageFrame";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { findActiveConnection, toPublicConnection } from "@/lib/connections/store";
import { JEV_TEXT_PROCESSING_APPROVED, jevStats, readJevMode } from "@/lib/jev/mode";
import { loadConnectorFacts } from "@/components/os/connections/connector-facts";
import { connectorBySlug, resolveConnectorStatus } from "@/lib/os/connectors";
import { isSlackSchemaMissing } from "@/lib/slack/routing";

export const dynamic = "force-dynamic";

/** The Jev card's facts, each read on its own: one failed read never blanks the others. */
async function loadJevFacts(tenantId: string, userId: string, nowMs: number): Promise<JevCardFacts> {
  const hub = await loadConnectorFacts({ tenantId, userId });
  const facts: JevCardFacts = {
    status: resolveConnectorStatus(connectorBySlug("jev")!, hub, nowMs),
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
  else console.error("[settings.ai.jev.connection]", { tenantId, error: String(conn.reason) });
  if (mode.status === "fulfilled") facts.mode = mode.value;
  else console.error("[settings.ai.jev.mode]", { tenantId, error: String(mode.reason) });
  if (stats.status === "fulfilled") facts.stats = stats.value;
  else if (isSlackSchemaMissing(stats.reason)) facts.statsNote = "Jev's numbers are not recorded on this deployment yet (its table is not installed).";
  else console.error("[settings.ai.jev.stats]", { tenantId, error: String(stats.reason) });
  return facts;
}

export default async function SettingsAiPage() {
  const viewer = await requireSettingsSection("ai");
  const nowMs = Date.now();
  const jev = await loadJevFacts(viewer.tenantId, viewer.userId, nowMs);
  return (
    <PageFrame
      title="AI brain"
      subtitle="The AI account your agents think with, and which agents this workspace runs."
    >
      <div className="space-y-4">
        <SettingsContent section="ai" viewerAccess={viewer.viewerAccess} />
        <JevCard facts={jev} nowMs={nowMs} canManage={viewer.access.canManage} oasis={viewer.access.oasisWorkspace} textApproved={JEV_TEXT_PROCESSING_APPROVED} />
      </div>
    </PageFrame>
  );
}
