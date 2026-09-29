/**
 * lib/delivery/access.ts — WHO may see and do what in Projects + Tickets.
 * The ONE place that decision is made; every route, page and store read asks it.
 *
 * PURE (no session, no DB) so tests/delivery-access.test.ts covers the whole
 * matrix without credentials. lib/delivery/session.ts feeds it the session.
 *
 * EVERY WORKSPACE HAS ITS OWN DESK (2026-09-28). A support desk and a project
 * board belong to the business that runs them: tenant_id is that business, and
 * the requester is ITS customer (docs/os-revamp/01-product-surface-ia-ux.md,
 * `/tickets` REBUILD). OASIS's desk is simply OASIS's instance, and is the one
 * with a second audience: the client workspaces OASIS builds for.
 *
 * TWO RELATIONSHIPS, NAMED BY THE CALLER
 *   "desk"    the viewer's OWN workspace's desk. The team that runs it sees
 *             and does everything on it.
 *   "vendor"  OASIS as the viewer's vendor (the pre-2026-09-28 model, kept
 *             byte-for-byte). Inside OASIS it is the same as "desk"; anyone
 *             signed in to ANOTHER workspace reads OASIS's desk as a client:
 *             only rows whose client_tenant_id is their workspace, only the
 *             client-safe fields, only public comments and client-visible
 *             updates; they may file a ticket and comment publicly on their
 *             own. /client-portal and a client workspace's "Your requests to
 *             OASIS" read this.
 *   A caller that names neither gets "vendor", so every surface written before
 *   desks existed behaves exactly as it did.
 *
 * THE VIEWERS
 *   founder  the TEAM that runs the desk of `tenantId`: persona "founder" (an
 *            owner or admin) standing in that workspace. Sees and does
 *            everything on that desk, and on no other.
 *   client   a member of workspace `clientTenantId` reading OASIS's desk.
 *   denied   a non-founder persona asking for a desk (reps, builders,
 *            marketing, read-only). Fails CLOSED: a desk holds every customer's
 *            name, email and issues, and no persona below founder has been
 *            granted that. Opening it to assigned builders is an owner's
 *            decision, not a default — see docs/DELIVERY_AND_SUPPORT.md. (In a
 *            client workspace such a person still reads OASIS as vendor.)
 *
 * GATE ON WORKSPACE AND PERSONA, NEVER ROLE ALONE (lib/role-surfaces.ts rule 1).
 *
 * The SQL scope below is the authorization boundary. libSQL has no RLS, so a
 * read that forgets it is a leak — which is why the store takes a viewer and
 * builds every WHERE from it, instead of each caller writing its own.
 */
import type { Persona } from "@/lib/role-surfaces";
import { DELIVERY_TENANT_ID } from "@/lib/delivery/rules";

export type DeliveryViewer =
  | { kind: "founder"; tenantId: string; userId: string; canAct: boolean }
  | { kind: "client"; userId: string; clientTenantId: string; canAct: boolean };

export type DeliveryRelation = "desk" | "vendor";

export type DeliveryAccessInput =
  | { ok: false }
  | { ok: true; persona: Persona; tenantId: string; userId: string; canAct: boolean };

export type DeliveryAccess =
  | { ok: true; viewer: DeliveryViewer }
  | { ok: false; status: 401 | 403; error: "not_signed_in" | "forbidden" };

export function resolveDeliveryViewer(
  input: DeliveryAccessInput,
  opts: { relation?: DeliveryRelation } = {},
): DeliveryAccess {
  if (!input.ok || !input.userId || !input.tenantId) {
    return { ok: false, status: 401, error: "not_signed_in" };
  }
  const userId = input.userId.trim().toLowerCase();
  const relation = opts.relation ?? "vendor";
  if (input.tenantId === DELIVERY_TENANT_ID || relation === "desk") {
    return input.persona === "founder"
      ? { ok: true, viewer: { kind: "founder", tenantId: input.tenantId, userId, canAct: input.canAct } }
      : { ok: false, status: 403, error: "forbidden" };
  }
  return {
    ok: true,
    viewer: { kind: "client", userId, clientTenantId: input.tenantId, canAct: input.canAct },
  };
}

/** Is this viewer the team running OASIS's own desk (the one with a client portal)? */
export function isOasisDesk(viewer: DeliveryViewer): boolean {
  return viewer.kind === "founder" && viewer.tenantId === DELIVERY_TENANT_ID;
}

/**
 * The workspace whose rows this viewer reads: the desk's own tenant for the
 * team, OASIS for a client (OASIS is the only vendor desk). Throws for a team
 * viewer with no tenant — an unscoped read is a leak, so it must not run.
 */
export function deskTenantOf(viewer: DeliveryViewer): string {
  if (viewer.kind === "client") return DELIVERY_TENANT_ID;
  if (typeof viewer.tenantId !== "string" || !viewer.tenantId) throw new Error("delivery: viewer has no desk tenant");
  return viewer.tenantId;
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
 * Always pinned to the viewer's desk; a client is further pinned to their own
 * client_tenant_id on OASIS's desk. A NULL client_tenant_id never matches a client.
 */
export function rowScope(viewer: DeliveryViewer, alias: string): SqlScope {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`rowScope: bad alias ${alias}`);
  const tenant = deskTenantOf(viewer);
  if (viewer.kind === "founder") {
    return { sql: `${alias}.tenant_id = ?`, args: [tenant] };
  }
  return {
    sql: `${alias}.tenant_id = ? AND ${alias}.client_tenant_id = ?`,
    args: [tenant, viewer.clientTenantId],
  };
}

/**
 * Links a client may see a ticket through. The public support form's email is
 * UNVERIFIED, so a link inferred from it ("email_project" / "email_tenant")
 * would let anyone who knows a client's address put text into that client's
 * portal. Such a ticket stays founder-only until a founder confirms the link
 * (which records it as "manual").
 */
export const CLIENT_VISIBLE_MATCHES = ["session", "manual"] as const;

/** rowScope for support_tickets: a client also needs a trusted client link. */
export function ticketRowScope(viewer: DeliveryViewer, alias: string): SqlScope {
  const base = rowScope(viewer, alias);
  if (viewer.kind === "founder") return base;
  return {
    sql: `${base.sql} AND ${alias}.client_match IN (${CLIENT_VISIBLE_MATCHES.map(() => "?").join(", ")})`,
    args: [...base.args, ...CLIENT_VISIBLE_MATCHES],
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
