/**
 * Who may see Training, and who may see somebody else's.
 *
 * TWO BARS, and the second one is the one that matters.
 *
 * VIEWING AND DRILLING is open to anyone who works the website sales lifecycle.
 * Training a rep is the point; gating it would be perverse.
 *
 * SEEING ANOTHER PERSON'S PROGRESS is a manager capability. A rep's practice is
 * a record of what they are bad at, and one rep reading another's is how a
 * training tool turns into a league table. Managers and tenant admins only.
 *
 * BOTH FAIL CLOSED, and neither takes a bare role string: they take the whole
 * session so no caller has to remember the tenant check separately. A check a
 * caller must remember is one a caller will eventually forget.
 *
 * Modelled on `lib/web-leads/objections/admin-access.ts`, which does the same
 * job for the objection library.
 */

import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";
import { mayWorkWebsiteSalesLifecycle } from "@/lib/website-sales-workflow";

export type TrainingSession = {
  ok: boolean;
  tenantId?: string;
  teamRole?: string | null;
  isAdmin?: boolean;
  userId?: string;
  email?: string | null;
};

function inTenant(session: TrainingSession | null | undefined): boolean {
  return Boolean(session && session.ok === true && session.tenantId === WEBDEV_TENANT_ID);
}

/** May open Training and drill it. */
export function mayViewTraining(session: TrainingSession | null | undefined): boolean {
  if (!inTenant(session)) return false;
  return mayWorkWebsiteSalesLifecycle(session!.teamRole ?? "", session!.isAdmin ?? false);
}

/**
 * May see the whole team's progress.
 *
 * Manager or tenant admin. Not `mayQuoteAndClose`, which is the bar for putting
 * a sentence in front of a customer and includes a closer selling their own
 * book. Reading a colleague's practice record is a different act, and a closer
 * is a peer rather than a supervisor.
 */
export function maySeeTeamTraining(session: TrainingSession | null | undefined): boolean {
  if (!inTenant(session)) return false;
  if (session!.isAdmin === true) return true;
  return (session!.teamRole ?? "").trim().toLowerCase() === "manager";
}

/** The id a progress row is written against. Never empty: a row that records
 *  nobody cannot be read back for the person who earned it. */
export function repIdFor(session: TrainingSession): string | null {
  const id = session.userId?.trim();
  return id && id.length > 0 ? id : null;
}
