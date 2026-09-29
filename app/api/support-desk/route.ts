/**
 * /api/support-desk — the workspace's public support form.
 *
 *   GET   is it on, and where (/f/<slug>/support)? The desk team only.
 *   POST  turn it on (owners and admins, i.e. the desk team who may act).
 *         Creates the workspace's `support` form and registers it as its
 *         desk's intake (lib/delivery/desks.ts). Idempotent. OASIS's own form
 *         was seeded by migration 183 and is already on.
 *
 * The workspace is the session's; the form it creates files tickets on that
 * workspace's desk only.
 */
import { NextResponse } from "next/server";
import { enableSupportDesk, getDeskForm } from "@/lib/delivery/desks";
import { mayPerform } from "@/lib/delivery/access";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";
import { deliveryAccessFor, getDeliveryDb } from "@/lib/delivery/session";
import { customersError, customersServerError } from "@/lib/os/customers/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function deskTeam() {
  const surface = await resolveViewerSurface();
  const access = deliveryAccessFor(surface, "desk");
  if (!access.ok) return { ok: false as const, status: access.status, error: access.error };
  if (access.viewer.kind !== "founder") return { ok: false as const, status: 403 as const, error: "forbidden" as const };
  return { ok: true as const, viewer: access.viewer, tenantSlug: surface.ok ? surface.tenantSlug : null };
}

export async function GET() {
  try {
    const team = await deskTeam();
    if (!team.ok) return customersError(team.status, team.error);
    const db = getDeliveryDb();
    if (!db) return customersError(503, "database_not_configured");
    return NextResponse.json({ ok: true, form: await getDeskForm(db, team.viewer.tenantId, team.tenantSlug) });
  } catch (err) {
    return customersServerError("support_desk.get", err);
  }
}

export async function POST() {
  try {
    const team = await deskTeam();
    if (!team.ok) return customersError(team.status, team.error);
    if (!mayPerform(team.viewer, "ticket.update")) return customersError(403, "forbidden");
    const db = getDeliveryDb();
    if (!db) return customersError(503, "database_not_configured");
    const result = await enableSupportDesk(db, team.viewer.tenantId, team.viewer.userId, new Date());
    if (!result.ok) return customersError(result.status, result.error);
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    return customersServerError("support_desk.enable", err);
  }
}
