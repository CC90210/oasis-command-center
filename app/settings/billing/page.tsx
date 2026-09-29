/**
 * /settings/billing — Settings › Billing & add-ons. Owners and admins.
 *
 * BILLING. OASIS has no in-app billing yet: no plan table, no client invoices,
 * no usage meter a workspace could be shown. So this page says so and names who
 * handles it, instead of rendering a plan name or a zero balance it has no
 * source for. Self-serve billing arrives with provisioning (docs/os-revamp/PLAN.md
 * "Entitlements complete + billing").
 *
 * ADD-ONS. OASIS's own apps (components/settings/addons.ts): what each does and
 * what leaves the machine, taken from its README, and an "Ask OASIS to add
 * this" request through the client support form (lib/delivery/support-form.ts,
 * the same path /client-portal uses). No price, download or installed state —
 * the entitlements behind those are Phase 2.
 */

import { requireSettingsSection } from "@/components/settings/settings-viewer";
import { PageFrame } from "@/components/os/PageFrame";
import { AddonCard } from "@/components/settings/AddonCard";
import { OASIS_ADDONS } from "@/components/settings/addons";
import { SUPPORT_FORM_PATH } from "@/lib/delivery/support-form";

export const dynamic = "force-dynamic";

export default async function SettingsBillingPage() {
  await requireSettingsSection("billing");
  return (
    <PageFrame title="Billing & add-ons" subtitle="Your OASIS plan, and OASIS's own apps you can add to it.">
      <div className="space-y-8">
        <section aria-labelledby="billing-plan" className="rounded-xl border border-hairline bg-bg-panel px-4 py-4">
          <h2 id="billing-plan" className="text-sm font-semibold text-fg">
            Plan and invoices
          </h2>
          <p className="mt-1 text-[13px] leading-5 text-fg-muted">
            Your plan and invoices are handled directly with OASIS for now, so there is nothing to pay or change on
            this page. Self-serve billing, with your plan, usage and past invoices, is coming in a later release.
          </p>
          <a
            href={SUPPORT_FORM_PATH}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block text-[13px] text-accent underline-offset-2 hover:underline"
          >
            Ask OASIS about your plan
          </a>
        </section>

        <section aria-labelledby="billing-addons">
          <h2 id="billing-addons" className="text-sm font-semibold text-fg">
            Add-ons
          </h2>
          <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
            Apps built by OASIS that run on your own computers. Ask and OASIS sets them up with you.
          </p>
          <ul className="mt-3 grid gap-3 lg:grid-cols-2">
            {OASIS_ADDONS.map((addon) => (
              <AddonCard key={addon.slug} addon={addon} requestHref={SUPPORT_FORM_PATH} />
            ))}
          </ul>
        </section>
      </div>
    </PageFrame>
  );
}
