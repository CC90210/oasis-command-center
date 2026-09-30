/**
 * lib/os/customers/session.ts — who may read and change a workspace's clients,
 * decided once from the session.
 *
 *   read   capabilities.canSeeClientIdentities — the same flag that draws the
 *          Clients rail row (lib/os/nav.ts audience "client_identities"), so
 *          the API can never show more than the page, or less.
 *   write  persona "founder" (an owner or admin of the workspace) who may act.
 *          Client records are the business's book; creating, editing and
 *          converting them is an owner's call.
 *   desk   the workspace's own support desk viewer (lib/delivery/access.ts,
 *          relation "desk"): only a viewer who may read the desk gets ticket
 *          and project counts; for everyone else they are unknown, not 0.
 *
 * The tenant is ALWAYS the session's. No route or page reads a tenant id from
 * a request body, a query string or a path.
 */
import "server-only";
import { NextResponse } from "next/server";
import type { Client } from "@libsql/client";
import { resolveViewerSurface, type ViewerSurface } from "@/lib/role-surfaces-session";
import { isOasisSurfaceTenant, type Persona } from "@/lib/role-surfaces";
import { resolveDeliveryViewer, type DeliveryViewer } from "@/lib/delivery/access";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { isMissingCustomersSchema, listCustomerOptions } from "@/lib/os/customers/store";

export type ClientsViewer = {
  tenantId: string;
  tenantSlug: string | null;
  userId: string;
  persona: Persona;
  /** OASIS's own workspace (it also has the pipeline-derived client list). */
  oasis: boolean;
  canRead: boolean;
  canWrite: boolean;
  /** The workspace's own desk, or null when this viewer may not read it. */
  desk: Extract<DeliveryViewer, { kind: "founder" }> | null;
};

export function clientsViewerFromSurface(surface: ViewerSurface): ClientsViewer | null {
  if (!surface.ok) return null;
  const desk = resolveDeliveryViewer(
    {
      ok: true,
      persona: surface.persona,
      tenantId: surface.tenantId,
      userId: surface.userId,
      canAct: surface.capabilities.canAct,
    },
    { relation: "desk" },
  );
  return {
    tenantId: surface.tenantId,
    tenantSlug: surface.tenantSlug,
    userId: surface.userId.trim().toLowerCase(),
    persona: surface.persona,
    oasis: isOasisSurfaceTenant(surface.tenantSlug),
    canRead: surface.capabilities.canSeeClientIdentities,
    canWrite: surface.persona === "founder" && surface.capabilities.canAct,
    desk: desk.ok && desk.viewer.kind === "founder" ? desk.viewer : null,
  };
}

export async function resolveClientsViewer(): Promise<ClientsViewer | null> {
  return clientsViewerFromSurface(await resolveViewerSurface());
}

/** Customers live only in Turso. Null = not configured on this deploy. */
export function getCustomersDb(): Client | null {
  return tursoConfigured() ? getTursoClient() : null;
}

const MESSAGES: Record<string, string> = {
  not_signed_in: "Sign in to see clients.",
  forbidden: "You do not have access to this.",
  not_found: "Not found.",
  database_not_configured: "The database is not configured on this deployment.",
  customers_not_set_up: "Client records are not set up in this database yet (migration bravo__188).",
  email_taken: "A client with that email already exists.",
  stripe_customer_taken: "Another client already has that Stripe customer.",
  source_lead_taken: "That deal is already a client.",
  email_belongs_to_another_client: "A client with this email already exists and came from a different deal. Open it instead.",
  lead_not_found: "That deal is not in this workspace's pipeline.",
  lead_not_won: "Only a won deal can become a client. Mark it won in Pipeline first.",
  owner_invalid: "The owner value is not valid.",
  owner_not_on_team: "That person is not an active member of this workspace.",
  contact_empty: "Give the contact a name, an email or a phone number.",
  lead_id_required: "Choose the deal to convert.",
  no_changes: "Nothing to change.",
  body_invalid: "The request body must be a JSON object.",
  invalid_json: "The request body is not valid JSON.",
  support_slug_taken:
    "This workspace already has a form at /support that creates leads. Rename that form first, then turn the support form on.",
  support_desk_unavailable: "The support desk is not set up in this database yet (migration bravo__188).",
  oasis_desk_is_seeded: "OASIS's support form is already on.",
  tenant_not_found: "This workspace could not be found.",
  // The client record's composer (POST /api/clients/[id]/reply).
  confirmation_required: "Confirm the send first. Nothing was sent.",
  agent_drafts_need_approval: "An agent's draft goes to Feed for approval; it is never sent from here.",
  oasis_mailbox_not_configured: "The OASIS mailbox is not configured on this deployment, so nothing was sent.",
  no_mailbox:
    "This workspace has no mailbox connected for client email yet, so nothing was sent. Connect your own mailbox for this workspace in Settings, then send again.",
  client_has_no_email: "This client has no email address. Add one with Edit details, then write to them.",
  to_not_this_client: "That address is not this client's. Write to the client's main address or one of its contacts.",
  channel_not_supported: "Only email can be sent from a client record for now.",
  drafted_by_agent_required: "Name the agent that drafted this email.",
  // Linking the client's own workspace (POST /api/clients/[id]/link-workspace).
  operator_only: "Only the platform operator can link a client's workspace.",
  oasis_only: "This is only available in OASIS's own workspace.",
  client_tenant_id_invalid: "Choose a workspace from the list.",
  client_tenant_not_found: "That workspace does not exist.",
  client_tenant_is_this_workspace: "A client cannot be linked to your own workspace.",
  client_tenant_taken: "That workspace is already linked to another client record.",
  client_workspace_link_not_set_up:
    "Linking a client's workspace needs migration bravo__195, which is not applied to this database yet. Nothing was changed.",
  // Importing Stripe customers (POST /api/clients/import-stripe).
  finance_owners_only: "Importing from the books is for OASIS's founders (the same people who can open Money).",
  privacy_confirmation_required:
    "Confirm the privacy question first: Stripe subscribers can be private individuals, and only their name and email are recorded.",
};

function humanize(code: string): string {
  if (MESSAGES[code]) return MESSAGES[code];
  const m = /^([a-z_]+?)_(required|invalid|too_long|too_many)$/.exec(code);
  if (m) {
    const field = m[1].replace(/_/g, " ");
    if (m[2] === "required") return `${field} is required.`;
    if (m[2] === "too_long") return `${field} is too long.`;
    if (m[2] === "too_many") return `Too many ${field}.`;
    return `${field} is not valid.`;
  }
  return "The request could not be completed.";
}

/** JSON error with a stable code and a sentence. Never an empty body. */
export function customersError(status: number, error: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, message: humanize(error), ...(extra ?? {}) }, { status });
}

/**
 * Log the cause, answer with a sentence. A missing customers table is named as
 * such (503), because "set up the migration" is an actionable answer and "500"
 * is not; every other failure is a 500 whose driver text stays in the log.
 */
export function customersServerError(label: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[customers:${label}]`, err instanceof Error ? err.stack ?? message : message);
  if (isMissingCustomersSchema(err)) return customersError(503, "customers_not_set_up");
  return NextResponse.json(
    { ok: false, error: "server_error", message: `Something went wrong (${label}). The error has been logged.` },
    { status: 500 },
  );
}

export async function readJsonBody(req: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false };
  }
}

export type CustomerOptions =
  | { state: "ok"; options: Array<{ value: string; label: string }> }
  | { state: "not_set_up" }
  | { state: "error" };

/**
 * The workspace's client records as picker options (ticket / project "Client"
 * selects). A database without migration bravo__188 answers not_set_up, so the
 * desk still works and simply has no Client field; any other failure is logged
 * and reported, never an empty list.
 */
export async function loadCustomerOptions(db: Client, tenantId: string): Promise<CustomerOptions> {
  try {
    const rows = await listCustomerOptions(db, tenantId);
    return { state: "ok", options: rows.map((r) => ({ value: r.value, label: r.email ? `${r.label} (${r.email})` : r.label })) };
  } catch (err) {
    if (isMissingCustomersSchema(err)) return { state: "not_set_up" };
    console.error("[customers.options]", err);
    return { state: "error" };
  }
}
