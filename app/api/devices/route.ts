/**
 * GET    /api/devices             — list paired machines for the authed tenant
 * PATCH  /api/devices {id,label}  — rename one of YOUR computers (owner only)
 * DELETE /api/devices?id=<uuid>   — revoke a pairing (sets revoked_at, the
 *                                   bridge daemon will see 403 on next ping
 *                                   and self-stop)
 *
 * OWNER SEMANTICS (O3a). A computer belongs to the person who paired it:
 *   - GET returns YOUR OWN computers always. An owner or admin ALSO sees
 *     every other member's ("Team computers") — before this, any member of
 *     a client workspace could list and revoke every pairing in it
 *     (O3a security rule, app/api/devices/route.ts:17-47).
 *   - DELETE: disconnecting your own computer never needs anything extra.
 *     Disconnecting someone else's requires both session.isAdmin AND an
 *     explicit confirm, and is written to the tenant audit log through
 *     log_tenant_event — the same trail lib/team-activation.ts writes to.
 */

import { NextResponse, type NextRequest } from "next/server";
import { bad } from "@/lib/api-helpers";
import { sameOrigin } from "@/lib/calendar/http";
import { deviceLabelProblem } from "@/lib/devices/label";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await resolveSessionContext();
  if (!session.ok) return bad(401, "unauthorized");
  const tenantId = session.tenantId;
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("bridge_pairings")
    .select(
      "id, user_id, label, machine_fingerprint, last_seen_at, last_seen_ip, created_at, revoked_at, scope, paired_via, claim_enabled_at, claim_state_at, claim_blocked_reason, claim_capacity",
    )
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[devices.GET.list]", { tenantId, userId: session.userId, error: error.message });
    return bad(503, "devices_unavailable");
  }
  const rows = (data || []) as Array<{ user_id: string | null } & Record<string, unknown>>;
  // Everyone sees their own; an owner or admin also sees the team's.
  const devices = session.isAdmin ? rows : rows.filter((r) => r.user_id === session.userId);

  // Owner display names, for "Team computers" rows only (never for the
  // viewer's own, which already say "your"). Read only the distinct owners
  // actually present on someone else's row, so a non-admin (who only ever
  // sees their own rows) never pays this read.
  const otherOwnerIds = Array.from(
    new Set(
      devices
        .filter((r) => r.user_id !== session.userId)
        .map((r) => r.user_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  const ownerNameById = new Map<string, string>();
  if (otherOwnerIds.length > 0) {
    const owners = await db
      .from("user_profiles")
      .select("auth_user_id, display_name, full_name, email")
      .eq("tenant_id", tenantId)
      .is("deactivated_at", null)
      .in("auth_user_id", otherOwnerIds);
    if (owners.error) {
      console.error("[devices.GET.owner_names]", owners.error.message);
    } else {
      for (const row of (owners.data || []) as Array<{
        auth_user_id: string | null;
        display_name: string | null;
        full_name: string | null;
        email: string | null;
      }>) {
        if (row.auth_user_id) {
          const name = row.display_name || row.full_name || row.email;
          if (name) ownerNameById.set(row.auth_user_id, name);
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    devices: devices.map((r) => ({
      ...r,
      mine: r.user_id === session.userId,
      owner_name: r.user_id && r.user_id !== session.userId ? ownerNameById.get(r.user_id) || null : null,
    })),
  });
}

/**
 * PATCH /api/devices  { id, label }  - rename one of YOUR computers.
 *
 * A Mac with no hostname set reports the router's DHCP address as its name, so a
 * pairing could be called "192.168.11.27 (Mac)" with no way to change it. The
 * owner (and only the owner: an admin has no business renaming a teammate's
 * computer) sets a name they recognise. Tenant-scoped on the read AND the
 * write; a revoked pairing cannot be renamed. The machine fingerprint is not
 * touched, so the computer does not have to pair again.
 */
export async function PATCH(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) return bad(401, "unauthorized");
  if (!sameOrigin(req)) return bad(403, "cross_origin_refused");

  let body: { id?: unknown; label?: unknown } | null = null;
  try {
    body = (await req.json()) as { id?: unknown; label?: unknown };
  } catch {
    return bad(400, "invalid_json");
  }
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) return bad(400, "id required");
  const problem = deviceLabelProblem(body?.label);
  if (problem) return bad(400, problem);
  const label = (body!.label as string).trim();

  const tenantId = session.tenantId;
  const db = getServiceSupabase();
  const row = await db
    .from("bridge_pairings")
    .select("id, user_id, revoked_at")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (row.error) {
    console.error("[devices.PATCH.lookup]", { tenantId, userId: session.userId, pairingId: id, error: row.error.message });
    return bad(503, "device_lookup_unavailable");
  }
  if (!row.data) return bad(404, "pairing_not_found");
  const pairing = row.data as { id: string; user_id: string | null; revoked_at: string | null };
  if (pairing.user_id !== session.userId) return bad(403, "not_your_computer");
  if (pairing.revoked_at) return bad(409, "pairing_revoked");

  const { error } = await db
    .from("bridge_pairings")
    .update({ label })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("user_id", session.userId);
  if (error) {
    console.error("[devices.PATCH.rename]", { tenantId, userId: session.userId, pairingId: id, error: error.message });
    return bad(503, "device_rename_unavailable");
  }
  return NextResponse.json({ ok: true, label });
}

export async function DELETE(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) return bad(401, "unauthorized");
  const tenantId = session.tenantId;
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return bad(400, "id required");
  const db = getServiceSupabase();

  const row = await db
    .from("bridge_pairings")
    .select("id, user_id, label, revoked_at")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (row.error) {
    console.error("[devices.DELETE.lookup]", { tenantId, userId: session.userId, pairingId: id, error: row.error.message });
    return bad(503, "device_lookup_unavailable");
  }
  if (!row.data) return bad(404, "pairing_not_found");
  const pairing = row.data as { id: string; user_id: string | null; label: string | null; revoked_at: string | null };

  const isMine = pairing.user_id === session.userId;
  if (!isMine) {
    if (!session.isAdmin) return bad(403, "not_your_computer");
    const confirmed = url.searchParams.get("confirm") === "true";
    if (!confirmed) {
      return NextResponse.json(
        {
          ok: false,
          error: "confirm_required",
          message: `Disconnecting ${pairing.label || "this computer"} is someone else's computer. Add confirm=true to proceed.`,
        },
        { status: 409 },
      );
    }
  }

  // Tenant-scope the update — operator can't revoke another tenant's pairing
  const { error } = await db
    .from("bridge_pairings")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId);
  if (error) {
    console.error("[devices.DELETE.revoke]", { tenantId, userId: session.userId, pairingId: id, error: error.message });
    return bad(503, "device_disconnect_unavailable");
  }

  if (!isMine) {
    const audit = await db.rpc("log_tenant_event", {
      p_tenant_id: tenantId,
      p_action_type: "device.admin_disconnect",
      p_target_table: "bridge_pairings",
      p_target_id: id,
      p_after: { revoked_at: new Date().toISOString(), label: pairing.label, owner_user_id: pairing.user_id },
      p_metadata: { actor_user_id: session.userId, actor_profile_id: session.profileId },
    });
    if (audit.error) console.error("[devices.DELETE] audit log_tenant_event failed", audit.error.message);
  }

  return NextResponse.json({ ok: true });
}
