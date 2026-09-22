import { Card, PageHeader, Stat, Tag, EmptyState } from "@/components/Card";
import { getActiveProfile } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";
import { timeAgo } from "@/lib/fmt";

export const dynamic = "force-dynamic";

const SEVERITY_COLORS: Record<string, string> = {
  low: "bg-slate-500/20 text-slate-400",
  medium: "bg-blue-500/20 text-blue-400",
  high: "bg-amber-500/20 text-amber-400",
  critical: "bg-red-500/20 text-red-400",
};

const STATUS_COLORS: Record<string, string> = {
  open: "bg-red-500/20 text-red-400",
  investigating: "bg-amber-500/20 text-amber-400",
  resolved: "bg-green-500/20 text-green-400",
  closed: "bg-slate-500/20 text-slate-400",
};

type Ticket = {
  id: string;
  tenant_id: string;
  reporter_id: string | null;
  title: string;
  description: string | null;
  severity: string;
  status: string;
  assigned_to: string | null;
  resolution: string | null;
  sla_target: string | null;
  created_at: string;
  resolved_at: string | null;
  comment_count: number;
};

async function getTickets(tenantId?: string): Promise<Ticket[]> {
  if (!tursoConfigured()) return [];
  try {
    const db = getTursoClient();
    const tenantFilter = tenantId ? "WHERE t.tenant_id = ?" : "";
    const args = tenantId ? [tenantId] : [];
    const r = await db.execute({
      sql: `SELECT t.*,
                   COUNT(c.id) as comment_count
            FROM support_tickets t
            LEFT JOIN ticket_comments c ON c.ticket_id = t.id
              AND (c.is_internal = 0 ${tenantId ? "" : "OR 1=1"})
            ${tenantFilter}
            GROUP BY t.id
            ORDER BY
              CASE t.status
                WHEN 'open' THEN 0
                WHEN 'investigating' THEN 1
                WHEN 'resolved' THEN 2
                ELSE 3
              END,
              CASE t.severity
                WHEN 'critical' THEN 0
                WHEN 'high'     THEN 1
                WHEN 'medium'   THEN 2
                ELSE 3
              END,
              t.created_at DESC`,
      args,
    });
    return r.rows.map((row) => ({
      id: String(row.id ?? ""),
      tenant_id: String(row.tenant_id ?? ""),
      reporter_id: row.reporter_id ? String(row.reporter_id) : null,
      title: String(row.title ?? ""),
      description: row.description ? String(row.description) : null,
      severity: String(row.severity ?? "medium"),
      status: String(row.status ?? "open"),
      assigned_to: row.assigned_to ? String(row.assigned_to) : null,
      resolution: row.resolution ? String(row.resolution) : null,
      sla_target: row.sla_target ? String(row.sla_target) : null,
      created_at: String(row.created_at ?? ""),
      resolved_at: row.resolved_at ? String(row.resolved_at) : null,
      comment_count: Number(row.comment_count ?? 0),
    }));
  } catch {
    return [];
  }
}

function TicketRow({ ticket, showTenant }: { ticket: Ticket; showTenant: boolean }) {
  const isBreached =
    ticket.sla_target &&
    ticket.status !== "resolved" &&
    ticket.status !== "closed" &&
    new Date(ticket.sla_target) < new Date();

  return (
    <div
      className={`p-4 bg-bg-elev rounded-lg border transition-colors ${
        isBreached
          ? "border-red-500/50 bg-red-500/5"
          : "border-bg-border hover:border-accent/30"
      }`}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-sm truncate">{ticket.title}</h3>
          {ticket.description && (
            <p className="text-xs text-fg-muted mt-1 line-clamp-2">
              {ticket.description}
            </p>
          )}
        </div>
        <div className="flex gap-1.5 shrink-0">
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
              SEVERITY_COLORS[ticket.severity] || SEVERITY_COLORS.medium
            }`}
          >
            {ticket.severity}
          </span>
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
              STATUS_COLORS[ticket.status] || STATUS_COLORS.open
            }`}
          >
            {ticket.status}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 text-[10px] text-fg-muted">
        {showTenant && (
          <span className="font-mono">{ticket.tenant_id.slice(0, 8)}</span>
        )}
        <span>{timeAgo(ticket.created_at)}</span>
        {ticket.comment_count > 0 && (
          <span>{ticket.comment_count} comment{ticket.comment_count !== 1 ? "s" : ""}</span>
        )}
        {ticket.assigned_to && (
          <span>→ {ticket.assigned_to}</span>
        )}
        {isBreached && (
          <span className="text-red-400 font-bold">⚠ SLA BREACHED</span>
        )}
      </div>
    </div>
  );
}

export default async function TicketsPage() {
  const profile = await safe("tickets.profile", getActiveProfile(), null);
  const surface = await resolveViewerSurface();
  const isFounder = surface.ok && surface.capabilities.canSeeSystemSurfaces;

  const tenantId = isFounder ? undefined : profile?.tenant_id || "";
  const tickets = await safe("tickets.list", getTickets(tenantId), []);

  const openCount = tickets.filter(
    (t) => t.status === "open" || t.status === "investigating",
  ).length;
  const breachedCount = tickets.filter(
    (t) =>
      t.sla_target &&
      t.status !== "resolved" &&
      t.status !== "closed" &&
      new Date(t.sla_target) < new Date(),
  ).length;
  const resolvedCount = tickets.filter(
    (t) => t.status === "resolved" || t.status === "closed",
  ).length;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title={isFounder ? "Tickets" : "Support"}
        subtitle={
          isFounder
            ? `${openCount} open ticket${openCount !== 1 ? "s" : ""} across all clients.`
            : "Report an issue or check the status of an existing ticket."
        }
      />

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Open" value={openCount} accent />
        <Stat label="Resolved" value={resolvedCount} />
        <Stat label="Total" value={tickets.length} />
        {isFounder && (
          <Stat
            label="SLA Breached"
            value={breachedCount}
            hint={breachedCount > 0 ? "needs attention" : undefined}
          />
        )}
      </section>

      {tickets.length === 0 ? (
        <Card title="No tickets">
          <EmptyState
            message={
              isFounder
                ? "No support tickets have been submitted yet."
                : "No issues to report? Great! If something comes up, submit a ticket here."
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {tickets.map((ticket) => (
            <TicketRow
              key={ticket.id}
              ticket={ticket}
              showTenant={!!isFounder}
            />
          ))}
        </div>
      )}
    </div>
  );
}
