/**
 * /tickets — the support queue.
 *
 * Founders: every ticket in the OASIS workspace with its first-response SLA,
 * filters (status, severity, project, assignee, SLA, search) and a form for
 * internal tickets. Clients: their own workspace's tickets and a link to the
 * support form.
 *
 * Access is lib/delivery/access.ts; an OASIS non-founder gets a 404. A failed
 * read renders as an error, never as an empty queue.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, EmptyState, PageHeader, Stat } from "@/components/Card";
import { CategoryTag, LoadError, SeverityTag, SlaBadge, TicketStatusTag } from "@/components/delivery/badges";
import { TicketCreateForm } from "@/components/delivery/TicketForms";
import { timeAgo } from "@/lib/fmt";
import {
  TICKET_SEVERITIES,
  TICKET_SEVERITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  memberDisplayName,
  slaStatus,
  type SlaState,
} from "@/lib/delivery/rules";
import { getDeliveryAccess, getDeliveryDb, loadAssignmentRoster, loadMemberDirectory } from "@/lib/delivery/session";
import { listClientTenants, listProjects, listTickets, type Ticket } from "@/lib/delivery/store";
import { SUPPORT_FORM_PATH } from "@/lib/delivery/support-form";

export const dynamic = "force-dynamic";

type Search = { status?: string; severity?: string; project?: string; assignee?: string; sla?: string; q?: string };

const SLA_FILTERS: Array<{ value: string; label: string; states: SlaState[] }> = [
  { value: "breached", label: "Breached", states: ["breached"] },
  { value: "at_risk", label: "At risk", states: ["at_risk"] },
  { value: "waiting", label: "Awaiting first reply", states: ["breached", "at_risk", "on_track"] },
];

export default async function TicketsPage({ searchParams }: { searchParams?: Promise<Search> }) {
  const access = await getDeliveryAccess();
  if (!access.ok) {
    if (access.status === 403) notFound();
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader title="Support" />
        <Card><EmptyState message="Sign in to see your tickets." /></Card>
      </div>
    );
  }
  const viewer = access.viewer;
  const sp = (await searchParams) ?? {};
  const db = getDeliveryDb();
  if (!db) return <LoadError what="tickets" detail="The database is not configured on this deployment." />;
  const now = new Date();

  // ── client view ─────────────────────────────────────────────────────────
  if (viewer.kind === "client") {
    let tickets: Ticket[] = [];
    let failure: string | null = null;
    try {
      tickets = (await listTickets(db, viewer, { status: "all" })).rows;
    } catch (err) {
      console.error("[tickets.page.client]", err);
      failure = err instanceof Error ? err.message : String(err);
    }
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader
          title="Support"
          subtitle="Your requests to the OASIS team and where each one stands."
          action={<a className="btn-primary" href={SUPPORT_FORM_PATH}>Report an issue</a>}
        />
        {failure ? (
          <LoadError what="your tickets" />
        ) : tickets.length === 0 ? (
          <Card><EmptyState message="No tickets yet. If something comes up, report it and you will get a ticket number." /></Card>
        ) : (
          <Card noPadding>
            <ul className="divide-y divide-bg-border">
              {tickets.map((t) => (
                <li key={t.id}>
                  <Link href={`/tickets/${t.id}`} className="flex flex-col gap-1 px-5 py-3.5 hover:bg-bg-hover sm:flex-row sm:items-center sm:gap-3">
                    <span className="font-mono text-xs text-fg-muted">{t.ticket_number}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">{t.title}</span>
                    <TicketStatusTag status={t.status} />
                    <span className="text-xs text-fg-dim sm:w-44 sm:text-right">
                      {t.last_public_reply_at ? `Last reply ${timeAgo(t.last_public_reply_at)}` : `Opened ${timeAgo(t.created_at)}`}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    );
  }

  // ── founder view ────────────────────────────────────────────────────────
  const status = sp.status || "open";
  let result: Awaited<ReturnType<typeof listTickets>> | null = null;
  let openSet: Ticket[] = [];
  let failure: string | null = null;
  let roster: Awaited<ReturnType<typeof loadAssignmentRoster>> = [];
  let directory: Awaited<ReturnType<typeof loadMemberDirectory>> = [];
  let projects: Awaited<ReturnType<typeof listProjects>>["rows"] = [];
  let tenants: Awaited<ReturnType<typeof listClientTenants>> = [];
  try {
    const [r, open, ro, dir, pr, te] = await Promise.all([
      listTickets(db, viewer, {
        status,
        severity: sp.severity || null,
        project_id: sp.project || null,
        assignee: sp.assignee || null,
        q: sp.q || null,
      }),
      listTickets(db, viewer, { status: "open" }),
      loadAssignmentRoster(),
      loadMemberDirectory(),
      listProjects(db, viewer, { includeArchived: false }),
      listClientTenants(db),
    ]);
    result = r;
    openSet = open.rows;
    roster = ro;
    directory = dir;
    projects = pr.rows;
    tenants = te;
  } catch (err) {
    console.error("[tickets.page]", err);
    failure = err instanceof Error ? err.message : String(err);
  }
  const slaFilter = SLA_FILTERS.find((f) => f.value === sp.sla) ?? null;
  const rows = (result?.rows ?? [])
    .map((t) => ({ t, sla: slaStatus(t, now) }))
    .filter(({ sla }) => !slaFilter || slaFilter.states.includes(sla.state));
  const openSla = openSet.map((t) => slaStatus(t, now).state);
  const rosterOptions = roster
    .filter((m) => m.auth_user_id)
    .map((m) => ({ value: String(m.auth_user_id).toLowerCase(), label: m.display_name || m.full_name }));
  const nameOf = (id: string | null) => memberDisplayName(id, directory);
  const filtered = Boolean(sp.status || sp.severity || sp.project || sp.assignee || sp.sla || sp.q);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Tickets"
        subtitle={`${openSet.length} open ticket${openSet.length === 1 ? "" : "s"}. First response: critical 1h, high 4h, medium 24h, low 72h.`}
        action={
          <div className="flex flex-wrap items-center gap-3">
            <a className="btn-secondary" href={SUPPORT_FORM_PATH} target="_blank" rel="noreferrer">Client support form</a>
            <TicketCreateForm
              roster={rosterOptions}
              projects={projects.map((p) => ({ value: p.id, label: p.title, clientTenantId: p.client_tenant_id }))}
              clientTenants={tenants.map((t) => ({ value: t.id, label: t.name }))}
            />
          </div>
        }
      />

      {failure ? (
        <LoadError what="tickets" detail={failure} />
      ) : (
        <>
          <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Open" value={openSet.length} accent />
            <Stat label="SLA breached" value={openSla.filter((s) => s === "breached").length} hint="unanswered past target" />
            <Stat label="At risk" value={openSla.filter((s) => s === "at_risk").length} hint="last quarter of the window" />
            <Stat label="Unassigned" value={openSet.filter((t) => !t.assigned_to).length} />
          </section>

          <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-bg-border bg-bg-panel p-4">
            <label className="w-40">
              <span className="label">Status</span>
              <select name="status" className="select" defaultValue={status}>
                <option value="open">Open (all working)</option>
                <option value="closed">Resolved + closed</option>
                <option value="all">All</option>
                {TICKET_STATUSES.map((s) => (
                  <option key={s} value={s}>{TICKET_STATUS_LABELS[s]}</option>
                ))}
              </select>
            </label>
            <label className="w-36">
              <span className="label">Severity</span>
              <select name="severity" className="select" defaultValue={sp.severity ?? ""}>
                <option value="">Any</option>
                {TICKET_SEVERITIES.map((s) => (
                  <option key={s} value={s}>{TICKET_SEVERITY_LABELS[s]}</option>
                ))}
              </select>
            </label>
            <label className="w-44">
              <span className="label">Project</span>
              <select name="project" className="select" defaultValue={sp.project ?? ""}>
                <option value="">Any</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
            </label>
            <label className="w-40">
              <span className="label">Assignee</span>
              <select name="assignee" className="select" defaultValue={sp.assignee ?? ""}>
                <option value="">Anyone</option>
                <option value="unassigned">Unassigned</option>
                {rosterOptions.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </label>
            <label className="w-44">
              <span className="label">SLA</span>
              <select name="sla" className="select" defaultValue={sp.sla ?? ""}>
                <option value="">Any</option>
                {SLA_FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </label>
            <label className="min-w-[10rem] flex-1">
              <span className="label">Search</span>
              <input name="q" className="input" defaultValue={sp.q ?? ""} placeholder="T-0012, title, client" />
            </label>
            <button type="submit" className="btn-secondary">Apply</button>
            {filtered && <Link href="/tickets" className="pb-2 text-sm text-fg-muted hover:text-fg">Clear</Link>}
          </form>

          {result?.truncated && (
            <p className="text-sm text-status-warm">Showing the first 500 tickets. Narrow the filters to see the rest.</p>
          )}

          {rows.length === 0 ? (
            <Card><EmptyState message={filtered ? "No tickets match these filters." : "No open tickets."} /></Card>
          ) : (
            <Card noPadding>
              <div className="hidden grid-cols-[6rem_1fr_7rem_9rem_11rem_8rem] gap-3 border-b border-bg-border px-5 py-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-dim lg:grid">
                <span>Ticket</span>
                <span>Subject</span>
                <span>Severity</span>
                <span>Status</span>
                <span>First response</span>
                <span>Assignee</span>
              </div>
              <ul className="divide-y divide-bg-border">
                {rows.map(({ t, sla }) => (
                  <li key={t.id}>
                    <Link
                      href={`/tickets/${t.id}`}
                      className={`grid gap-2 px-5 py-3.5 hover:bg-bg-hover lg:grid-cols-[6rem_1fr_7rem_9rem_11rem_8rem] lg:items-center lg:gap-3 ${
                        sla.state === "breached" ? "border-l-2 border-status-hot" : ""
                      }`}
                    >
                      <span className="font-mono text-xs text-fg-muted">{t.ticket_number}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-fg">{t.title}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-fg-dim">
                          <span className="truncate">{t.client_tenant_name || t.client_company || t.client_name || t.client_email || "No client"}</span>
                          {t.project_title && <span className="truncate">· {t.project_title}</span>}
                          <CategoryTag category={t.category} />
                          <span>· {timeAgo(t.created_at)}</span>
                        </span>
                      </span>
                      <span><SeverityTag severity={t.severity} /></span>
                      <span><TicketStatusTag status={t.status} /></span>
                      <span><SlaBadge sla={sla} /></span>
                      <span className="truncate text-xs text-fg-muted">{nameOf(t.assigned_to) ?? "Unassigned"}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
