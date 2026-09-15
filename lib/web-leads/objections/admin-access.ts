/**
 * Who may read and who may approve on the `/objections` surface, in one place
 * so the page and all four routes cannot drift apart.
 *
 * TWO DIFFERENT BARS, on purpose.
 *
 * READING the library is open to anyone who works the website sales lifecycle.
 * A rep seeing which objections exist and how they are answered is the point
 * of the thing, and hiding it would push them back to guessing.
 *
 * APPROVING requires `mayQuoteAndClose`, the same bar that already governs who
 * may put a number in front of a prospect. The design doc chose that bar
 * deliberately: an approved answer is a sentence somebody will read verbatim
 * to a stranger, which is the same class of act as quoting a price.
 *
 * BOTH FAIL CLOSED. Every helper takes the whole session and returns false for
 * anything that is not an authenticated member of the web-dev tenant. There is
 * no branch that returns true on an error, and no caller is expected to
 * remember the tenant check separately, because a check a caller must remember
 * is one a caller will eventually forget.
 */

import { mayQuoteAndClose } from "@/lib/team-roles";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";
import { mayWorkWebsiteSalesLifecycle } from "@/lib/website-sales-workflow";

/** The fields of a resolved session these gates read. Structural rather than
 *  an import of the auth module's union, so a page holding a narrowed session
 *  can call these without casting. */
export type SessionLike = {
  ok: boolean;
  tenantId?: string;
  teamRole?: string | null;
  isAdmin?: boolean;
  email?: string | null;
  userId?: string;
};

function inTenant(session: SessionLike | null | undefined): boolean {
  return Boolean(session && session.ok === true && session.tenantId === WEBDEV_TENANT_ID);
}

/** May see the library and the drafts. */
export function mayViewObjectionLibrary(session: SessionLike | null | undefined): boolean {
  if (!inTenant(session)) return false;
  return mayWorkWebsiteSalesLifecycle(session!.teamRole ?? "", session!.isAdmin ?? false);
}

/** May create drafts and edit wording that has not been approved. */
export function mayAuthorObjections(session: SessionLike | null | undefined): boolean {
  return mayViewObjectionLibrary(session);
}

/** May approve, retire, or choose the default answer a rep sees first. */
export function mayApproveObjections(session: SessionLike | null | undefined): boolean {
  if (!inTenant(session)) return false;
  // An admin of this tenant may approve. Otherwise the deal-closing bar.
  if (session!.isAdmin === true) return true;
  return mayQuoteAndClose(session!.teamRole ?? "");
}

/**
 * The name stamped into `approved_by`.
 *
 * Email first because it identifies a person to whoever reads the row later;
 * the user id is the fallback, never null. An approval that records nobody is
 * refused further down in `updateObjection`, and this exists so that refusal
 * is unreachable in practice rather than a live failure mode.
 */
export function approverName(session: SessionLike): string {
  const email = session.email?.trim();
  if (email) return email;
  return session.userId ?? "unknown";
}

/** The lifecycle status of the rows a PATCH is about to touch, as stored.
 *  Mirrors `EditTargetStatus` in ./admin; declared structurally here so this
 *  module stays free of anything that opens a database connection. */
export type StoredStatuses = { objectionStatus: string | null; responseStatus: string | null };

/** The shape of a patch these gates inspect. Structural, for the same reason. */
type CopyPatch = {
  says?: unknown; meaning?: unknown; prevent?: unknown; family?: unknown;
  websitePremise?: unknown; status?: unknown;
};
type AnswerPatch = { label?: unknown; body?: unknown; status?: unknown; makeDefault?: unknown };

/** Fields that change what a rep reads, as opposed to the row's lifecycle. */
export function changesCopy(objection: CopyPatch, response: AnswerPatch): boolean {
  const objectionCopy =
    objection.says !== undefined ||
    objection.meaning !== undefined ||
    objection.prevent !== undefined ||
    objection.family !== undefined ||
    objection.websitePremise !== undefined;
  const responseCopy = response.label !== undefined || response.body !== undefined;
  return objectionCopy || responseCopy;
}

/**
 * Whether this request needs the closer bar rather than the author bar.
 *
 * Any status change qualifies, not only an approval. Retiring hides an answer
 * from every rep instantly, and promoting a default changes the sentence a rep
 * reads first; both are decisions about what leaves somebody's mouth on a
 * call, which is the thing `mayQuoteAndClose` exists to gate.
 *
 * 🚨 AND SO DOES EDITING COPY THAT IS ALREADY APPROVED, which is why this
 * takes the stored statuses and not just the payload. An earlier version of
 * this function read the payload alone, and a payload carrying only `says` or
 * `body` looked like a harmless draft fix. On an approved row it is not: it
 * rewrites a sentence that is live on reps' screens at that moment, with no
 * closer involved, which silently reopened the exact gate this route exists
 * to close. Found in review before it shipped.
 *
 * A status that could not be read is treated as approved, so an unreadable or
 * missing row demands the higher permission rather than the lower one.
 */
export function needsApprovalRights(
  objection: CopyPatch,
  response: AnswerPatch,
  stored: StoredStatuses,
): boolean {
  if (objection.status !== undefined) return true;
  if (response.status !== undefined) return true;
  if (response.makeDefault) return true;

  if (!changesCopy(objection, response)) return false;

  const touchesObjectionCopy =
    objection.says !== undefined ||
    objection.meaning !== undefined ||
    objection.prevent !== undefined ||
    objection.family !== undefined ||
    objection.websitePremise !== undefined;
  const touchesResponseCopy = response.label !== undefined || response.body !== undefined;

  if (touchesObjectionCopy && stored.objectionStatus !== "draft") return true;
  if (touchesResponseCopy && stored.responseStatus !== "draft") return true;
  return false;
}
