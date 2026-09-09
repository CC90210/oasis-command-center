/**
 * assignee-email.ts — turn a lead's `assigned_to` into an address to copy.
 *
 * Split from lead-copy-recipients.ts so that module stays import-free: the SMTP
 * sender imports the pure filter, and dragging the roster/DB layer into the
 * transport path with it would be a needless coupling.
 *
 * Reads the same roster as the assignment dropdown and lib/assigned-names.ts,
 * so a rep who can be ASSIGNED can always be COPIED. `assigned_to` holds an
 * `auth_user_id`, not `user_profiles.id` — the two differ, and matching on the
 * wrong one silently resolves nobody.
 */

import { getTenantMembers } from "@/lib/team";
import { isAddressShaped } from "@/lib/leads/lead-copy-recipients";

/**
 * Why there is no address, when there is no address.
 *
 * A plain `string | null` cannot tell "this lead has no assignee" apart from
 * "the roster query failed", and those need opposite responses: the first is
 * normal, the second means an owner who should have been copied silently was
 * not, and nobody would ever know. Codex flagged exactly this collapse on
 * review. Same shape as the zero-versus-failed-query trap elsewhere in this
 * codebase — an absent result is not a measurement.
 */
export type AssigneeLookup =
  | { status: "resolved"; email: string }
  | { status: "unassigned" }
  /** Assigned to somebody who has no usable address on the roster. */
  | { status: "no_address" }
  | { status: "lookup_failed"; error: string };

/**
 * The assigned rep's address, and why not when not.
 *
 * SOFT-FAILS BY DESIGN, LOUDLY. A roster error costs the internal carbon copy;
 * it must never block the prospect's email, which is the part that earns money.
 * But the caller gets told, so the failure reaches `tracking_warning` instead of
 * looking identical to an unassigned lead.
 */
export async function resolveAssigneeEmail(
  tenantId: string,
  assignedTo: string | null | undefined,
): Promise<AssigneeLookup> {
  const id = (assignedTo || "").trim().toLowerCase();
  if (!tenantId || !id) return { status: "unassigned" };

  let members: Awaited<ReturnType<typeof getTenantMembers>>;
  try {
    members = await getTenantMembers(tenantId);
  } catch (e) {
    return {
      status: "lookup_failed",
      error: e instanceof Error ? e.message.slice(0, 160) : "roster_unavailable",
    };
  }

  for (const m of members) {
    if ((m.auth_user_id || "").trim().toLowerCase() === id) {
      const email = (m.email || "").trim();
      return email && isAddressShaped(email)
        ? { status: "resolved", email }
        : { status: "no_address" };
    }
  }
  // Assigned to an id the roster does not contain: a removed member, or a stale
  // stamp. Not a query failure, but not nothing either.
  return { status: "no_address" };
}
