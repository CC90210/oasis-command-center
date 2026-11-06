/**
 * GET /api/automations/notifications[?agent=bravo|maven|atlas|command_center]
 *
 * The newest notices the agents sent CC (lib/notify/notification-log.ts), for the
 * Automations page's Notifications panel. CC, 2026-11-05: "make sure all the
 * automation notifications are also displayed on the OasisAI command center."
 *
 * Same gate as /api/automations/background-workers, in the same order: a signed-in
 * viewer, on an OASIS surface, whose persona may see system surfaces, AND the
 * workspace's agents owner. These texts are CC's own alerts (lead names, email
 * subjects, his money), so an OASIS admin who is not the agents owner gets an
 * explicit empty scope, not CC's inbox.
 */

import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getTenant } from "@/lib/queries";
import { jsonRoute } from "@/lib/api-helpers";
import { capabilitiesFor, isOasisSurfaceTenant, resolvePersona } from "@/lib/role-surfaces";
import { isAgentsOwner } from "@/lib/agents-owner";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { WEBDEV_TENANT_ID } from "@/lib/oasis-tenant";
import { isNotificationAgent, readRecentNotifications } from "@/lib/notify/notification-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = jsonRoute("api/automations/notifications GET", async (req: Request) => {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenant = await getTenant(session.tenantId);
  const tenantSlug = tenant?.slug?.trim().toLowerCase() || null;
  if (!isOasisSurfaceTenant(tenantSlug)) {
    // Only OASIS's own workspaces have agents that notify CC.
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const persona = resolvePersona({
    teamRole: session.teamRole,
    isTrueAdmin: session.isTrueAdmin,
    adminAccess: session.adminAccess,
  });
  if (!capabilitiesFor(persona, tenantSlug).canSeeSystemSurfaces) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (!(await isAgentsOwner(session.tenantId, session.userId))) {
    return NextResponse.json({ ok: true, notifications: [], scope: "not_yours" });
  }
  if (!tursoConfigured()) {
    return NextResponse.json({ ok: false, error: "database_not_configured" }, { status: 503 });
  }

  const agentParam = new URL(req.url).searchParams.get("agent");
  const agent = isNotificationAgent(agentParam) ? agentParam : undefined;
  const read = await readRecentNotifications(getTursoClient(), WEBDEV_TENANT_ID, { agent, limit: 100 });
  if (!read.ok) {
    if (read.reason === "not_installed") {
      return NextResponse.json({ ok: true, notifications: [], scope: "not_installed" });
    }
    return NextResponse.json(
      { ok: false, error: "notifications_unavailable", message: "Notifications could not be read. Refresh in a moment." },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, notifications: read.rows, scope: "yours" });
});
