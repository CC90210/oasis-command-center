import "server-only";

/**
 * May this session see an offer page's owner preview for this workspace? A
 * signed-in owner or admin of the workspace itself, by the rule every forms
 * write uses. Anyone else, including a signed-in member of another workspace,
 * is an ordinary visitor. Never throws: any doubt is "no".
 *
 * One rule for both places a preview reaches: the page itself
 * (app/f/[tenant_slug]/[form_slug]/page.tsx, ?offer_preview=1) and the live
 * open times its calendar shows for a form that is not on yet
 * (app/api/forms/booking/slots, ?preview=1).
 */
import { resolveSessionContext } from "@/lib/api-auth";
import { resolvePersona } from "@/lib/role-surfaces";
import { formsEditRefusal } from "@/lib/forms/access";

export async function canPreviewOfferPage(tenantId: string): Promise<boolean> {
  try {
    const session = await resolveSessionContext();
    if (!session.ok || session.tenantId !== tenantId) return false;
    return formsEditRefusal({ persona: resolvePersona(session), tenantId }) === null;
  } catch {
    return false;
  }
}
