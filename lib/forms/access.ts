/**
 * lib/forms/access.ts - who may change a workspace's forms, and who may read
 * what people sent in on them. One answer, asked by every forms door.
 *
 * WHY THIS FILE EXISTS (MKT-02, 2026-10-02). The forms routes checked only that
 * the caller belonged to a workspace (resolveTenantId), and the Forms list drew
 * New form, the on/off switch and Delete for everyone. So any member of a
 * workspace, a read-only seat included, could create, switch off or delete its
 * live forms and mint links for them. middleware.ts already called these
 * routes "admin-only"; nothing enforced it.
 *
 *   formsEditRefusal     why this viewer may NOT change forms here, or null
 *   canEditForms         when they may. Two refusals, in this order:
 *                          1. the workspace is retired (lib/tenant/retired.ts):
 *                             nobody changes anything in it, its owner included,
 *                             because its data is waiting to be exported and
 *                             deleted (PR #544 review, 2026-10-08);
 *                          2. the persona lib/role-surfaces.ts resolves for the
 *                             VERIFIED session is not "founder": an owner or
 *                             admin of the workspace the session stands in, or
 *                             someone an admin granted full access
 *                             (admin_access, read with lib/db-bool.ts).
 *                        Every forms write route asks it (create, change, switch
 *                        off, delete, mint a link, create from a template), and
 *                        the Forms list and the editor ask the same question to
 *                        decide what to draw. Nothing in a request body can
 *                        answer it.
 *   mayReadFormResponses form answers are lead data (names, emails, phones,
 *                        whatever the form asked), so reading them needs the
 *                        rail's Forms row (mayOpenOsHref) AND the capability
 *                        that already governs every lead in the workspace,
 *                        canSeeAllPipeline. Today every persona that opens
 *                        Forms has it; the second half keeps it that way if
 *                        the rail ever widens. A retired workspace's answers
 *                        stay readable by the same rule.
 *
 * The workspace always comes from the session, never from the request: every
 * read and write below it carries tenant_id = the session's, so a form id from
 * another workspace matches nothing and answers 404.
 */
import "server-only";

import { NextResponse } from "next/server";
import { resolveSessionContext, type SessionContext } from "@/lib/api-auth";
import { resolvePersona, type Persona, type SurfaceCapabilities } from "@/lib/role-surfaces";
import { mayOpenOsHref, type BuildOsNavInput } from "@/lib/os/nav";
import { isRetiredTenant } from "@/lib/tenant/retired";

export const FORMS_HREF = "/forms";

/** The one sentence a refused editor sees, in the API and on the page. */
export const FORMS_EDIT_REFUSED =
  "Only the workspace's owners and admins can create, change or delete forms.";

/** The one sentence everyone sees in a closed (retired) workspace. */
export const FORMS_WORKSPACE_CLOSED =
  "This workspace is closed, so its forms can't be created, changed, switched off or deleted. Their answers can still be read.";

export type FormsSession = Extract<SessionContext, { ok: true }>;

export type FormsEditRefusal = { error: "workspace_closed" | "forbidden"; message: string };

/** Why this viewer may not create, change, switch off, delete or mint links for forms here; null when they may. */
export function formsEditRefusal(viewer: { persona: Persona; tenantId: string }): FormsEditRefusal | null {
  if (isRetiredTenant(viewer.tenantId)) return { error: "workspace_closed", message: FORMS_WORKSPACE_CLOSED };
  if (viewer.persona !== "founder") return { error: "forbidden", message: FORMS_EDIT_REFUSED };
  return null;
}

/** May this viewer create, change, switch off, delete or mint links for forms here? */
export function canEditForms(viewer: { persona: Persona; tenantId: string }): boolean {
  return formsEditRefusal(viewer) === null;
}

/** May this viewer read the answers people sent in on its workspace's forms? */
export function mayReadFormResponses(viewer: {
  navInput: BuildOsNavInput;
  surface: { capabilities: Pick<SurfaceCapabilities, "canSeeAllPipeline"> };
}): boolean {
  return mayOpenOsHref(viewer.navInput, FORMS_HREF) && viewer.surface.capabilities.canSeeAllPipeline === true;
}

/**
 * The session for a forms API route, or the response to return instead.
 * `edit: true` for every route that writes: it answers 403 to anyone
 * formsEditRefusal refuses, with its sentence, before the route reads its body.
 */
export async function formsSession(opts: {
  edit: boolean;
}): Promise<{ ok: true; session: FormsSession } | { ok: false; response: NextResponse }> {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return { ok: false, response: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  }
  if (opts.edit) {
    const refusal = formsEditRefusal({ persona: resolvePersona(session), tenantId: session.tenantId });
    if (refusal) {
      return { ok: false, response: NextResponse.json({ ok: false, ...refusal }, { status: 403 }) };
    }
  }
  return { ok: true, session };
}
