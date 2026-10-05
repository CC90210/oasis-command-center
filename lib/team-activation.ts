import "server-only";

/**
 * Deactivate / reactivate a teammate — the I/O side. Rules: ./team-activation-rules.
 *
 * Deactivation is the reversible alternative to removeMember (2026-09-24, CC:
 * "deactivated instead of deleted ... reactivate and deactivate them" from
 * Settings). It acts on the PERSON, not the clicked row — every profile row the
 * Team roster folds into that one teammate (see loadPerson) — and does four
 * things, in this order:
 *
 *   1. marks those profiles inactive (user_profiles.deactivated_*), which drops
 *      the person from every live roster in lib/team.ts;
 *   2. bans each of their logins and bumps session_version, so every open cookie
 *      fails its next server check (lib/turso-auth.ts verifySessionAgainstDb) —
 *      except a login that still has an ACTIVE profile in another workspace,
 *      where banning it would lock them out of work they still do;
 *   3. on the OASIS sales tenant, moves their open leads per the disposition
 *      rule (cold → pool, warm → board unassigned, closed → kept);
 *   4. writes the tenant audit event.
 *
 * Step 3 is safe to repeat: a second deactivate of an already-inactive member
 * re-runs only the lead sweep, which finds whatever a failed first run left.
 *
 * Reactivation undoes exactly one deactivation: the rows it stamped, and the
 * bans on their logins. A duplicate retired earlier, on purpose, stays retired.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient } from "@/lib/turso";
import { canonicalizeTenantMembers, isTrueAdminRole, type MemberRow, type SessionContext } from "@/lib/team";
import { releaseLeads } from "@/lib/web-leads/claim-ops";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";
import { CURRENT_OASIS_PIPELINE_CYCLE } from "@/lib/pipeline-cycle";
import {
  DEACTIVATION_BAN_UNTIL,
  boardUnassignPatch,
  planLeadDisposition,
} from "@/lib/team-activation-rules";

type TargetProfile = {
  id: string;
  tenant_id: string | null;
  is_owner: boolean | null;
  auth_user_id: string | null;
  email: string | null;
  full_name: string | null;
  display_name: string | null;
  team_role: string | null;
  admin_access: boolean | null;
  joined_at: string | null;
  deactivated_at: string | null;
  deactivated_by: string | null;
};

export type DeactivationImpact = {
  member: { id: string; name: string; email: string | null; team_role: string | null };
  active: boolean;
  /** False outside the OASIS sales tenant: there, only roster + login change. */
  leadHandling: boolean;
  leads: { pool: number; board: number; keep: number };
  unpaidCommissions: number;
};

export type DeactivationResult = {
  impact: DeactivationImpact;
  loginBlocked: boolean;
  loginNote: string | null;
  released: number;
  boardUnassigned: number;
  /** Leads that changed under us (someone else touched them) — left as-is. */
  refused: string[];
};

class ActivationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function activationErrorStatus(error: unknown): number {
  return error instanceof ActivationError ? error.status : 500;
}

function assertActor(actor: SessionContext): void {
  // Same guard as removeMember: a true admin (owner/admin base role), never an
  // admin_access grant, because this locks a person out of the workspace.
  if (!isTrueAdminRole(actor.teamRole, actor.isOwner)) throw new ActivationError("forbidden", 403);
}

const TARGET_COLUMNS =
  "id, tenant_id, is_owner, auth_user_id, email, full_name, display_name, team_role, admin_access, joined_at, deactivated_at, deactivated_by";

async function loadTarget(tenantId: string, profileId: string): Promise<TargetProfile> {
  const { data, error } = await getServiceSupabase()
    .from("user_profiles")
    .select(TARGET_COLUMNS)
    .eq("id", profileId)
    .maybeSingle();
  if (error) throw new ActivationError("lookup_failed", 500);
  const target = data as TargetProfile | null;
  if (!target) throw new ActivationError("member_not_found", 404);
  if (target.tenant_id !== tenantId) throw new ActivationError("forbidden", 403);
  return target;
}

/** The target and its duplicates in this workspace, plus their distinct logins. */
type Person = { rows: TargetProfile[]; authUserIds: string[] };

const loginOf = (row: { auth_user_id: string | null }) => row.auth_user_id?.trim() || null;

function distinctLogins(rows: TargetProfile[]): string[] {
  return [...new Set(rows.map(loginOf).filter((login): login is string => Boolean(login)))];
}

/**
 * Every profile row in this workspace that is the same person as `target` —
 * the same person the Team roster shows, by construction.
 *
 * Turso still holds pre-cutover duplicate profiles that share a login or an
 * email, and lib/team.ts canonicalizeTenantMembers folds them into one
 * teammate. Deactivating only the clicked row left the other one behind: the
 * roster could still show the person, and a duplicate with a DIFFERENT login
 * could still sign in. So the teammates are taken from canonicalizeTenantMembers
 * itself, and each row it folded away goes to the teammate it was folded into.
 * That fold is greedy, not transitive: X(login 1, x@), Y(login 1, y@) and
 * Z(login 2, y@) are two teammates, X+Y and Z, and deactivating X must not
 * lock Z out. A folded row joins the teammate holding its login, else the one
 * holding its email, and a login always stays with one teammate — it is what
 * signs in, so the ban below can never reach a row we did not deactivate.
 */
async function loadPerson(tenantId: string, target: TargetProfile): Promise<Person> {
  const { data, error } = await getServiceSupabase()
    .from("user_profiles")
    .select(TARGET_COLUMNS)
    .eq("tenant_id", tenantId);
  if (error) throw new ActivationError("lookup_failed", 500);
  const candidates = (data || []) as TargetProfile[];

  const emailOf = (row: { email: string | null }) => row.email?.trim().toLowerCase() || null;
  // TARGET_COLUMNS carries every field the dedup ranks and sorts on; the two it
  // calls string methods on are coalesced so one malformed row cannot throw.
  const teammates = canonicalizeTenantMembers(
    candidates.map(
      (row) => ({ ...row, email: row.email ?? "", joined_at: row.joined_at ?? "" }) as unknown as MemberRow,
    ),
  );
  const teammateOf = new Map<string, string>();
  const byLogin = new Map<string, string>();
  const byEmail = new Map<string, string>();
  for (const row of teammates) {
    teammateOf.set(row.id, row.id);
    const login = loginOf(row);
    const email = emailOf(row);
    if (login) byLogin.set(login, row.id);
    if (email) byEmail.set(email, row.id);
  }
  // Id order keeps the attribution of a login no teammate row holds stable.
  for (const row of [...candidates].sort((left, right) => left.id.localeCompare(right.id))) {
    if (teammateOf.has(row.id)) continue;
    const login = loginOf(row);
    const email = emailOf(row);
    const owner = (login && byLogin.get(login)) || (email && byEmail.get(email)) || null;
    if (!owner) continue;
    teammateOf.set(row.id, owner);
    if (login && !byLogin.has(login)) byLogin.set(login, owner);
  }

  const person = teammateOf.get(target.id) ?? target.id;
  const rows = candidates.filter((row) => (teammateOf.get(row.id) ?? row.id) === person);
  if (!rows.some((row) => row.id === target.id)) rows.push(target);
  return { rows, authUserIds: distinctLogins(rows) };
}

type LeadRow = { id: string; data: Record<string, unknown>; updated_at: string };

/** Leads assigned to any of the person's logins. */
async function openLeadsOf(authUserIds: string[]): Promise<LeadRow[]> {
  const leads: LeadRow[] = [];
  for (const authUserId of authUserIds) {
    const { data, error } = await getServiceSupabase()
      .from("tenant_records")
      .select("id,data,updated_at")
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("entity_type", "lead")
      .eq("data->>assigned_to", authUserId);
    if (error) throw new ActivationError(`lead_read_failed: ${error.message}`, 500);
    leads.push(...((data || []) as LeadRow[]));
  }
  return leads;
}

async function unpaidCommissionCount(tenantId: string, authUserIds: string[]): Promise<number> {
  if (authUserIds.length === 0) return 0;
  const { data, error } = await getServiceSupabase()
    .from("website_sales_commissions")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("rep_user_id", authUserIds)
    .in("status", ["accrued", "approved"]);
  if (error) throw new ActivationError(`commission_read_failed: ${error.message}`, 500);
  return (data || []).length;
}

function memberName(target: TargetProfile): string {
  return (target.display_name || target.full_name || target.email || "Team member").trim();
}

export async function previewDeactivation(args: {
  tenantId: string;
  targetProfileId: string;
  actor: SessionContext;
}): Promise<DeactivationImpact> {
  assertActor(args.actor);
  const target = await loadTarget(args.tenantId, args.targetProfileId);
  const person = await loadPerson(args.tenantId, target);
  const leadHandling = args.tenantId === WEBDEV_TENANT_ID && person.authUserIds.length > 0;
  const plan = leadHandling
    ? planLeadDisposition(await openLeadsOf(person.authUserIds))
    : { pool: [], board: [], keep: [] };
  return {
    member: {
      id: target.id,
      name: memberName(target),
      email: target.email,
      team_role: target.team_role,
    },
    // Any live row keeps the person on the live rosters (the dedup prefers it).
    active: person.rows.some((row) => !row.deactivated_at),
    leadHandling,
    leads: { pool: plan.pool.length, board: plan.board.length, keep: plan.keep.length },
    unpaidCommissions: await unpaidCommissionCount(args.tenantId, person.authUserIds),
  };
}

/** True when this login still holds an active profile outside `exceptProfileIds`
 *  — which is every row of the person in this workspace, so: another workspace. */
async function activeElsewhere(authUserId: string, exceptProfileIds: ReadonlySet<string>): Promise<boolean> {
  const { data, error } = await getServiceSupabase()
    .from("user_profiles")
    .select("id, deactivated_at, tenant_id")
    .eq("auth_user_id", authUserId);
  if (error) throw new ActivationError("profile_scan_failed", 500);
  return ((data || []) as Array<{ id: string; deactivated_at: string | null; tenant_id: string | null }>)
    .some((row) => !exceptProfileIds.has(row.id) && row.tenant_id && !row.deactivated_at);
}

async function unassignWarmLeads(
  rows: LeadRow[],
  ids: string[],
  actorUserId: string,
): Promise<{ done: string[]; refused: string[] }> {
  const db = getServiceSupabase();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const nowIso = new Date().toISOString();
  const done: string[] = [];
  const refused: string[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    const previousOwner = typeof row?.data?.assigned_to === "string" ? row.data.assigned_to : "";
    if (!row || !previousOwner) {
      refused.push(id);
      continue;
    }
    // Compare-and-swap on the owner and version we read — the same guard as
    // releaseLeads — so a lead a founder grabbed a second ago is not stripped.
    const res = await db
      .from("tenant_records")
      .update({
        data: {
          ...row.data,
          ...boardUnassignPatch({ previousOwner, nowIso, cycleId: CURRENT_OASIS_PIPELINE_CYCLE.id }),
        },
        updated_at: nowIso,
      })
      .eq("id", id)
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("entity_type", "lead")
      .eq("data->>assigned_to", previousOwner)
      .eq("updated_at", row.updated_at)
      .select("id");
    if (res.error || (res.data as unknown[] | null)?.length !== 1) refused.push(id);
    else done.push(id);
  }
  if (done.length > 0) {
    const content = "Owner deactivated — lead kept on the board, unassigned, for the founders.";
    const tracking = await db.from("lead_interactions").insert(
      done.map((id) => ({
        tenant_id: WEBDEV_TENANT_ID,
        lead_id: id,
        type: "lead_reassigned",
        channel: "system",
        direction: "internal",
        agent_source: "team_deactivation",
        actor_user_id: actorUserId,
        subject: "Owner deactivated",
        content,
        content_preview: content,
        created_at: nowIso,
        metadata: {
          action: "deactivation_unassign",
          from_assigned_to: byId.get(id)?.data?.assigned_to ?? null,
          assigned_to: null,
          from_stage: byId.get(id)?.data?.stage ?? null,
        },
      })),
    );
    if (tracking.error) {
      console.error("[team-activation] leads unassigned but interaction tracking failed", {
        leadIds: done,
        error: tracking.error.message,
      });
    }
  }
  return { done, refused };
}

async function auditEvent(
  tenantId: string,
  action: string,
  profileId: string,
  actor: SessionContext,
  after: Record<string, unknown>,
) {
  // The SERVICE client, not getAuthedSupabase(): under turso_cloud the authed
  // client has no data plane (its .rpc throws), so an audit written through it
  // never lands. The service path reaches the Turso log_tenant_event shim,
  // which stores no actor of its own — hence the actor in metadata.
  const { error } = await getServiceSupabase().rpc("log_tenant_event", {
    p_tenant_id: tenantId,
    p_action_type: action,
    p_target_table: "user_profiles",
    p_target_id: profileId,
    p_after: after,
    p_metadata: { actor_profile_id: actor.profileId, actor_user_id: actor.authUserId },
  });
  // Soft-fail like member.role_change — the person is already (de)activated —
  // but loudly.
  if (error) console.error(`[team-activation] audit ${action} failed`, error.message);
}

export async function deactivateMember(args: {
  tenantId: string;
  targetProfileId: string;
  actor: SessionContext;
  reason?: string | null;
}): Promise<DeactivationResult> {
  assertActor(args.actor);
  const target = await loadTarget(args.tenantId, args.targetProfileId);
  const person = await loadPerson(args.tenantId, target);
  // Checked across every row of the person: a duplicate row can be the owner's,
  // or carry the actor's own login, and deactivating it would lock them out.
  if (person.rows.some((row) => row.is_owner)) throw new ActivationError("cannot_deactivate_owner", 409);
  if (
    person.rows.some((row) => row.id === args.actor.profileId) ||
    person.authUserIds.includes(args.actor.authUserId)
  ) {
    throw new ActivationError("cannot_deactivate_self", 409);
  }
  const profileIds = person.rows.map((row) => row.id);

  const nowIso = new Date().toISOString();
  const reason = (args.reason || "").trim().slice(0, 300) || null;

  // 1. Roster. A row already inactive keeps its original deactivation stamp.
  const stillActive = person.rows.filter((row) => !row.deactivated_at).map((row) => row.id);
  if (stillActive.length > 0) {
    const { error } = await getServiceSupabase()
      .from("user_profiles")
      .update({
        deactivated_at: nowIso,
        deactivated_by: args.actor.profileId,
        deactivation_reason: reason,
      })
      .in("id", stillActive)
      .eq("tenant_id", args.tenantId);
    if (error) throw new ActivationError(`deactivate_failed: ${error.message}`, 500);
  }
  // Reps who reported to this person stop pointing at an inactive manager —
  // otherwise a reactivated-later manager would silently regain their book.
  if (person.authUserIds.length > 0) {
    const { error } = await getServiceSupabase()
      .from("user_profiles")
      .update({ manager_user_id: null })
      .eq("tenant_id", args.tenantId)
      .in("manager_user_id", person.authUserIds);
    if (error) throw new ActivationError(`manager_unlink_failed: ${error.message}`, 500);
  }

  // 2. Login — every login the person has, or the one we skip still signs in.
  const everyRow = new Set(profileIds);
  const loginsKept: string[] = [];
  let loginsBlocked = 0;
  for (const authUserId of person.authUserIds) {
    if (await activeElsewhere(authUserId, everyRow)) {
      loginsKept.push(authUserId);
      continue;
    }
    await getTursoClient().execute({
      sql: `UPDATE "_supabase_auth_users"
               SET banned_until = ?, session_version = session_version + 1
             WHERE id = ? AND (banned_until IS NULL OR banned_until = ?)`,
      args: [DEACTIVATION_BAN_UNTIL, authUserId, DEACTIVATION_BAN_UNTIL],
    });
    loginsBlocked += 1;
  }
  // Blocked means ALL of them: one login left open is not a blocked person.
  const loginBlocked = person.authUserIds.length > 0 && loginsKept.length === 0;
  let loginNote: string | null = null;
  if (person.authUserIds.length === 0) {
    loginNote = "no login linked to this profile";
  } else if (loginsKept.length > 0) {
    loginNote =
      person.authUserIds.length === 1
        ? "login kept: this person is still active in another workspace"
        : `${loginsKept.length} of ${person.authUserIds.length} logins kept: still active in another workspace`;
  }

  // 3. Leads.
  let released = 0;
  let boardUnassigned = 0;
  const refused: string[] = [];
  const leadHandling = args.tenantId === WEBDEV_TENANT_ID && person.authUserIds.length > 0;
  let plan = { pool: [] as string[], board: [] as string[], keep: [] as string[] };
  if (leadHandling) {
    const rows = await openLeadsOf(person.authUserIds);
    plan = planLeadDisposition(rows);
    if (plan.pool.length > 0) {
      const res = await releaseLeads(args.actor.authUserId, true, plan.pool);
      released = res.released.length;
      refused.push(...res.refused);
    }
    if (plan.board.length > 0) {
      const res = await unassignWarmLeads(rows, plan.board, args.actor.authUserId);
      boardUnassigned = res.done.length;
      refused.push(...res.refused);
    }
  }

  // 4. Audit.
  await auditEvent(args.tenantId, "member.deactivate", target.id, args.actor, {
    deactivated_at: nowIso,
    reason,
    profile_ids: profileIds,
    login_blocked: loginBlocked,
    logins_blocked: loginsBlocked,
    leads_released: released,
    leads_unassigned_on_board: boardUnassigned,
    leads_refused: refused.length,
  });

  return {
    impact: {
      member: { id: target.id, name: memberName(target), email: target.email, team_role: target.team_role },
      active: false,
      leadHandling,
      leads: { pool: plan.pool.length, board: plan.board.length, keep: plan.keep.length },
      unpaidCommissions: await unpaidCommissionCount(args.tenantId, person.authUserIds),
    },
    loginBlocked,
    loginNote,
    released,
    boardUnassigned,
    refused,
  };
}

export async function reactivateMember(args: {
  tenantId: string;
  targetProfileId: string;
  actor: SessionContext;
}): Promise<{ loginRestored: boolean }> {
  assertActor(args.actor);
  const target = await loadTarget(args.tenantId, args.targetProfileId);
  // The same person deactivateMember acted on — whichever of their rows the
  // Team page shows (once all are inactive, that can be a richer stale one).
  const person = await loadPerson(args.tenantId, target);

  // Only the rows the LAST deactivation stamped: one update wrote the same
  // deactivated_at + deactivated_by to all of them, and deactivateMember left
  // an already-inactive duplicate's older stamp alone. Reviving that duplicate
  // would put a stale row back into the roster dedup, where a richer one (an
  // old admin row) outranks the live row and replaces the person's role. A
  // person with a live row is already active: there is nothing to undo.
  const inactive = person.rows.filter((row) => row.deactivated_at);
  const stampTime = (row: TargetProfile) => Date.parse(row.deactivated_at ?? "") || 0;
  const last = person.rows.some((row) => !row.deactivated_at)
    ? null
    : inactive.reduce<TargetProfile | null>(
        (latest, row) => (!latest || stampTime(row) > stampTime(latest) ? row : latest),
        null,
      );
  const stampGroup = (anchor: TargetProfile) =>
    inactive.filter(
      (row) => row.deactivated_at === anchor.deactivated_at && row.deactivated_by === anchor.deactivated_by,
    );
  let restore = last ? stampGroup(last) : [];
  // The clicked row itself is inactive, yet the grouping found a live row: a
  // leftover duplicate carrying this person's email and ANOTHER teammate's
  // login can pull that teammate in. Restore the clicked row's own batch —
  // never report "reactivated" while leaving the row and its login blocked.
  // (No such cross-linked rows existed live on 2026-09-24; this closes the gap.)
  const targetLogin = target.auth_user_id?.trim() || null;
  const targetLoginIsLive =
    !targetLogin || person.rows.some((row) => !row.deactivated_at && row.auth_user_id?.trim() === targetLogin);
  if (restore.length === 0 && target.deactivated_at && !targetLoginIsLive) {
    restore = stampGroup(target);
    if (!restore.some((row) => row.id === target.id)) restore = [...restore, target];
  }
  const profileIds = restore.map((row) => row.id);
  if (profileIds.length > 0) {
    const { error } = await getServiceSupabase()
      .from("user_profiles")
      .update({ deactivated_at: null, deactivated_by: null, deactivation_reason: null })
      .in("id", profileIds)
      .eq("tenant_id", args.tenantId);
    if (error) throw new ActivationError(`reactivate_failed: ${error.message}`, 500);
  }

  // Lift only OUR ban, and only on the logins of the rows coming back — a
  // login whose every row stays retired stays blocked. Leads are not handed
  // back — the founders decide that.
  let loginRestored = false;
  for (const authUserId of distinctLogins(restore)) {
    const res = await getTursoClient().execute({
      sql: `UPDATE "_supabase_auth_users" SET banned_until = NULL
             WHERE id = ? AND banned_until = ?`,
      args: [authUserId, DEACTIVATION_BAN_UNTIL],
    });
    if (res.rowsAffected > 0) loginRestored = true;
  }
  await auditEvent(args.tenantId, "member.reactivate", target.id, args.actor, {
    login_restored: loginRestored,
    profile_ids: profileIds,
  });
  return { loginRestored };
}
