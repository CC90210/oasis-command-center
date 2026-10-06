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
 *   canEditForms         the persona lib/role-surfaces.ts resolves for the
 *                        VERIFIED session is "founder": an owner or admin of
 *                        the workspace the session stands in, or someone an
 *                        admin granted full access (admin_access). Every forms
 *                        write route asks it (create, change, switch off,
 *                        delete, mint a link, create from a template), and the
 *                        Forms list and the editor ask the same question to
 *                        decide what to draw. Nothing in a request body can
 *                        answer it.
 *   mayReadFormResponses form answers are lead data (names, emails, phones,
 *                        whatever the form asked), so reading them needs the
 *                        rail's Forms row (mayOpenOsHref) AND the capability
 *                        that already governs every lead in the workspace,
 *                        canSeeAllPipeline. Today every persona that opens
 *                        Forms has it; the second half keeps it that way if
 *                        the rail ever widens.
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

export const FORMS_HREF = "/forms";

/** The one sentence a refused editor sees, in the API and on the page. */
export const FORMS_EDIT_REFUSED =
  "Only the workspace's owners and admins can create, change or delete forms.";

export type FormsSession = Extract<SessionContext, { ok: true }>;

/** May this persona create, change, switch off, delete or mint links for forms? */
export function canEditForms(persona: Persona): boolean {
  return persona === "founder";
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
 * canEditForms refuses, before the route reads its body.
 */
export async function formsSession(opts: {
  edit: boolean;
}): Promise<{ ok: true; session: FormsSession } | { ok: false; response: NextResponse }> {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return { ok: false, response: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  }
  if (opts.edit && !canEditForms(resolvePersona(session))) {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: "forbidden", message: FORMS_EDIT_REFUSED }, { status: 403 }),
    };
  }
  return { ok: true, session };
}
