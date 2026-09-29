/**
 * lib/delivery/session.ts — the session-shaped front door to lib/delivery/access.
 *
 * Reads the session through resolveViewerSurface (the same persona resolution
 * every other surface uses) and hands the result to the pure resolver. Holds no
 * policy of its own: if you are about to write a rule here, it belongs in
 * access.ts where the tests can reach it.
 */
import "server-only";
import { NextResponse } from "next/server";
import type { Client } from "@libsql/client";
import { resolveViewerSurface, type ViewerSurface } from "@/lib/role-surfaces-session";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { getOasisPipelineAssignmentRoster, getTenantMembers, type MemberRow } from "@/lib/team";
import {
  resolveDeliveryViewer,
  type DeliveryAccess,
  type DeliveryRelation,
  type DeliveryViewer,
} from "@/lib/delivery/access";
import { DELIVERY_TENANT_ID } from "@/lib/delivery/rules";
import { getProject, getTicket, type Project, type Ticket } from "@/lib/delivery/store";

/** The delivery tables live only in Turso. Null = not configured on this deploy. */
export function getDeliveryDb(): Client | null {
  return tursoConfigured() ? getTursoClient() : null;
}

/**
 * Who work on a desk may be assigned to. OASIS's desk: founders + ACTIVE reps
 * (lib/team.ts getOasisPipelineAssignmentRoster, which throws when the founders
 * are missing — a loud 500 beats silently assigning to nobody). Any other
 * desk: that workspace's ACTIVE members. The same list feeds every assignee
 * menu and every server-side assignee check, so a menu can never offer a
 * person the API refuses.
 */
export function loadAssignmentRoster(tenantId: string): Promise<MemberRow[]> {
  return tenantId === DELIVERY_TENANT_ID
    ? getOasisPipelineAssignmentRoster(DELIVERY_TENANT_ID)
    : getTenantMembers(tenantId);
}

/** Every teammate of the desk, including deactivated ones — for NAMING people on old rows only. */
export function loadMemberDirectory(tenantId: string): Promise<MemberRow[]> {
  return getTenantMembers(tenantId, { includeInactive: true });
}

/**
 * Log the cause, answer with a sentence. Never an empty body, never a fake
 * empty list. The driver's text stays in the log: these routes also answer
 * clients, and "no such table: delivery_projects" is not theirs to read.
 */
export function serverError(label: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[delivery:${label}]`, err instanceof Error ? err.stack ?? message : message);
  return NextResponse.json(
    {
      ok: false,
      error: "server_error",
      message: `Something went wrong (${label}). The error has been logged.`,
    },
    { status: 500 },
  );
}

/**
 * The session's delivery viewer for one relationship (lib/delivery/access.ts).
 * No relation = "vendor", the pre-desk contract every existing caller relies on.
 */
export async function getDeliveryAccess(relation?: DeliveryRelation): Promise<DeliveryAccess> {
  return deliveryAccessFor(await resolveViewerSurface(), relation);
}

/** Same answer from a surface the caller already resolved (one session read per page). */
export function deliveryAccessFor(surface: ViewerSurface, relation?: DeliveryRelation): DeliveryAccess {
  if (!surface.ok) return resolveDeliveryViewer({ ok: false });
  return resolveDeliveryViewer(
    {
      ok: true,
      persona: surface.persona,
      tenantId: surface.tenantId,
      userId: surface.userId,
      canAct: surface.capabilities.canAct,
    },
    { relation },
  );
}

/**
 * A route's relationship, from `?scope=desk|vendor`. Anything else (including
 * absent) is "vendor", so a caller written before desks behaves as it did.
 * The scope only chooses WHICH of the viewer's own relationships applies; the
 * tenant always comes from the session.
 */
export function relationFromScope(scope: string | null | undefined): DeliveryRelation {
  return scope === "desk" ? "desk" : "vendor";
}

/**
 * For a request addressed to ONE row by id: the viewer's own desk first, then
 * (outside OASIS) OASIS as vendor. Ids are UUIDs, so a row matches at most one
 * of them; whichever scoped read finds it decides what the viewer may do.
 */
export async function getDeliveryAccessChain(): Promise<{ desk: DeliveryAccess; vendor: DeliveryAccess | null }> {
  const surface = await resolveViewerSurface();
  const desk = deliveryAccessFor(surface, "desk");
  const vendor = surface.ok && surface.tenantId !== DELIVERY_TENANT_ID ? deliveryAccessFor(surface, "vendor") : null;
  return { desk, vendor };
}

export type TicketAccess =
  | { ok: true; viewer: DeliveryViewer; ticket: Ticket }
  | { ok: false; status: 401 | 403 | 404; error: "not_signed_in" | "forbidden" | "not_found" };

/**
 * Find ticket `id` through the viewer's relationships, desk first
 * (getDeliveryAccessChain). A ticket found through the vendor relationship
 * carries the client viewer, so the route applies the client rules to it. Not
 * readable through either: the access error when the viewer has no
 * relationship at all (401 / 403), otherwise 404 — never a hint that the
 * ticket exists on someone else's desk.
 */
export async function resolveTicketAccess(db: Client, id: string): Promise<TicketAccess> {
  const { desk, vendor } = await getDeliveryAccessChain();
  if (desk.ok) {
    const ticket = await getTicket(db, desk.viewer, id);
    if (ticket) return { ok: true, viewer: desk.viewer, ticket };
  }
  if (vendor?.ok) {
    const ticket = await getTicket(db, vendor.viewer, id);
    if (ticket) return { ok: true, viewer: vendor.viewer, ticket };
  }
  if (!desk.ok && !vendor?.ok) return { ok: false, status: desk.status, error: desk.error };
  return { ok: false, status: 404, error: "not_found" };
}

export type ProjectAccess =
  | { ok: true; viewer: DeliveryViewer; project: Project }
  | { ok: false; status: 401 | 403 | 404; error: "not_signed_in" | "forbidden" | "not_found" };

/** resolveTicketAccess for a project: own desk first, then OASIS as vendor. */
export async function resolveProjectAccess(db: Client, id: string): Promise<ProjectAccess> {
  const { desk, vendor } = await getDeliveryAccessChain();
  if (desk.ok) {
    const project = await getProject(db, desk.viewer, id);
    if (project) return { ok: true, viewer: desk.viewer, project };
  }
  if (vendor?.ok) {
    const project = await getProject(db, vendor.viewer, id);
    if (project) return { ok: true, viewer: vendor.viewer, project };
  }
  if (!desk.ok && !vendor?.ok) return { ok: false, status: desk.status, error: desk.error };
  return { ok: false, status: 404, error: "not_found" };
}

/** JSON error with a stable code and a sentence. Never an empty body. */
export function deliveryError(status: number, error: string, message?: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, message: message ?? humanize(error), ...(extra ?? {}) }, { status });
}

const MESSAGES: Record<string, string> = {
  not_signed_in: "Sign in to see projects and tickets.",
  forbidden: "You do not have access to this.",
  not_found: "Not found.",
  database_not_configured: "The database is not configured on this deployment.",
  assignee_not_on_roster: "That person is not on the active OASIS team, so work cannot be assigned to them.",
  assignee_invalid: "The assignee value is not valid.",
  invalid_transition: "That status change is not allowed from the ticket's current status.",
  project_belongs_to_another_client: "That project belongs to a different client than this ticket.",
  no_inferred_client_link: "This ticket has no unverified client link to confirm.",
  project_not_found: "That project does not exist in this workspace.",
  client_tenant_not_found: "That client workspace does not exist.",
  client_workspace_links_are_oasis_only: "Linking to a client workspace is only for OASIS's own desk. Link a client record instead.",
  customer_not_found: "That client record does not exist in this workspace.",
  lead_not_found: "That lead does not exist in this workspace's pipeline.",
  ticket_closed: "This ticket is closed. Open a new ticket for anything new.",
  no_changes: "Nothing to change.",
  body_invalid: "The request body must be a JSON object.",
  invalid_json: "The request body is not valid JSON.",
};

function humanize(code: string): string {
  if (MESSAGES[code]) return MESSAGES[code];
  const m = /^([a-z_]+?)_(required|invalid|too_long)$/.exec(code);
  if (m) {
    const field = m[1].replace(/_/g, " ");
    return m[2] === "required" ? `${field} is required.` : m[2] === "too_long" ? `${field} is too long.` : `${field} is not valid.`;
  }
  return "The request could not be completed.";
}

/** Map a failed access check onto the response the caller returns. */
export function accessDenied(access: Extract<DeliveryAccess, { ok: false }>) {
  return deliveryError(access.status, access.error);
}

/** Parse a JSON body without letting a malformed one become an uncaught 500. */
export async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false };
  }
}
