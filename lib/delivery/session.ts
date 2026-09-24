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
import { resolveViewerSurface } from "@/lib/role-surfaces-session";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { getOasisPipelineAssignmentRoster, getTenantMembers, type MemberRow } from "@/lib/team";
import { resolveDeliveryViewer, type DeliveryAccess } from "@/lib/delivery/access";
import { DELIVERY_TENANT_ID } from "@/lib/delivery/rules";

/** The delivery tables live only in Turso. Null = not configured on this deploy. */
export function getDeliveryDb(): Client | null {
  return tursoConfigured() ? getTursoClient() : null;
}

/**
 * Who work may be assigned to: founders + ACTIVE reps (lib/team.ts). The same
 * list feeds every assignee menu and every server-side assignee check, so a
 * menu can never offer a person the API refuses. Throws when the founders are
 * missing from the roster — a loud 500 beats silently assigning to nobody.
 */
export function loadAssignmentRoster(): Promise<MemberRow[]> {
  return getOasisPipelineAssignmentRoster(DELIVERY_TENANT_ID);
}

/** Every teammate, including deactivated ones — for NAMING people on old rows only. */
export function loadMemberDirectory(): Promise<MemberRow[]> {
  return getTenantMembers(DELIVERY_TENANT_ID, { includeInactive: true });
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

export async function getDeliveryAccess(): Promise<DeliveryAccess> {
  const surface = await resolveViewerSurface();
  if (!surface.ok) return resolveDeliveryViewer({ ok: false });
  return resolveDeliveryViewer({
    ok: true,
    persona: surface.persona,
    tenantId: surface.tenantId,
    userId: surface.userId,
    canAct: surface.capabilities.canAct,
  });
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
  lead_not_found: "That lead does not exist in the OASIS pipeline.",
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
