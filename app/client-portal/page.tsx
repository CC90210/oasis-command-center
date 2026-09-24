import Link from "next/link";
import { Card, PageHeader, Stat, EmptyState } from "@/components/Card";
import { LoadError, StageTag, TicketStatusTag } from "@/components/delivery/badges";
import { getActiveProfile } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { timeAgo } from "@/lib/fmt";
import { getDeliveryAccess } from "@/lib/delivery/session";
import { listProjects, listTickets, type Project, type Ticket } from "@/lib/delivery/store";
import { SUPPORT_FORM_PATH } from "@/lib/delivery/support-form";

export const dynamic = "force-dynamic";

type DeliveryPanel =
  | { kind: "client"; projects: Project[]; tickets: Ticket[] }
  | { kind: "error" }
  | { kind: "none" };

/**
 * The client's projects and tickets, through the same scoped store as
 * /projects and /tickets (lib/delivery/access.ts decides): only rows whose
 * client_tenant_id is this workspace, only what a client may see. Anyone who
 * is not a client viewer (an OASIS founder previewing the page) gets nothing
 * here rather than the whole book.
 */
async function getDeliveryPanel(): Promise<DeliveryPanel> {
  if (!tursoConfigured()) return { kind: "none" };
  try {
    const access = await getDeliveryAccess();
    if (!access.ok || access.viewer.kind !== "client") return { kind: "none" };
    const db = getTursoClient();
    const [projects, tickets] = await Promise.all([
      listProjects(db, access.viewer),
      listTickets(db, access.viewer, { status: "all" }),
    ]);
    return { kind: "client", projects: projects.rows, tickets: tickets.rows };
  } catch (err) {
    // Loud, not an empty section: "no projects" and "could not load" differ.
    // The driver's text goes to the log, not to the client.
    console.error("[client-portal.delivery]", err);
    return { kind: "error" };
  }
}

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

  const [snapshots, delivery] = await Promise.all([
    tenantId ? safe("client-portal.roi", getRecentRoi(tenantId, 30), []) : Promise.resolve([] as RoiSnapshot[]),
    getDeliveryPanel(),
  ]);

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

      {delivery.kind === "error" && <LoadError what="your projects and tickets" />}
      {delivery.kind === "client" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card
            title="Your projects"
            subtitle="Where each project stands, and the latest update we shared."
            action={<Link href="/projects" className="text-xs text-accent hover:underline">All projects</Link>}
          >
            {delivery.projects.length === 0 ? (
              <EmptyState message="No projects are linked to your workspace yet." />
            ) : (
              <ul className="divide-y divide-bg-border">
                {delivery.projects.slice(0, 6).map((p) => (
                  <li key={p.id} className="py-3">
                    <Link href={`/projects/${p.id}`} className="flex items-center justify-between gap-3 hover:text-accent">
                      <span className="truncate text-sm font-semibold">{p.title}</span>
                      <StageTag stage={p.stage} />
                    </Link>
                    <p className="mt-1 line-clamp-2 text-xs text-fg-muted">
                      {p.last_client_update_body
                        ? `${p.last_client_update_body} · ${timeAgo(p.last_client_update_at)}`
                        : "No updates shared yet."}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card
            title="Your tickets"
            subtitle="Support requests and our latest reply."
            action={<a href={SUPPORT_FORM_PATH} className="btn-secondary text-xs">Report an issue</a>}
          >
            {delivery.tickets.length === 0 ? (
              <EmptyState message="No tickets. If something comes up, report it and you will get a ticket number." />
            ) : (
              <ul className="divide-y divide-bg-border">
                {delivery.tickets.slice(0, 6).map((t) => (
                  <li key={t.id} className="py-3">
                    <Link href={`/tickets/${t.id}`} className="flex items-center gap-3 hover:text-accent">
                      <span className="font-mono text-xs text-fg-muted">{t.ticket_number}</span>
                      <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                      <TicketStatusTag status={t.status} />
                    </Link>
                    <p className="mt-1 line-clamp-2 text-xs text-fg-muted">
                      {t.last_public_reply_body
                        ? `Our last reply: ${t.last_public_reply_body} · ${timeAgo(t.last_public_reply_at)}`
                        : `Opened ${timeAgo(t.created_at)}. No reply yet.`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

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
