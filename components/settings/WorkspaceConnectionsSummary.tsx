import { CheckCircle2, AlertCircle, Building2 } from "lucide-react";

import { Card, Tag } from "@/components/Card";
import { getServiceSupabase } from "@/lib/supabase-server";
import { timeAgo } from "@/lib/fmt";
import { getTenantIntegrationPresenceForStatus } from "@/lib/tenant-integration-store";
import {
  classifyWorkspaceConnection,
  isWorkspaceHeartbeatFresh,
  type WorkspaceConnectionState,
} from "@/lib/integrations/workspace-connection-status";

type WorkspaceConnectionRow = {
  service: "gws" | "telegram";
  status: "healthy" | "degraded" | "down" | "unconfigured";
  last_ping_at: string | null;
};

const SERVICES = [
  {
    key: "gws" as const,
    label: "Google Workspace",
    detail: "Shared Gmail, Calendar, Drive, Docs, and Meet",
    requiredFields: ["app_password", "from_address"] as const,
  },
  {
    key: "telegram" as const,
    label: "Telegram bridge",
    detail: "Shared operational notifications and agent bridge",
    requiredFields: ["bot_token", "chat_id"] as const,
  },
];

type WorkspaceConnectionSnapshot = {
  health: WorkspaceConnectionRow | null;
  configured: boolean;
  lookupAvailable: boolean;
};

async function loadWorkspaceConnections(
  tenantId: string,
): Promise<Map<string, WorkspaceConnectionSnapshot>> {
  const unavailable = () =>
    new Map(
      SERVICES.map((service) => [
        service.key,
        { health: null, configured: false, lookupAvailable: false },
      ]),
    );

  let rows: Map<string, WorkspaceConnectionRow>;
  try {
    const db = getServiceSupabase();
    const result = await db
      .from("integrations_health")
      .select("service,status,last_ping_at")
      .eq("tenant_id", tenantId)
      .in("service", SERVICES.map((service) => service.key))
      .order("last_ping_at", { ascending: false, nullsFirst: false });
    if (result.error) throw new Error(result.error.message);
    rows = new Map<string, WorkspaceConnectionRow>();
    for (const row of (result.data || []) as WorkspaceConnectionRow[]) {
      // Multiple employee profiles can report the same shared service. The
      // newest tenant-scoped heartbeat is the workspace truth.
      if (!rows.has(row.service)) rows.set(row.service, row);
    }
  } catch (error) {
    console.error("[workspace-connections.health]", error);
    return unavailable();
  }

  const snapshots = await Promise.all(
    SERVICES.map(async (service): Promise<[string, WorkspaceConnectionSnapshot]> => {
      try {
        const presence = await getTenantIntegrationPresenceForStatus(
          tenantId,
          service.key,
          service.requiredFields,
        );
        return [
          service.key,
          {
            health: rows.get(service.key) || null,
            configured: service.requiredFields.every((field) => presence[field] === true),
            lookupAvailable: true,
          },
        ];
      } catch (error) {
        console.error("[workspace-connections.credentials]", { service: service.key, error });
        return [
          service.key,
          { health: rows.get(service.key) || null, configured: false, lookupAvailable: false },
        ];
      }
    }),
  );
  return new Map(snapshots);
}

const STATE_TAG: Record<
  WorkspaceConnectionState,
  { label: string; tone: "engaged" | "info" | "warm" | "neutral" }
> = {
  connected: { label: "Connected", tone: "engaged" },
  configured: { label: "Configured", tone: "info" },
  attention: { label: "Attention", tone: "warm" },
  not_configured: { label: "Not configured", tone: "neutral" },
  unavailable: { label: "Unavailable", tone: "warm" },
};

function connectionDetail(
  state: WorkspaceConnectionState,
  health: WorkspaceConnectionRow | null,
): string {
  if (state === "unavailable") {
    return "Status could not be checked. This does not mean disconnected.";
  }
  if (state === "attention") {
    return health?.last_ping_at
      ? `The latest shared-service check needs attention · ${timeAgo(health.last_ping_at)}`
      : "The latest shared-service check explicitly failed.";
  }
  if (state === "configured") {
    return "Required shared credentials are present. Waiting for a healthy heartbeat.";
  }
  if (state === "connected" && health?.last_ping_at) {
    return `Last verified ${timeAgo(health.last_ping_at)}`;
  }
  return "No shared credentials or healthy heartbeat were found.";
}

export async function WorkspaceConnectionsSummary({ tenantId }: { tenantId: string }) {
  const state = await loadWorkspaceConnections(tenantId);

  return (
    <Card
      title="Workspace connections"
      subtitle="Shared OASIS services used by the team. These are separate from the personal account connections below."
      action={<Tag tone="neutral">Shared</Tag>}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {SERVICES.map((service) => {
          const snapshot = state.get(service.key) || {
            health: null,
            configured: false,
            lookupAvailable: false,
          };
          const row = snapshot.health;
          const connectionState = classifyWorkspaceConnection({
            lookupAvailable: snapshot.lookupAvailable,
            configured: snapshot.configured,
            healthStatus: row?.status || null,
            healthFresh: isWorkspaceHeartbeatFresh(row?.last_ping_at || null),
          });
          const tag = STATE_TAG[connectionState];
          return (
            <div key={service.key} className="rounded-lg border border-bg-border bg-bg-deep/30 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-fg">{service.label}</div>
                    <div className="mt-0.5 text-[11px] leading-snug text-fg-muted">{service.detail}</div>
                  </div>
                </div>
                {connectionState === "connected" ? (
                  <Tag tone={tag.tone}>
                    <span className="inline-flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" /> {tag.label}
                    </span>
                  </Tag>
                ) : connectionState === "attention" || connectionState === "unavailable" ? (
                  <Tag tone={tag.tone}>
                    <span className="inline-flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" /> {tag.label}
                    </span>
                  </Tag>
                ) : (
                  <Tag tone={tag.tone}>{tag.label}</Tag>
                )}
              </div>
              <div className="mt-2 text-[10.5px] text-fg-dim">
                {connectionDetail(connectionState, row)}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
