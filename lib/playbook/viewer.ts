/**
 * lib/playbook/viewer.ts - who is reading the business documents hub, and
 * under which tenant OASIS's documents live.
 *
 * The hub belongs to OASIS: a member of any OASIS workspace (by tenant id AND
 * slug, lib/playbook-access.ts) may read it, filtered by persona
 * (lib/playbook/visibility.ts); everyone else is answered like a page that
 * does not exist. The documents are the COMPANY's, so they live under OASIS's
 * operator tenant (ef8d389e, oasis-ai-cc) whichever OASIS workspace the reader
 * signed into: the session proves the reader is OASIS, and the company's
 * tenant is where its documents are. No request field ever names a tenant.
 */

import "server-only";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";
import { OASIS_OPERATOR_TENANT_ID } from "@/lib/platform-operator";
import { getSessionUser } from "@/lib/supabase-server";
import { isOasisPlaybookWorkspace } from "@/lib/playbook-access";
import type { Persona } from "@/lib/role-surfaces";
import { isFounderPersona } from "./visibility";

/** The tenant OASIS's business documents are stored under. */
export const OASIS_DOCS_TENANT_ID = OASIS_OPERATOR_TENANT_ID;

export type DocsViewer = {
  ok: true;
  persona: Persona;
  founder: boolean;
  /** Always OASIS_DOCS_TENANT_ID: the documents' tenant. */
  tenantId: string;
  /** The workspace the reader signed into (an OASIS one). */
  sessionTenantId: string;
  userId: string;
  /** Written into updated_by / approved_by / recorded_by: the email, else the user id. */
  actor: string;
};

export type DocsViewerResult = DocsViewer | { ok: false };

/**
 * The reader, or { ok: false } for anyone who may not read the hub (no
 * session, another workspace). A failed session or profile read THROWS: the
 * caller answers it as an outage, never as "not allowed".
 */
export async function resolveDocsViewer(): Promise<DocsViewerResult> {
  const surface = await resolveViewerSurface();
  if (!surface.ok || !isOasisPlaybookWorkspace(surface)) return { ok: false };
  const user = await getSessionUser();
  return {
    ok: true,
    persona: surface.persona,
    founder: isFounderPersona(surface.persona),
    tenantId: OASIS_DOCS_TENANT_ID,
    sessionTenantId: surface.tenantId,
    userId: surface.userId,
    actor: (user?.email || "").trim().toLowerCase() || surface.userId,
  };
}
