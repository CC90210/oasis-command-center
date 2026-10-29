"use server";

/**
 * Settings > Brand: save this workspace's sending identity (the form in
 * components/settings/TenantSenderForm.tsx): the business name its email goes
 * out under, the legal name and postal address every footer carries, the
 * address it sends from and an optional reply-to.
 *
 * A SERVER ACTION ON THE BRAND PAGE, NOT A NEW /api ROUTE. On this build every
 * new route entry carries its own copy of the shared session and database
 * modules (PR #531 measured lib/api-auth.ts emitted 161 times), and the first
 * version of this save as POST /api/settings/sender added 284 KiB to a Worker
 * with 59 KiB left under its budget. An action runs inside the Brand page's
 * own server bundle, which already holds every module it uses.
 *
 * WHO. The owner or an admin of the signed-in workspace: the same gate as the
 * Brand page itself (maySeeSettingsSection "brand"), so the page and the save
 * can never disagree about who may change it. Anyone else is refused and
 * nothing is written.
 *
 * WHICH WORKSPACE. Only the session's. A tenant in the input is ignored; the
 * write and its audit row name the session tenant and nothing else.
 *
 * WHICH WORKSPACES CAN'T. OASIS's own workspaces and the retired client send
 * under fixed identities (lib/email/brands.ts). Storing a second identity for
 * them would make two sources of truth for who they are, so this refuses and
 * nothing is written.
 *
 * VERIFIED. The from address is checked live against this workspace's own
 * connected mailboxes before it is saved (lib/email/tenant-sender.ts). Saving
 * an unverified identity is allowed, and the answer says exactly what is
 * missing; no email goes out under it until the check passes.
 *
 * Every save is written in one batch with its tenant_audit_log row.
 */

import { loadSettingsViewer } from "@/components/settings/settings-viewer";
import { maySeeSettingsSection } from "@/components/settings/settings-sections";
import { brandForTenant } from "@/lib/email/brand-for-tenant";
import {
  describeSender,
  saveTenantSender,
  validateSenderInput,
  verifySenderMailbox,
  type SaveSenderResult,
} from "@/lib/email/tenant-sender";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export async function saveSenderIdentity(input: unknown): Promise<SaveSenderResult> {
  try {
    const viewer = await loadSettingsViewer();
    if (!viewer.ok) return { ok: false, error: "not_signed_in", message: "Sign in again to change this." };
    if (!maySeeSettingsSection(viewer.access, "brand")) {
      return { ok: false, error: "forbidden", message: "Only an owner or admin of this workspace can change how its email is sent." };
    }
    if (brandForTenant({ tenantId: viewer.tenantId, tenantSlug: viewer.tenantSlug }) !== null) {
      return { ok: false, error: "identity_fixed", message: "This workspace sends under a fixed identity, which can't be changed here." };
    }

    const parsed = validateSenderInput(input);
    if (!parsed.ok) return { ok: false, error: "invalid_field", message: parsed.message, field: parsed.field };

    const db = tursoConfigured() ? getTursoClient() : null;
    if (!db) return { ok: false, error: "unavailable", message: "Saving isn't available right now. Nothing was changed." };

    const verification = await verifySenderMailbox(db, viewer.tenantId, parsed.value.fromAddress);
    const saved = await saveTenantSender(db, {
      tenantId: viewer.tenantId,
      actorUserId: viewer.userId,
      input: parsed.value,
      verification,
      now: new Date(),
    });
    if (!saved.ok) {
      return {
        ok: false,
        error: "not_set_up",
        message: "Sending identities can't be saved yet: this part of OASIS is still being set up. Nothing was changed.",
      };
    }
    return { ok: true, verified: verification.verified, status: describeSender({ state: "saved", sender: saved.sender, verification }) };
  } catch (error) {
    console.error("[settings.sender.save]", error);
    return { ok: false, error: "save_failed", message: "The sending identity couldn't be saved. Nothing was changed; try again." };
  }
}
