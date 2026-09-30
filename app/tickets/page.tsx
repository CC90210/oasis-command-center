/**
 * /tickets — Clients › Support desk: the viewer's OWN workspace's desk.
 *
 * Every workspace runs one (lib/delivery/access.ts, relation "desk"): tenant_id
 * is the business, the requester is its customer. The team (owners and admins)
 * sees the queue in four views — Open · Breaching · Waiting on client ·
 * Resolved — with the first-response SLA from lib/delivery/rules.ts, filters,
 * the workspace's public support form, and a form for internal tickets.
 *
 * OASIS's desk is the same page it always was, plus the views. Anyone in
 * another workspace ALSO sees "Your requests to OASIS" — OASIS's desk read as
 * their vendor, exactly as this page showed it before desks existed (and all
 * that a member below owner/admin in a client workspace sees here).
 *
 * An OASIS non-founder gets a 404. A failed read renders as an error, never as
 * an empty queue, and the driver's text reaches OASIS's own team only.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, EmptyState } from "@/components/Card";
import { PageFrame } from "@/components/os/PageFrame";
import { KpiTile } from "@/components/os/KpiTile";
import { CategoryTag, LoadError, SeverityTag, SlaBadge, TicketStatusTag } from "@/components/delivery/badges";
import { TicketCreateForm } from "@/components/delivery/TicketForms";
import { EnableSupportFormButton } from "@/components/os/landings/clients-actions";
import { timeAgo } from "@/lib/fmt";
import { isOasisDesk, type DeliveryViewer } from "@/lib/delivery/access";
import {
  DELIVERY_TENANT_ID,
  TICKET_DESK_VIEWS,
  TICKET_DESK_VIEW_LABELS,
  TICKET_SEVERITIES,
  TICKET_SEVERITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  deskViewQuery,
  isOneOf,
  memberDisplayName,
  slaStatus,
  type SlaState,
  type TicketDeskView,
} from "@/lib/delivery/rules";
import { deliveryAccessFor, getDeliveryDb, loadAssignmentRoster, loadMemberDirectory } from "@/lib/delivery/session";
import { listClientTenants, listProjects, listTickets, type Ticket } from "@/lib/delivery/store";
import { SUPPORT_FORM_PATH } from "@/lib/delivery/support-form";
import { getDeskForm, type DeskFormState } from "@/lib/delivery/desks";
import { loadCustomerOptions, type CustomerOptions } from "@/lib/os/customers/session";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Support desk" };

type Search = {
  view?: string;
  status?: string;
  severity?: string;
  project?: string;
  customer?: string;
  assignee?: string;
  sla?: string;
  q?: string;
};

const SLA_FILTERS: Array<{ value: string; label: string; states: SlaState[] }> = [
  { value: "breached", label: "Breached", states: ["breached"] },
  { value: "at_risk", label: "At risk", states: ["at_risk"] },
  { value: "waiting", label: "Awaiting first reply", states: ["breached", "at_risk", "on_track"] },
];

type FounderViewer = Extract<DeliveryViewer, { kind: "founder" }>;
type ClientViewer = Extract<DeliveryViewer, { kind: "client" }>;

export default async function TicketsPage({ searchParams }: { searchParams?: Promise<Search> }) {
  const surface = await resolveViewerSurface();
  const desk = deliveryAccessFor(surface, "desk");
  const vendor = surface.ok && surface.tenantId !== DELIVERY_TENANT_ID ? deliveryAccessFor(surface, "vendor") : null;
  if (!desk.ok && !vendor?.ok) {
    if (desk.status === 403) notFound();
    return (
      <PageFrame title="Support desk">
        <Card><EmptyState message="Sign in to see your tickets." /></Card>
      </PageFrame>
    );
  }
  const sp = (await searchParams) ?? {};
  const db = getDeliveryDb();
  if (!db) return <LoadError what="tickets" detail="The database is not configured on this deployment." />;
  const vendorViewer = vendor?.ok && vendor.viewer.kind === "client" ? vendor.viewer : null;
  // Every read happens here, before render, so the views below are plain.
  const vendorRequests = vendorViewer ? await loadVendorRequests(db, vendorViewer) : null;

  // A member below owner/admin in a client workspace: OASIS as vendor only.
  if (!desk.ok || desk.viewer.kind !== "founder") {
    return (
      <PageFrame
        title="Support"
        subtitle="Your requests to the OASIS team and where each one stands."
        actions={<a className="btn-primary" href={SUPPORT_FORM_PATH}>Report an issue</a>}
      >
        {vendorRequests && <VendorRequests data={vendorRequests} heading={null} />}
      </PageFrame>
    );
  }

  const data = await loadDesk(db, desk.viewer, surface.ok ? surface.tenantSlug : null, sp);
  return <DeskView data={data} sp={sp} vendorRequests={vendorRequests} />;
}

type DeskData = Awaited<ReturnType<typeof loadDesk>>;

async function loadDesk(
  db: NonNullable<ReturnType<typeof getDeliveryDb>>,
  viewer: FounderViewer,
  tenantSlug: string | null,
  sp: Search,
) {
  const oasis = isOasisDesk(viewer);
  const now = new Date();
  // An explicit status (the filter form, an old link) wins; otherwise the view.
  // An SLA filter with no view (`/tickets?sla=breached`, the link Today and the
  // Client Success department use) keeps its old meaning: every working ticket.
  const view: TicketDeskView | null =
    sp.status || (sp.sla && !sp.view) ? null : isOneOf(TICKET_DESK_VIEWS, sp.view) ? sp.view : "open";
  const viewQuery = view ? deskViewQuery(view) : null;
  const status = sp.status || viewQuery?.status || "open";

  let result: Awaited<ReturnType<typeof listTickets>> | null = null;
  let workingSet: Ticket[] = [];
  let failure: string | null = null;
  let roster: Awaited<ReturnType<typeof loadAssignmentRoster>> = [];
  let directory: Awaited<ReturnType<typeof loadMemberDirectory>> = [];
  let projects: Awaited<ReturnType<typeof listProjects>>["rows"] = [];
  let tenants: Awaited<ReturnType<typeof listClientTenants>> = [];
  let customers: CustomerOptions = { state: "not_set_up" };
  let form: DeskFormState | null = null;
  // The assignee menu's roster fails on its own (OASIS's needs both founders
  // active: lib/team.ts getOasisPipelineAssignmentRoster throws otherwise).
  // The desk still renders; only the menu degrades, with a notice saying why.
  let rosterNotice: string | null = null;
  try {
    const [r, open, ro, dir, pr, te, cu, fo] = await Promise.all([
      listTickets(db, viewer, {
        status,
        severity: sp.severity || null,
        project_id: sp.project || null,
        customer_id: sp.customer || null,
        assignee: sp.assignee || null,
        q: sp.q || null,
      }),
      listTickets(db, viewer, { status: "open" }),
      loadAssignmentRoster(viewer.tenantId).catch((err: unknown) => {
        console.error("[tickets.page.roster]", err);
        rosterNotice = rosterFailureNotice(err);
        return [] as Awaited<ReturnType<typeof loadAssignmentRoster>>;
      }),
      loadMemberDirectory(viewer.tenantId),
      listProjects(db, viewer, { includeArchived: false }),
      oasis ? listClientTenants(db) : Promise.resolve([]),
      loadCustomerOptions(db, viewer.tenantId),
      getDeskForm(db, viewer.tenantId, tenantSlug),
    ]);
    result = r;
    workingSet = open.rows;
    roster = ro;
    directory = dir;
    projects = pr.rows;
    tenants = te;
    customers = cu;
    form = fo;
  } catch (err) {
    console.error("[tickets.page]", err);
    failure = err instanceof Error ? err.message : String(err);
  }

  const slaFilter = SLA_FILTERS.find((f) => f.value === sp.sla) ?? null;
  const rows = (result?.rows ?? [])
    .map((t) => ({ t, sla: slaStatus(t, now) }))
    .filter(({ sla }) => !viewQuery?.breachingOnly || sla.state === "breached")
    .filter(({ sla }) => !slaFilter || slaFilter.states.includes(sla.state));
  const workingSla = workingSet.map((t) => slaStatus(t, now).state);
  const counts = {
    open: workingSet.filter((t) => t.status === "open" || t.status === "in_progress").length,
    breaching: workingSla.filter((s) => s === "breached").length,
    atRisk: workingSla.filter((s) => s === "at_risk").length,
    waiting: workingSet.filter((t) => t.status === "waiting_on_client").length,
    unassigned: workingSet.filter((t) => !t.assigned_to).length,
  };
  const rosterOptions = roster
    .filter((m) => m.auth_user_id)
    .map((m) => ({ value: String(m.auth_user_id).toLowerCase(), label: m.display_name || m.full_name }));
  return {
    oasis,
    view,
    failure,
    truncated: result?.truncated ?? false,
    rows,
    workingCount: workingSet.length,
    counts,
    rosterOptions,
    rosterNotice: rosterNotice as string | null,
    directory,
    projects,
    tenants,
    customers,
    form,
  };
}

/**
 * Why the assignee menu is empty, in words. The incomplete-roster case is
 * OASIS's own (its roster names both founders) and says what to fix; anything
 * else says it failed and was logged.
 */
function rosterFailureNotice(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("oasis_pipeline_assignment_roster_incomplete")) {
    return "Tickets can't be assigned from here right now: the assignment roster needs both founders as active members of this workspace, and one is missing. Everything else on the desk works.";
  }
  return "The assignee list couldn't be loaded, so tickets can't be assigned from here right now. The error has been logged; everything else on the desk works.";
}

function DeskView({ data, sp, vendorRequests }: { data: DeskData; sp: Search; vendorRequests: VendorData | null }) {
  const { oasis, view, failure, rows, counts, rosterOptions, projects, tenants, customers, form } = data;
  const nameOf = (id: string | null) => memberDisplayName(id, data.directory);
  const customerOptions = customers.state === "ok" ? customers.options : [];
  const customerName = new Map(customerOptions.map((c) => [c.value, c.label]));
  const filtered = Boolean(sp.status || sp.severity || sp.project || sp.customer || sp.assignee || sp.sla || sp.q);
  const hrefFor = (v: TicketDeskView) => `/tickets?view=${v}`;
  const workingCount = data.workingCount;

  return (
    <PageFrame
      title="Support desk"
      subtitle={
        failure
          ? "Your customers' requests and the first response each one is owed."
          : `${workingCount} ticket${workingCount === 1 ? "" : "s"} still need${workingCount === 1 ? "s" : ""} the team. First response: critical 1h, high 4h, medium 24h, low 72h.`
      }
      actions={
        <TicketCreateForm
          roster={rosterOptions}
          projects={projects.map((p) => ({ value: p.id, label: p.title, clientTenantId: p.client_tenant_id }))}
          clientTenants={tenants.map((t) => ({ value: t.id, label: t.name }))}
          customers={customerOptions}
        />
      }
    >
      <div className="space-y-6">
        {failure ? (
          // The driver's text is for OASIS's own team, never a client workspace's.
          <LoadError what="tickets" detail={oasis ? failure : undefined} />
        ) : (
          <>
            <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <KpiTile label="Open" value={counts.open} status="live" hint="open or in progress" />
              <KpiTile label="Breaching" value={counts.breaching} status="live" hint="unanswered past target" />
              <KpiTile label="At risk" value={counts.atRisk} status="live" hint="last quarter of the window" />
              <KpiTile label="Waiting on client" value={counts.waiting} status="live" />
              <KpiTile label="Unassigned" value={counts.unassigned} status="live" hint="still need the team" />
            </section>

            <SupportFormCard form={form} oasis={oasis} />

            <nav aria-label="Ticket views" className="flex flex-wrap gap-1 border-b border-hairline">
              {TICKET_DESK_VIEWS.map((v) => {
                const active = view === v;
                const n = v === "open" ? counts.open : v === "breaching" ? counts.breaching : v === "waiting" ? counts.waiting : null;
                return (
                  <Link
                    key={v}
                    href={hrefFor(v)}
                    prefetch={false}
                    aria-current={active ? "page" : undefined}
                    className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${
                      active ? "border-fg font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg"
                    }`}
                  >
                    {TICKET_DESK_VIEW_LABELS[v]}
                    {n !== null && <span className="ml-1.5 tabular-nums text-fg-dim">{n}</span>}
                  </Link>
                );
              })}
            </nav>

            <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
              <label className="w-40">
                <span className="label">Status</span>
                <select name="status" className="select" defaultValue={sp.status ?? ""}>
                  <option value="">{view ? `As the ${TICKET_DESK_VIEW_LABELS[view]} view` : "Open (all working)"}</option>
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
              {customerOptions.length > 0 && (
                <label className="w-48">
                  <span className="label">Client</span>
                  <select name="customer" className="select" defaultValue={sp.customer ?? ""}>
                    <option value="">Any</option>
                    {customerOptions.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </label>
              )}
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
              {view && <input type="hidden" name="view" value={view} />}
              <button type="submit" className="btn-secondary">Apply</button>
              {filtered && <Link href={view ? hrefFor(view) : "/tickets"} className="pb-2 text-sm text-fg-muted hover:text-fg">Clear</Link>}
            </form>

            {data.rosterNotice && (
              <p role="status" className="rounded-xl border border-status-warm/30 px-4 py-3 text-[13px] text-status-warm">
                {data.rosterNotice}
              </p>
            )}
            {customers.state === "error" && (
              <p role="alert" className="text-[13px] text-status-warm">
                Couldn&rsquo;t load your client records, so tickets are shown without their client. The error has been logged.
              </p>
            )}
            {data.truncated && (
              <p className="text-sm text-status-warm">Showing the first 500 tickets. Narrow the filters to see the rest.</p>
            )}

            {rows.length === 0 ? (
              <Card>
                <EmptyState
                  message={
                    filtered
                      ? "No tickets match these filters."
                      : view === "breaching"
                        ? "Nothing is past its first-response target."
                        : view === "waiting"
                          ? "No tickets are waiting on a client."
                          : view === "resolved"
                            ? "No resolved tickets yet."
                            : "No open tickets."
                  }
                />
              </Card>
            ) : (
              <Card noPadding>
                <div className="hidden grid-cols-[6rem_1fr_7rem_9rem_11rem_8rem] gap-3 border-b border-hairline px-5 py-2.5 text-xs font-medium text-fg-dim lg:grid">
                  <span>Ticket</span>
                  <span>Subject</span>
                  <span>Severity</span>
                  <span>Status</span>
                  <span>First response</span>
                  <span>Assignee</span>
                </div>
                <ul className="divide-y divide-hairline">
                  {rows.map(({ t, sla }) => (
                    <li key={t.id}>
                      <Link
                        href={`/tickets/${t.id}`}
                        prefetch={false}
                        className={`grid gap-2 px-5 py-3.5 hover:bg-active-hover lg:grid-cols-[6rem_1fr_7rem_9rem_11rem_8rem] lg:items-center lg:gap-3 ${
                          sla.state === "breached" ? "border-l-2 border-status-hot" : ""
                        }`}
                      >
                        <span className="font-mono text-xs text-fg-muted">{t.ticket_number}</span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm text-fg">{t.title}</span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-fg-dim">
                            <span className="truncate">
                              {(t.customer_id && customerName.get(t.customer_id)) ||
                                t.client_tenant_name ||
                                t.client_company ||
                                t.client_name ||
                                t.client_email ||
                                "No client"}
                            </span>
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

        {vendorRequests && <VendorRequests data={vendorRequests} heading="Your requests to OASIS" />}
      </div>
    </PageFrame>
  );
}

/** The workspace's public support form: where it is, or how to turn it on. */
function SupportFormCard({ form, oasis }: { form: DeskFormState | null; oasis: boolean }) {
  if (!form) return null;
  const body = (() => {
    switch (form.state) {
      case "on":
        return (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-fg">
                Customers file tickets at{" "}
                <a className="font-mono text-[13px] text-fg underline decoration-hairline underline-offset-2" href={form.path} target="_blank" rel="noreferrer">
                  {form.path}
                </a>
                {!form.enabled && <span className="ml-2 text-status-warm">(switched off in Forms)</span>}
              </p>
              <p className="mt-0.5 text-[13px] text-fg-muted">
                {oasis
                  ? "Every request becomes a ticket with a number, an SLA and a confirmation email."
                  : "Every request becomes a ticket on this desk, linked to the client whose email it came from. No confirmation email is sent until a mailbox is connected."}
              </p>
            </div>
            <a className="btn-secondary" href={form.path} target="_blank" rel="noreferrer">Open form</a>
          </div>
        );
      case "off":
        return (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-fg-muted">
              Give your customers a public support form. Every request becomes a ticket here, never a lead.
            </p>
            <EnableSupportFormButton />
          </div>
        );
      case "slug_taken":
        return (
          <p className="text-sm text-fg-muted">
            This workspace already has a form at <span className="font-mono">/support</span> that creates leads. Rename it in
            Forms, then come back to turn the support form on.
          </p>
        );
      case "unavailable":
        return (
          <p className="text-sm text-status-warm">
            The public support form is not set up in this database yet (migration bravo__188). Tickets you file here still work.
          </p>
        );
    }
  })();
  return <div className="rounded-xl border border-hairline bg-bg-panel px-4 py-3">{body}</div>;
}

type VendorData = { tickets: Ticket[]; failed: boolean };

/** OASIS's desk read as the viewer's vendor: their workspace's requests, client-safe. */
async function loadVendorRequests(db: NonNullable<ReturnType<typeof getDeliveryDb>>, viewer: ClientViewer): Promise<VendorData> {
  try {
    return { tickets: (await listTickets(db, viewer, { status: "all" })).rows, failed: false };
  } catch (err) {
    console.error("[tickets.page.client]", err);
    return { tickets: [], failed: true };
  }
}

function VendorRequests({ data, heading }: { data: VendorData; heading: string | null }) {
  const { tickets, failed } = data;
  return (
    <section className="space-y-3">
      {heading && (
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-fg">{heading}</h2>
            <p className="text-[13px] text-fg-muted">What your workspace has asked the OASIS team for, and where each one stands.</p>
          </div>
          <a className="btn-secondary" href={SUPPORT_FORM_PATH}>Report an issue to OASIS</a>
        </div>
      )}
      {failed ? (
        <LoadError what="your tickets" />
      ) : tickets.length === 0 ? (
        <Card><EmptyState message="No tickets yet. If something comes up, report it and you will get a ticket number." /></Card>
      ) : (
        <Card noPadding>
          <ul className="divide-y divide-hairline">
            {tickets.map((t) => (
              <li key={t.id}>
                <Link href={`/tickets/${t.id}`} prefetch={false} className="flex flex-col gap-1 px-5 py-3.5 hover:bg-active-hover sm:flex-row sm:items-center sm:gap-3">
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
    </section>
  );
}
