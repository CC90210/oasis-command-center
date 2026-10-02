/**
 * POST /api/settings/sender - save this workspace's sending identity
 * (Settings > Brand): the business name its email goes out under, the legal
 * name and postal address every footer carries, the address it sends from and
 * an optional reply-to.
 *
 * Body: { display_name, legal_name, postal_address, from_address, reply_to? }
 *
 * WHO. The owner or an admin of the signed-in workspace: the same gate as the
 * Settings > Brand page (maySeeSettingsSection "brand"), so the page and the
 * write can never disagree about who may change it. Anyone else gets 403 and
 * nothing is written.
 *
 * WHICH WORKSPACE. Only the session's. A tenant in the body is ignored; the
 * write and its audit row name the session tenant and nothing else.
 *
 * WHICH WORKSPACES CAN'T. OASIS's own workspaces and the retired client send
 * under fixed identities (lib/email/brands.ts). Storing a second identity for
 * them would make two sources of truth for who they are, so this refuses
 * (409) and nothing is written.
 *
 * VERIFIED. The from address is checked live against this workspace's own
 * connected mailboxes before it is saved (lib/email/tenant-sender.ts). Saving
 * an unverified identity is allowed, and the answer says exactly what is
 * missing; no email goes out under it until the check passes.
 *
 * Every save is written in one batch with its tenant_audit_log row.
 */
import { NextResponse, type NextRequest } from "next/server";
import { loadSettingsViewer } from "@/components/settings/settings-viewer";
import { maySeeSettingsSection } from "@/components/settings/settings-sections";
import { brandForTenant } from "@/lib/email/brand-for-tenant";
import {
  describeSender,
  saveTenantSender,
  validateSenderInput,
  verifySenderMailbox,
} from "@/lib/email/tenant-sender";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function refuse(status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, message, ...extra }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const viewer = await loadSettingsViewer();
    if (!viewer.ok) return refuse(401, "not_signed_in", "Sign in again to change this.");
    if (!maySeeSettingsSection(viewer.access, "brand")) {
      return refuse(403, "forbidden", "Only an owner or admin of this workspace can change how its email is sent.");
    }
    if (brandForTenant({ tenantId: viewer.tenantId, tenantSlug: viewer.tenantSlug }) !== null) {
      return refuse(409, "identity_fixed", "This workspace sends under a fixed identity, which can't be changed here.");
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return refuse(400, "invalid_json", "Send the sending identity as a form with its five fields.");
    }
    const parsed = validateSenderInput(body);
    if (!parsed.ok) return refuse(400, "invalid_field", parsed.message, { field: parsed.field });

    const db = tursoConfigured() ? getTursoClient() : null;
    if (!db) return refuse(503, "unavailable", "Saving isn't available right now. Nothing was changed.");

    const verification = await verifySenderMailbox(db, viewer.tenantId, parsed.value.fromAddress);
    const saved = await saveTenantSender(db, {
      tenantId: viewer.tenantId,
      actorUserId: viewer.userId,
      input: parsed.value,
      verification,
      now: new Date(),
    });
    if (!saved.ok) {
      return refuse(503, "not_set_up", "Sending identities can't be saved yet: this part of OASIS is still being set up. Nothing was changed.");
    }
    const status = describeSender({ state: "saved", sender: saved.sender, verification });
    return NextResponse.json({ ok: true, verified: verification.verified, status });
  } catch (error) {
    console.error("[settings.sender.save]", error);
    return refuse(500, "save_failed", "The sending identity couldn't be saved. Nothing was changed; try again.");
  }
}
