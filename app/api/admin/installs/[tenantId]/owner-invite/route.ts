/**
 * POST /api/admin/installs/[tenantId]/owner-invite - send the founder their
 * owner invite (tenant_invites.kind = 'owner_claim').
 *
 * Body: { email }
 *
 * THE ONLY ROUTE THAT MINTS AN OWNER INVITE. Redeeming it makes the founder
 * the workspace owner in the same write that claims it. Operators only;
 * everyone else gets a 404. Refused for OASIS's own and retired workspaces,
 * for a workspace that already has an owner, and (503) until migration
 * bravo__196 is applied.
 *
 * Delivery: emailed through the auth mailer. When delivery fails the link is
 * returned once so the operator can send it another way; it is never logged.
 *
 * DELETE /api/admin/installs/[tenantId]/owner-invite  Body: { invite_id }
 * revokes one open owner invite of that workspace (2026-09-30 fix pass: there
 * was no way to take back an invite sent to a wrong address). Audited.
 */

import { NextResponse, type NextRequest } from "next/server";
import { sendAuthEmail } from "@/lib/auth-email";
import { OASIS_SEED_TENANT_IDS } from "@/lib/manifest/seeds";
import { OwnerInviteError, mintOwnerClaimInvite, ownerInviteEmailText, revokeOwnerInvite } from "@/lib/provisioning/owner-invite";
import { operatorFromSession } from "@/lib/provisioning/operator-session";
import { getServiceSupabase } from "@/lib/supabase-server";
import { teamInviteUrl } from "@/lib/team-invite-email";
import { isRetiredTenant } from "@/lib/tenant/retired";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS: Record<OwnerInviteError["code"], number> = {
  invite_email_required: 400,
  workspace_already_has_owner: 409,
  migration_196_not_applied: 503,
  owner_invite_create_failed: 500,
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  const operator = await operatorFromSession();
  if (!operator) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const { tenantId } = await params;
  if (!UUID_RE.test(tenantId)) return NextResponse.json({ ok: false, error: "invalid_workspace" }, { status: 400 });
  if (OASIS_SEED_TENANT_IDS.has(tenantId) || isRetiredTenant(tenantId)) {
    return NextResponse.json(
      { ok: false, error: "protected_workspace", message: "Owner invites are for client workspaces only." },
      { status: 403 },
    );
  }

  let body: { email?: unknown };
  try {
    body = (await req.json()) as { email?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const db = getServiceSupabase();
  const tenant = await db.from("tenants").select("id, name").eq("id", tenantId).maybeSingle();
  if (tenant.error) {
    console.error("[admin.installs.owner_invite] workspace read failed", { tenantId, error: tenant.error.message });
    return NextResponse.json({ ok: false, error: "workspace_unreadable", message: "Could not read the workspace. Try again." }, { status: 503 });
  }
  if (!tenant.data) return NextResponse.json({ ok: false, error: "workspace_not_found" }, { status: 404 });
  const workspaceName = String((tenant.data as { name?: unknown }).name ?? "").trim() || "your new workspace";

  let invite: Awaited<ReturnType<typeof mintOwnerClaimInvite>>;
  try {
    invite = await mintOwnerClaimInvite({ tenantId, email: String(body.email ?? ""), createdBy: operator.authUserId });
  } catch (err) {
    if (err instanceof OwnerInviteError) {
      if (err.code === "owner_invite_create_failed") console.error("[admin.installs.owner_invite]", err.message);
      return NextResponse.json({ ok: false, error: err.code, message: err.message }, { status: STATUS[err.code] });
    }
    console.error("[admin.installs.owner_invite] unexpected", err);
    return NextResponse.json({ ok: false, error: "owner_invite_create_failed", message: "Could not create the invite." }, { status: 500 });
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const inviteUrl = teamInviteUrl(invite.rawToken);
  const delivery = await sendAuthEmail({
    to: email,
    subject: `Your invite to ${workspaceName}`,
    text: ownerInviteEmailText({ workspaceName, inviteUrl, expiresAt: invite.expiresAt }),
  });
  if (!delivery.ok) {
    console.error("[admin.installs.owner_invite] delivery failed", { tenantId, inviteId: invite.id, code: delivery.code });
  }

  // Audit. The invite exists either way; a failed audit write is reported to
  // the operator rather than hidden, and the invite stays valid.
  const audit = await db.rpc("log_tenant_event", {
    p_tenant_id: tenantId,
    p_action_type: "invite.owner_claim.create",
    p_target_table: "tenant_invites",
    p_target_id: invite.id,
    p_after: { email, expires_at: invite.expiresAt, email_sent: delivery.ok, superseded: invite.superseded },
    p_metadata: { operator_auth_user_id: operator.authUserId },
  });
  if (audit.error) {
    console.error("[admin.installs.owner_invite] audit write failed", { tenantId, inviteId: invite.id, error: audit.error.message });
  }

  return NextResponse.json(
    {
      ok: true,
      invite: {
        id: invite.id,
        email,
        expires_at: invite.expiresAt,
        email_sent: delivery.ok,
        // The link goes back to the operator only when the email did not, so
        // they can send it another way. Never logged.
        invite_url: delivery.ok ? null : inviteUrl,
        audited: !audit.error,
      },
      message: delivery.ok
        ? `Owner invite emailed to ${email}.`
        : `Invite created, but the email did not send. Copy the link below and send it to ${email}.`,
    },
    { status: 201 },
  );
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  const operator = await operatorFromSession();
  if (!operator) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const { tenantId } = await params;
  if (!UUID_RE.test(tenantId)) return NextResponse.json({ ok: false, error: "invalid_workspace" }, { status: 400 });

  let body: { invite_id?: unknown };
  try {
    body = (await req.json()) as { invite_id?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const inviteId = typeof body.invite_id === "string" ? body.invite_id.trim() : "";
  if (!inviteId) return NextResponse.json({ ok: false, error: "invite_id_required" }, { status: 400 });

  let revoked: boolean;
  try {
    revoked = await revokeOwnerInvite({ tenantId, inviteId });
  } catch (err) {
    console.error("[admin.installs.owner_invite.revoke]", { tenantId, inviteId, error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { ok: false, error: "owner_invite_revoke_failed", message: "Could not revoke the invite. It may still work. Try again." },
      { status: 503 },
    );
  }
  if (!revoked) {
    return NextResponse.json(
      { ok: false, error: "invite_not_open", message: "That invite is no longer open (already used, revoked or expired)." },
      { status: 404 },
    );
  }

  const audit = await getServiceSupabase().rpc("log_tenant_event", {
    p_tenant_id: tenantId,
    p_action_type: "invite.owner_claim.revoke",
    p_target_table: "tenant_invites",
    p_target_id: inviteId,
    p_after: { revoked: true },
    p_metadata: { operator_auth_user_id: operator.authUserId },
  });
  if (audit.error) {
    console.error("[admin.installs.owner_invite.revoke] audit write failed", { tenantId, inviteId, error: audit.error.message });
  }
  return NextResponse.json({ ok: true, invite: { id: inviteId, audited: !audit.error }, message: "Invite revoked. The link no longer works." });
}
