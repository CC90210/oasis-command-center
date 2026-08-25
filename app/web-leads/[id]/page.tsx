/**
 * /web-leads/[id] — the full-screen battle card for one lead.
 *
 * A PAGE, NOT A DRAWER, on purpose: this is what a rep reads while the phone is
 * already ringing, and the existing 28rem panel is built for triage. See
 * components/web-leads/BattleCard.tsx's header for the full argument.
 *
 * IT HAS ITS OWN URL, which is the other half of the point. A rep can open a
 * lead in a second tab before dialling, keep it up through the call, and send
 * the link to a colleague. The drawer's `?lead=` parameter cannot do any of
 * that, and Call Mode's "Full detail" had nowhere better to go.
 *
 * `/web-leads/pipeline` still resolves to its own retired-route redirect rather
 * than being swallowed by this dynamic segment: Next matches static segments
 * before dynamic ones.
 *
 * DATA AUTHORIZATION DOES NOT HAPPEN HERE. middleware.ts gates the route for an unauthenticated
 * caller, and every byte this page renders arrives from
 * /api/web-leads/[id]/battlecard, which is the real authorization boundary --
 * it resolves the session, pins the tenant, applies the outside-contractor role
 * scoping, and answers 404 for any id outside the caller's scope. Putting a
 * second, weaker data check here would create a second place for that rule to
 * drift. We do resolve the role only to remove mutation controls; the POST API
 * independently enforces the same centralized role policy.
 */

import { BattleCard } from "@/components/web-leads/BattleCard";
import { resolveSessionContext } from "@/lib/api-auth";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";
import { mayWorkWebsiteSalesLifecycle } from "@/lib/website-sales-workflow";

export const dynamic = "force-dynamic";

export default async function WebLeadBattleCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await resolveSessionContext();
  let canMutate = false;
  if (
    session.ok &&
    session.tenantId === WEBDEV_TENANT_ID &&
    mayWorkWebsiteSalesLifecycle(session.teamRole, session.isAdmin)
  ) {
    const access = await assertMayWorkLead({
      teamRole: session.teamRole,
      userId: session.userId,
      tenantId: WEBDEV_TENANT_ID,
      leadId: id,
      isOwner: session.isTrueAdmin,
      adminAccess: session.adminAccess,
      accessMode: "owned_oasis_sales",
    });
    canMutate = access.ok;
  }
  return <BattleCard leadId={id} canMutate={canMutate} />;
}
