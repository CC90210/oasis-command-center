/**
 * /settings/brand — Settings › Brand & domain: the logo (SettingsContent's
 * Branding card) and the identity outbound email is sent under.
 *
 * The sending identity is READ from the one fail-closed brand map
 * (lib/email/brand-for-tenant.ts → lib/email/brands.ts), the same resolution
 * every send uses. A workspace the map does not know shows that it has none —
 * never somebody else's name, and never a placeholder that looks configured.
 */

import { Card } from "@/components/Card";
import { SettingsContent } from "@/components/settings/SettingsContent";
import { requireSettingsSection } from "@/components/settings/settings-viewer";
import { PageFrame } from "@/components/os/PageFrame";
import { brandForTenant } from "@/lib/email/brand-for-tenant";
import { getBrand } from "@/lib/email/brands";

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
  return (
    <PageFrame title="Brand & domain" subtitle="How your business appears on forms, public pages and the email OASIS sends.">
      <div className="space-y-6">
        <SettingsContent section="brand" viewerAccess={viewer.viewerAccess} />
        <Card
          title="Sending identity"
          subtitle="The name, address and domain your outbound email goes out under. Read-only here."
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
          ) : identity.state === "none" ? (
            <p className="text-[13px] leading-5 text-fg-muted">
              No sending identity is set up for this workspace yet. OASIS verifies your sending domain during your
              install, and no commercial email goes out until it is.
            </p>
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
