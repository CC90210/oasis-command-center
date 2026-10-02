/**
 * /clients/[id] layout: one client's header and tab bar, read ONCE per record.
 *
 * The header (name, health badge, status, owner, the deal it came from, New
 * ticket, Mark engagement ended) and the tab bar live here, not in the page.
 * Next does not render a layout again when only the query changes, so a tab
 * click (?tab=...) re-renders only the tab below it (page.tsx) instead of the
 * record, the team directory and the desk roster every time (CC, 2026-10-01:
 * "I'm still unable to click the actual subbed things inside the clients
 * portal").
 *
 * The tabs are the ones this workspace's record can show something on
 * (clientTabsFor: no Money outside OASIS's books, no Usage outside OASIS's
 * workspace). The bar reads the current tab from the address bar
 * (components/os/OsTabBar.tsx `param`), with the page's own rule: a missing or
 * unknown ?tab= is Overview.
 *
 * GATE, first statement: requireOsRoute("/clients"), the same rule as the
 * list. The page asks it again for itself: a tab switch renders the page
 * alone. A client of another workspace is a 404, the same as no client at all.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { Tag } from "@/components/Card";
import { PageFrame } from "@/components/os/PageFrame";
import { OsTabBar } from "@/components/os/OsTabBar";
import { LoadError } from "@/components/delivery/badges";
import { TicketCreateForm } from "@/components/delivery/TicketForms";
import { requireOsRoute } from "@/components/os/landings/page-gate";
import { clientTabsFor, loadClientHeader, loadWorkspaceDirectory, ownerName } from "@/components/os/landings/clients-records-data";
import { EndEngagementButton } from "@/components/os/landings/clients-actions";
import { WriteToClientLink } from "@/components/os/landings/client-conversations";
import { ClientHealthBadge } from "@/components/os/landings/client-health-badge";
import { clientsViewerFromSurface, type ClientsViewer } from "@/lib/os/customers/session";
import { CUSTOMER_LIFECYCLE_LABELS } from "@/lib/os/customers/rules";
import { mayOpenOsHref } from "@/lib/os/nav";
import { loadAssignmentRoster } from "@/lib/delivery/session";
import type { MemberRow } from "@/lib/team";

export const dynamic = "force-dynamic";

/**
 * The desk's assignment roster for "New ticket". A failure does not hide the
 * form: it renders with no assignee choices and a notice says why (OASIS's
 * roster needs both founders active, lib/team.ts).
 */
async function deskRoster(viewer: ClientsViewer): Promise<{ rows: MemberRow[]; notice: string | null } | null> {
  if (!viewer.desk) return null;
  try {
    return { rows: await loadAssignmentRoster(viewer.tenantId), notice: null };
  } catch (err) {
    console.error("[os.clients.record.roster]", err);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      rows: [],
      notice: msg.includes("oasis_pipeline_assignment_roster_incomplete")
        ? "New tickets can't be assigned from here right now: the assignment roster needs both founders as active members."
        : "The assignee list couldn't be loaded, so new tickets start unassigned. The error has been logged.",
    };
  }
}

export default async function ClientRecordLayout({ params, children }: { params: Promise<{ id: string }>; children: ReactNode }) {
  const viewer = await requireOsRoute("/clients");
  const { id } = await params;
  const cv = clientsViewerFromSurface(viewer.surface)!;
  const [header, directory, roster] = await Promise.all([loadClientHeader(cv, id), loadWorkspaceDirectory(cv.tenantId), deskRoster(cv)]);

  if (header.state === "not_set_up") {
    // The reason is in the log (clients-records-data.ts attempt), not on the screen.
    return (
      <PageFrame title="Client">
        <p role="status" className="rounded-xl border border-status-warm/30 px-4 py-3 text-[13px] text-status-warm">
          Client records aren&rsquo;t available right now. The error has been logged.
        </p>
      </PageFrame>
    );
  }
  if (header.state === "error") {
    return (
      <PageFrame title="Client">
        <LoadError what="this client" />
      </PageFrame>
    );
  }
  if (header.state !== "ok" || !header.value) notFound();
  const { customer: c, projects, health } = header.value;
  const canOpen = (href: string) => mayOpenOsHref(viewer.navInput, href);
  const owner = ownerName(c.owner_user_id, directory);
  const subtitle = [
    c.company_name && c.company_name !== c.display_name ? c.company_name : null,
    CUSTOMER_LIFECYCLE_LABELS[c.lifecycle],
    owner ? `Owner: ${owner}` : c.owner_user_id ? null : "No owner",
  ]
    .filter(Boolean)
    .join(" · ");
  // A deal in OASIS's pipeline opens at /pipeline/<id>; another workspace's
  // lead page lives in its own manifest, so the deal is named, not linked.
  const dealHref = c.source_lead_id && cv.oasis ? `/pipeline/${c.source_lead_id}` : null;

  return (
    <PageFrame
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          {c.display_name}
          {cv.desk && <ClientHealthBadge health={health} />}
          {c.archived_at && <Tag>Archived</Tag>}
        </span>
      }
      subtitle={subtitle}
      actions={
        <>
          <Link href="/clients" prefetch={false} className="btn-secondary">
            All clients
          </Link>
          {dealHref && canOpen("/pipeline") && (
            <Link href={dealHref} prefetch={false} className="btn-secondary">
              Open the deal
            </Link>
          )}
          {cv.desk && <WriteToClientLink customerId={c.id} />}
          {cv.canWrite && c.lifecycle !== "churned" && <EndEngagementButton customerId={c.id} clientName={c.display_name} />}
          {cv.desk && cv.desk.canAct && roster && (
            <TicketCreateForm
              roster={roster.rows
                .filter((m) => m.auth_user_id)
                .map((m) => ({ value: String(m.auth_user_id).toLowerCase(), label: m.display_name || m.full_name }))}
              projects={projects.state === "ok" ? projects.value.rows.map((p) => ({ value: p.id, label: p.title, clientTenantId: p.client_tenant_id })) : []}
              clientTenants={[]}
              customers={[{ value: c.id, label: c.display_name }]}
              initialCustomerId={c.id}
            />
          )}
        </>
      }
    >
      <div className="space-y-6">
        {roster?.notice && (
          <p role="status" className="rounded-xl border border-status-warm/30 px-4 py-3 text-[13px] text-status-warm">
            {roster.notice}
          </p>
        )}
        {/* Each tab is a server render of the page below; the bar answers the
            click at once and shows the wait (components/os/OsTabBar.tsx). */}
        <OsTabBar
          label="Client record"
          param="tab"
          tabs={clientTabsFor(cv).map((t) => ({
            key: t.key,
            label: t.label,
            href: t.key === "overview" ? `/clients/${c.id}` : `/clients/${c.id}?tab=${t.key}`,
          }))}
        />
        {children}
      </div>
    </PageFrame>
  );
}
