/**
 * lib/delivery/access.ts — WHO may see and do what in Projects + Tickets.
 * The ONE place that decision is made; every route, page and store read asks it.
 *
 * PURE (no session, no DB) so tests/delivery-access.test.ts covers the whole
 * matrix without credentials. lib/delivery/session.ts feeds it the session.
 *
 * THE MODEL
 *   founder  persona "founder" standing in the OASIS workspace (CC, Adon).
 *            Sees and does everything in the workspace.
 *   client   anyone signed in to ANOTHER workspace. Sees only rows whose
 *            client_tenant_id is their own workspace, only the client-safe
 *            fields, only public comments and client-visible updates. May
 *            file a ticket and comment publicly on their own tickets.
 *   denied   a non-founder inside the OASIS workspace (reps, builders,
 *            marketing). Fails CLOSED: delivery holds every client's name,
 *            email and issues, and no persona below founder has been granted
 *            that. Opening it to assigned builders is a founder decision, not
 *            a default — see docs/DELIVERY_AND_SUPPORT.md.
 *
 * GATE ON WORKSPACE AND PERSONA, NEVER ROLE ALONE (lib/role-surfaces.ts rule 1):
 * "owner" of a client's workspace is persona founder too, and is a CLIENT here,
 * because the workspace they stand in is not OASIS.
 *
 * The SQL scope below is the authorization boundary. libSQL has no RLS, so a
 * read that forgets it is a leak — which is why the store takes a viewer and
 * builds every WHERE from it, instead of each caller writing its own.
 */
import type { Persona } from "@/lib/role-surfaces";
import { DELIVERY_TENANT_ID } from "@/lib/delivery/rules";

export type DeliveryViewer =
  | { kind: "founder"; userId: string; canAct: boolean }
  | { kind: "client"; userId: string; clientTenantId: string; canAct: boolean };

export type DeliveryAccessInput =
  | { ok: false }
  | { ok: true; persona: Persona; tenantId: string; userId: string; canAct: boolean };

export type DeliveryAccess =
  | { ok: true; viewer: DeliveryViewer }
  | { ok: false; status: 401 | 403; error: "not_signed_in" | "forbidden" };

export function resolveDeliveryViewer(
  input: DeliveryAccessInput,
  oasisTenantId: string = DELIVERY_TENANT_ID,
): DeliveryAccess {
  if (!input.ok || !input.userId || !input.tenantId) {
    return { ok: false, status: 401, error: "not_signed_in" };
  }
  const userId = input.userId.trim().toLowerCase();
  if (input.tenantId === oasisTenantId) {
    return input.persona === "founder"
      ? { ok: true, viewer: { kind: "founder", userId, canAct: input.canAct } }
      : { ok: false, status: 403, error: "forbidden" };
  }
  return {
    ok: true,
    viewer: { kind: "client", userId, clientTenantId: input.tenantId, canAct: input.canAct },
  };
}

export type DeliveryAction =
  | "project.create"
  | "project.update"
  | "task.write"
  | "update.write"
  | "ticket.create"
  | "ticket.update"
  | "ticket.comment.public"
  | "ticket.comment.internal";

/** Client write surface: file a ticket, and talk on it. Nothing else. */
const CLIENT_ACTIONS: ReadonlySet<DeliveryAction> = new Set(["ticket.create", "ticket.comment.public"]);

export function mayPerform(viewer: DeliveryViewer, action: DeliveryAction): boolean {
  if (!viewer.canAct) return false;
  if (viewer.kind === "founder") return true;
  return CLIENT_ACTIONS.has(action);
}

export type SqlScope = { sql: string; args: string[] };

/**
 * WHERE fragment for delivery_projects / support_tickets under `alias`.
 * Always pinned to the OASIS workspace; a client is further pinned to their
 * own client_tenant_id. A NULL client_tenant_id never matches a client.
 */
export function rowScope(viewer: DeliveryViewer, alias: string): SqlScope {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`rowScope: bad alias ${alias}`);
  if (viewer.kind === "founder") {
    return { sql: `${alias}.tenant_id = ?`, args: [DELIVERY_TENANT_ID] };
  }
  return {
    sql: `${alias}.tenant_id = ? AND ${alias}.client_tenant_id = ?`,
    args: [DELIVERY_TENANT_ID, viewer.clientTenantId],
  };
}

/** Extra predicate on ticket_comments: clients see public comments only. */
export function commentScope(viewer: DeliveryViewer, alias: string): string {
  return viewer.kind === "founder" ? "1 = 1" : `${alias}.is_internal = 0`;
}

/** Extra predicate on delivery_updates: clients see client-visible updates only. */
export function updateScope(viewer: DeliveryViewer, alias: string): string {
  return viewer.kind === "founder" ? "1 = 1" : `${alias}.visibility = 'client'`;
}
