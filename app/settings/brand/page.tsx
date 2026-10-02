/**
 * /settings/brand — Settings › Brand & domain: the logo (SettingsContent's
 * Branding card) and the identity outbound email is sent under.
 *
 * OASIS's own workspaces (and the retired client) send under the fixed brands
 * in the one fail-closed brand map (lib/email/brand-for-tenant.ts ->
 * lib/email/brands.ts), the same resolution every send uses, shown read-only.
 *
 * Every other workspace registers its OWN identity here (2026-10-02): the
 * business name, legal name, postal address and sending address its email goes
 * out under (lib/email/tenant-sender.ts, POST /api/settings/sender). The status
 * line is the live check of the sending address against this workspace's own
 * connected mailboxes, and says exactly what is missing until it passes. It is
 * never somebody else's name, and never a placeholder that looks configured.
 */

import { Card } from "@/components/Card";
import { SettingsContent } from "@/components/settings/SettingsContent";
import { requireSettingsSection } from "@/components/settings/settings-viewer";
import { TenantSenderForm } from "@/components/settings/TenantSenderForm";
import { PageFrame } from "@/components/os/PageFrame";
import { brandForTenant } from "@/lib/email/brand-for-tenant";
import { getBrand } from "@/lib/email/brands";
import { describeSender, loadTenantSender } from "@/lib/email/tenant-sender";
import { connectorHref } from "@/lib/os/connectors";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export const dynamic = "force-dynamic";

function sendingIdentity(tenantId: string, tenantSlug: string | null) {
  try {
    const key = brandForTenant({ tenantId, tenantSlug });
    if (!key) return { state: "none" as const };
    const b = getBrand(key);
    return {
      state: "set" as const,
      displayName: b.displayName,
      fromAddress: b.fromAddress,
      sendingDomain: b.sendingDomain,
    };
  } catch (error) {
    console.error("[settings.brand.identity]", error);
    return { state: "unavailable" as const };
  }
}

export default async function SettingsBrandPage() {
  const viewer = await requireSettingsSection("brand");
  const identity = sendingIdentity(viewer.tenantId, viewer.tenantSlug);
  // A workspace with no fixed brand registers its own.
  const own =
    identity.state === "none"
      ? await loadTenantSender(tursoConfigured() ? getTursoClient() : null, viewer.tenantId)
      : null;
  const ownRow = own?.state === "saved" ? own.sender : null;
  return (
    <PageFrame title="Brand & domain" subtitle="How your business appears on forms, public pages and the email OASIS sends.">
      <div className="space-y-6">
        <SettingsContent section="brand" viewerAccess={viewer.viewerAccess} />
        <Card
          title="Sending identity"
          subtitle={
            own
              ? "The business name, legal name, postal address and email address this workspace's email goes out under."
              : "The name, address and domain your outbound email goes out under. Read-only here."
          }
        >
          {identity.state === "set" ? (
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-fg-dim">From name</dt>
                <dd className="mt-0.5 text-fg">{identity.displayName}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-fg-dim">From address</dt>
                <dd className="mt-0.5 break-all text-fg">{identity.fromAddress}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-fg-dim">Sending domain</dt>
                <dd className="mt-0.5 break-all text-fg">{identity.sendingDomain}</dd>
              </div>
            </dl>
          ) : own ? (
            <TenantSenderForm
              initial={{
                display_name: ownRow?.display_name ?? "",
                legal_name: ownRow?.legal_name ?? "",
                postal_address: ownRow?.postal_address ?? "",
                from_address: ownRow?.from_address ?? "",
                reply_to: ownRow?.reply_to ?? "",
              }}
              status={describeSender(own)}
              connectHref={connectorHref("google-workspace")}
              disabled={own.state === "unavailable"}
            />
          ) : (
            <p className="text-[13px] leading-5 text-fg-muted">
              The sending identity could not be read right now. That does not mean it is missing; refresh to retry.
            </p>
          )}
        </Card>
      </div>
    </PageFrame>
  );
}
