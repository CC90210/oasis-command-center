/**
 * /team/<dept> — a department tab (OASIS OS, design doc §(b)).
 *
 * Chief of Staff · Sales · Marketing · Client Success · Finance · Operations.
 * Each is the same frame: the department's channel (its lead AI teammate) and
 * an Overview panel of real numbers, routines, connections and suggested asks.
 *
 * THE GATE IS THE RAIL'S. departmentGate asks mayOpenOsHref (lib/os/nav.ts)
 * with the input the layout builds, so the page opens exactly when the rail
 * draws its row. Finance therefore needs module finance + an owner + OASIS's
 * company money, the same rule as Money; Operations needs an owner/admin;
 * Client Success follows lib/delivery/access.ts. Everything else 404s — and an
 * unknown department 404s the same way, so the response confirms nothing.
 *
 * The gate runs FIRST, before any read: a tab a viewer may not open never
 * fetches its numbers.
 *
 * `?q=` prefills the channel's message box (Today's Ask composer hands off
 * here). It is never sent on the viewer's behalf.
 *
 * app/team/page.tsx (Settings › Team, the human roster) is a separate route
 * and is untouched by this one.
 */

import { notFound } from "next/navigation";
import { Card, EmptyState } from "@/components/Card";
import { PageFrame } from "@/components/os/PageFrame";
import { departmentChannelFor, departmentProfile, suggestedAsksFor } from "@/components/os/department/config";
import { resolveChannelState } from "@/components/os/department/channel";
import { DepartmentTab } from "@/components/os/department/DepartmentTab";
import { departmentGate } from "@/components/os/department/gate";
import { loadDepartmentNumbers } from "@/components/os/department/numbers";
import { routinesForDepartment } from "@/components/os/department/routine-rules";
import { loadTenantRoutines } from "@/components/os/department/routines";
import { statusFor } from "@/components/os/department/StatusPill";
import { resolveOsViewer } from "@/components/os/department/viewer";
import { ASK_PREFILL_PARAM } from "@/components/os/today/ask";
import { loadPendingApprovals } from "@/components/os/approvals/load";
import { departmentBySlug } from "@/lib/os/departments";
import { mayOpenOsHref } from "@/lib/os/nav";
import { approvalScopeFromViewer } from "@/lib/os/approvals/scope";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { loadSlackPresence, slackHomeFor } from "@/lib/slack/status";
import { loadConnectorFacts } from "@/components/os/connections/connector-facts";
import { connectorBySlug, connectorHref, resolveConnectorStatus } from "@/lib/os/connectors";

export const dynamic = "force-dynamic";

/** A draft longer than this is not a question; it is truncated, not refused. */
const MAX_PREFILL_CHARS = 2000;
/** Approval cards in the Overview panel's Needs you (design doc §(b): top 3). */
const OVERVIEW_APPROVALS_SHOWN = 3;
const FEED_HREF = "/feed";

type Params = { dept: string };
type Search = { [ASK_PREFILL_PARAM]?: string | string[] };

export default async function DepartmentPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams?: Promise<Search>;
}) {
  const { dept: slug } = await params;
  const viewer = await resolveOsViewer();
  if (!viewer.ok) {
    if (viewer.reason === "signed_out" || !departmentBySlug(slug)) notFound();
    // The workspace could not be read. Guessing would mean treating an OASIS
    // founder as a stranger (no Finance, the wrong channel), so say so.
    return (
      <PageFrame title="Department unavailable" subtitle="We could not confirm which workspace you are in.">
        <Card>
          <EmptyState message="Refresh to try again. Nothing was shown in place of the real numbers." />
        </Card>
      </PageFrame>
    );
  }

  const dept = departmentGate(slug, viewer.navInput);
  if (!dept) notFound();

  const sp = (await searchParams) ?? {};
  const q = sp[ASK_PREFILL_PARAM];
  const rawQ = typeof q === "string" ? q.trim() : "";
  const prefill = rawQ ? rawQ.slice(0, MAX_PREFILL_CHARS) : null;

  const binding = departmentChannelFor(dept.key, { oasis: viewer.oasis, manifest: viewer.manifest });
  const tenantId = viewer.surface.tenantId;
  const profile = departmentProfile(dept.key);
  // Connections are workspace configuration: owners and admins, the same rule
  // as the rail footer's Connections door. Only they get each app's status.
  const canManageConnections = viewer.surface.persona === "founder";
  // Routines feed both the panel and the Operations / Chief of Staff numbers:
  // read once, shared, while the channel check runs beside them.
  const routinesRead = loadTenantRoutines(tenantId);
  const [channel, routines, numbers, approvals, slackPresence, connectorFacts] = await Promise.all([
    resolveChannelState(dept, viewer),
    routinesRead,
    routinesRead.then((r) => loadDepartmentNumbers(dept, viewer, r)),
    // This department's approvals waiting on THIS viewer: the session's
    // workspace, and only if the viewer is seated in this department
    // (lib/os/approvals/rules.ts DEPARTMENT_SEATS; owners/admins see all).
    // Chief of Staff answers for the whole workspace, as Today does, so its
    // cards are every department's — the same approvals its count includes.
    loadPendingApprovals({
      scope: approvalScopeFromViewer({ surface: viewer.surface, navInput: viewer.navInput }),
      tenantSlug: viewer.surface.tenantSlug,
      department: dept.key === "chief_of_staff" ? null : dept.key,
      limit: OVERVIEW_APPROVALS_SHOWN,
    }),
    // Where this department lives in Slack (lib/slack/status.ts).
    loadSlackPresence(tursoConfigured() ? getTursoClient() : null, tenantId),
    // Each app's status, from the facts Settings > Connections reads.
    canManageConnections && profile.connections.length > 0
      ? loadConnectorFacts({ tenantId, userId: viewer.surface.userId })
      : Promise.resolve(null),
  ]);
  const nowMs = Date.now();
  const apps = profile.connections.map((app) => {
    const def = connectorBySlug(app.connector);
    return {
      label: app.label,
      href: connectorHref(app.connector),
      status: connectorFacts && def ? resolveConnectorStatus(def, connectorFacts, nowMs) : null,
    };
  });

  const deptRoutines = routines.ok
    ? {
        ok: true as const,
        value: routinesForDepartment(routines.value, dept.key, binding.kind === "agent" ? [binding.agentSlug] : []),
      }
    : routines;
  // Pending approvals are an exact COUNT(*); an attention item from a capped
  // read makes the total a floor, and so does an approvals read that failed:
  // it added 0 for a number nobody knows.
  // Chief of Staff carries its own total: Today's (numbers.ts, needsYouTotal
  // over the shared Needs-you reads, approvals included), so the tab and
  // Today's card can never print different answers for the same moment.
  const needsYou = numbers.needsYou
    ? numbers.needsYou.total
    : numbers.attention.reduce((sum, item) => sum + item.count, 0) + (approvals.ok ? approvals.value.total : 0);
  // Any floor in the sum makes the total a floor too. A floor of 0 is not
  // "nothing waiting", so the header cannot say Working (statusFor).
  const needsYouCapped = numbers.needsYou
    ? numbers.needsYou.capped
    : numbers.attention.some((item) => item.capped === true) || !approvals.ok;

  return (
    <DepartmentTab
      dept={dept}
      purpose={profile.purpose}
      // Only a channel KNOWN to be unconnected drops the counts: an AI account
      // that could not be checked says nothing about what is waiting, so the
      // counts still decide and the header keeps a real "Needs you"
      // (StatusPill.tsx headerStatus).
      status={statusFor(channel.kind !== "not_connected", needsYou, needsYouCapped)}
      channel={channel}
      prefill={prefill}
      overview={{
        attention: numbers.attention,
        approvals,
        feedHref: mayOpenOsHref(viewer.navInput, FEED_HREF) ? `${FEED_HREF}?tab=needs&dept=${dept.slug}` : null,
        tiles: numbers.tiles,
        routines: deptRoutines,
        connections: apps,
        // Only a department with a teammate answers in Slack.
        slack: binding.kind === "agent" ? slackHomeFor(slackPresence, [dept.key]) : null,
        canManageConnections,
        asks: suggestedAsksFor(dept.key, { oasis: viewer.oasis }),
      }}
    />
  );
}
