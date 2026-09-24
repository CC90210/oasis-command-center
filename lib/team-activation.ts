import "server-only";

/**
 * Deactivate / reactivate a teammate — the I/O side. Rules: ./team-activation-rules.
 *
 * Deactivation is the reversible alternative to removeMember (2026-09-24, CC:
 * "deactivated instead of deleted ... reactivate and deactivate them" from
 * Settings). It does four things, in this order:
 *
 *   1. marks the profile inactive (user_profiles.deactivated_*), which drops
 *      the person from every live roster in lib/team.ts;
 *   2. bans the login and bumps session_version, so every open cookie fails its
 *      next server check (lib/turso-auth.ts verifySessionAgainstDb) — unless the
 *      same login still has an ACTIVE profile in another workspace, in which case
 *      banning it would lock them out of work they still do;
 *   3. on the OASIS sales tenant, moves their open leads per the disposition
 *      rule (cold → pool, warm → board unassigned, closed → kept);
 *   4. writes the tenant audit event.
 *
 * Step 3 is safe to repeat: a second deactivate of an already-inactive member
 * re-runs only the lead sweep, which finds whatever a failed first run left.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient } from "@/lib/turso";
import { isTrueAdminRole, type SessionContext } from "@/lib/team";
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
  deactivated_at: string | null;
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

async function loadTarget(tenantId: string, profileId: string): Promise<TargetProfile> {
  const { data, error } = await getServiceSupabase()
    .from("user_profiles")
    .select("id, tenant_id, is_owner, auth_user_id, email, full_name, display_name, team_role, deactivated_at")
    .eq("id", profileId)
    .maybeSingle();
  if (error) throw new ActivationError("lookup_failed", 500);
  const target = data as TargetProfile | null;
  if (!target) throw new ActivationError("member_not_found", 404);
  if (target.tenant_id !== tenantId) throw new ActivationError("forbidden", 403);
  return target;
}

type LeadRow = { id: string; data: Record<string, unknown>; updated_at: string };

async function openLeadsOf(authUserId: string): Promise<LeadRow[]> {
  const { data, error } = await getServiceSupabase()
    .from("tenant_records")
    .select("id,data,updated_at")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .eq("data->>assigned_to", authUserId);
  if (error) throw new ActivationError(`lead_read_failed: ${error.message}`, 500);
  return (data || []) as LeadRow[];
}

async function unpaidCommissionCount(tenantId: string, authUserId: string): Promise<number> {
  const { data, error } = await getServiceSupabase()
    .from("website_sales_commissions")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("rep_user_id", authUserId)
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
  const leadHandling = args.tenantId === WEBDEV_TENANT_ID && Boolean(target.auth_user_id);
  const plan = leadHandling
    ? planLeadDisposition(await openLeadsOf(target.auth_user_id as string))
    : { pool: [], board: [], keep: [] };
  return {
    member: {
      id: target.id,
      name: memberName(target),
      email: target.email,
      team_role: target.team_role,
    },
    active: !target.deactivated_at,
    leadHandling,
    leads: { pool: plan.pool.length, board: plan.board.length, keep: plan.keep.length },
    unpaidCommissions: target.auth_user_id
      ? await unpaidCommissionCount(args.tenantId, target.auth_user_id)
      : 0,
  };
}

/** True when this login still holds an active profile in some other workspace. */
async function activeElsewhere(authUserId: string, exceptProfileId: string): Promise<boolean> {
  const { data, error } = await getServiceSupabase()
    .from("user_profiles")
    .select("id, deactivated_at, tenant_id")
    .eq("auth_user_id", authUserId);
  if (error) throw new ActivationError("profile_scan_failed", 500);
  return ((data || []) as Array<{ id: string; deactivated_at: string | null; tenant_id: string | null }>)
    .some((row) => row.id !== exceptProfileId && row.tenant_id && !row.deactivated_at);
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
  if (target.is_owner) throw new ActivationError("cannot_deactivate_owner", 409);
  if (target.id === args.actor.profileId) throw new ActivationError("cannot_deactivate_self", 409);

  const nowIso = new Date().toISOString();
  const reason = (args.reason || "").trim().slice(0, 300) || null;

  // 1. Roster.
  if (!target.deactivated_at) {
    const { error } = await getServiceSupabase()
      .from("user_profiles")
      .update({
        deactivated_at: nowIso,
        deactivated_by: args.actor.profileId,
        deactivation_reason: reason,
      })
      .eq("id", target.id)
      .eq("tenant_id", args.tenantId);
    if (error) throw new ActivationError(`deactivate_failed: ${error.message}`, 500);
  }
  // Reps who reported to this person stop pointing at an inactive manager —
  // otherwise a reactivated-later manager would silently regain their book.
  if (target.auth_user_id) {
    const { error } = await getServiceSupabase()
      .from("user_profiles")
      .update({ manager_user_id: null })
      .eq("tenant_id", args.tenantId)
      .eq("manager_user_id", target.auth_user_id);
    if (error) throw new ActivationError(`manager_unlink_failed: ${error.message}`, 500);
  }

  // 2. Login.
  let loginBlocked = false;
  let loginNote: string | null = null;
  if (!target.auth_user_id) {
    loginNote = "no login linked to this profile";
  } else if (await activeElsewhere(target.auth_user_id, target.id)) {
    loginNote = "login kept: this person is still active in another workspace";
  } else {
    await getTursoClient().execute({
      sql: `UPDATE "_supabase_auth_users"
               SET banned_until = ?, session_version = session_version + 1
             WHERE id = ? AND (banned_until IS NULL OR banned_until = ?)`,
      args: [DEACTIVATION_BAN_UNTIL, target.auth_user_id, DEACTIVATION_BAN_UNTIL],
    });
    loginBlocked = true;
  }

  // 3. Leads.
  let released = 0;
  let boardUnassigned = 0;
  const refused: string[] = [];
  const leadHandling = args.tenantId === WEBDEV_TENANT_ID && Boolean(target.auth_user_id);
  let plan = { pool: [] as string[], board: [] as string[], keep: [] as string[] };
  if (leadHandling) {
    const rows = await openLeadsOf(target.auth_user_id as string);
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
    login_blocked: loginBlocked,
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
      unpaidCommissions: target.auth_user_id
        ? await unpaidCommissionCount(args.tenantId, target.auth_user_id)
        : 0,
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
  const { error } = await getServiceSupabase()
    .from("user_profiles")
    .update({ deactivated_at: null, deactivated_by: null, deactivation_reason: null })
    .eq("id", target.id)
    .eq("tenant_id", args.tenantId);
  if (error) throw new ActivationError(`reactivate_failed: ${error.message}`, 500);

  // Lift only OUR ban. Leads are not handed back — the founders decide that.
  let loginRestored = false;
  if (target.auth_user_id) {
    const res = await getTursoClient().execute({
      sql: `UPDATE "_supabase_auth_users" SET banned_until = NULL
             WHERE id = ? AND banned_until = ?`,
      args: [target.auth_user_id, DEACTIVATION_BAN_UNTIL],
    });
    loginRestored = res.rowsAffected > 0;
  }
  await auditEvent(args.tenantId, "member.reactivate", target.id, args.actor, { login_restored: loginRestored });
  return { loginRestored };
}
