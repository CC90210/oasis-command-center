import { Card, PageHeader, Stat, EmptyState } from "@/components/Card";
import { getActiveProfile } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export const dynamic = "force-dynamic";

type RoiSnapshot = {
  snapshot_date: string;
  messages_handled: number;
  leads_processed: number;
  hours_saved_est: number;
  avg_response_sec: number;
  ai_actions_taken: number;
};

async function getRecentRoi(tenantId: string, days = 30): Promise<RoiSnapshot[]> {
  if (!tursoConfigured()) return [];
  try {
    const db = getTursoClient();
    const r = await db.execute({
      sql: `SELECT snapshot_date, messages_handled, leads_processed,
                   hours_saved_est, avg_response_sec, ai_actions_taken
            FROM client_roi_snapshots
            WHERE tenant_id = ? AND snapshot_date >= date('now', ?)
            ORDER BY snapshot_date ASC`,
      args: [tenantId, `-${days} days`],
    });
    return r.rows.map((row) => ({
      snapshot_date: String(row.snapshot_date ?? ""),
      messages_handled: Number(row.messages_handled ?? 0),
      leads_processed: Number(row.leads_processed ?? 0),
      hours_saved_est: Number(row.hours_saved_est ?? 0),
      avg_response_sec: Number(row.avg_response_sec ?? 0),
      ai_actions_taken: Number(row.ai_actions_taken ?? 0),
    }));
  } catch {
    return [];
  }
}

export default async function ClientPortalPage() {
  const profile = await safe("client-portal.profile", getActiveProfile(), null);
  const tenantId = profile?.tenant_id || "";

  const snapshots = tenantId
    ? await safe("client-portal.roi", getRecentRoi(tenantId, 30), [])
    : [];

  const totals = snapshots.reduce(
    (acc, s) => ({
      messages: acc.messages + s.messages_handled,
      leads: acc.leads + s.leads_processed,
      hours: acc.hours + s.hours_saved_est,
      actions: acc.actions + s.ai_actions_taken,
    }),
    { messages: 0, leads: 0, hours: 0, actions: 0 },
  );

  const avgResponse =
    snapshots.length > 0
      ? Math.round(
          snapshots.reduce((sum, s) => sum + s.avg_response_sec, 0) /
            snapshots.length,
        )
      : 0;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="ROI Dashboard"
        subtitle="How your AI is performing — the numbers that prove the value."
      />

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat
          label="Messages Handled"
          value={totals.messages.toLocaleString()}
          accent
        />
        <Stat
          label="Hours Saved"
          value={`${totals.hours.toFixed(1)}h`}
          hint="estimated manual work replaced"
        />
        <Stat
          label="Leads Processed"
          value={totals.leads.toLocaleString()}
        />
        <Stat
          label="Avg Response"
          value={avgResponse > 0 ? `${avgResponse}s` : "—"}
          hint="average AI response time"
        />
      </section>

      <Card title="AI Actions · 30 Days" subtitle="Total autonomous actions your AI agent performed">
        {snapshots.length === 0 ? (
          <EmptyState message="ROI data will appear here once the nightly snapshot starts running. Check back tomorrow." />
        ) : (
          <div className="space-y-2">
            {snapshots.map((s) => (
              <div
                key={s.snapshot_date}
                className="flex items-center gap-3"
              >
                <div className="w-24 text-xs text-fg-muted font-mono">
                  {s.snapshot_date}
                </div>
                <div className="flex-1 h-6 bg-bg-elev rounded-md overflow-hidden border border-bg-border">
                  <div
                    className="h-full bg-accent flex items-center px-2 text-xs font-bold text-bg"
                    style={{
                      width: `${Math.min(
                        100,
                        (s.ai_actions_taken /
                          Math.max(
                            1,
                            ...snapshots.map((x) => x.ai_actions_taken),
                          )) *
                          100,
                      )}%`,
                    }}
                  >
                    {s.ai_actions_taken > 0 && s.ai_actions_taken}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Value Summary" subtitle="What your AI has accomplished this month">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div className="p-4 bg-bg-elev rounded-lg border border-bg-border">
            <div className="text-fg-muted text-xs uppercase tracking-wider mb-1">
              Total AI Actions
            </div>
            <div className="text-2xl font-bold text-accent">
              {totals.actions.toLocaleString()}
            </div>
          </div>
          <div className="p-4 bg-bg-elev rounded-lg border border-bg-border">
            <div className="text-fg-muted text-xs uppercase tracking-wider mb-1">
              Days Tracked
            </div>
            <div className="text-2xl font-bold">{snapshots.length}</div>
          </div>
        </div>
      </Card>
    </div>
  );
}
