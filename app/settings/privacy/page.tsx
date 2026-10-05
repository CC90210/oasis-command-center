/**
 * /settings/privacy — Settings › Data & privacy. Everyone.
 *
 * Points at the policies and the person responsible, from the same constants
 * the public /privacy page renders (lib/legal/constants.ts), so the two can
 * never name different people or addresses. tests/legal-compliance-drift keeps
 * those constants true.
 *
 * Export and deletion are handled by a person at OASIS on request. There is no
 * self-serve button, so none is drawn: a "Delete my data" control with nothing
 * behind it is worse than a plain sentence saying who to ask.
 *
 * /privacy and /terms are plain <a> links, as in MainShell's footer: they are
 * public pages in the marketing layout, outside this shell.
 */

import { requireSettingsSection } from "@/components/settings/settings-viewer";
import { PageFrame } from "@/components/os/PageFrame";
import { AI_DISCLOSURE_NOTICE, PRIVACY_OFFICER } from "@/lib/legal/constants";
import { SUPPORT_FORM_PATH } from "@/lib/delivery/support-form";

export const dynamic = "force-dynamic";

export default async function SettingsPrivacyPage() {
  await requireSettingsSection("privacy");
  return (
    <PageFrame title="Data & privacy" subtitle="How OASIS handles your workspace's information, and who to ask about it.">
      <div className="space-y-4">
        <section className="rounded-xl border border-hairline bg-bg-panel px-4 py-4">
          <h2 className="text-sm font-semibold text-fg">Policies</h2>
          <p className="mt-1 text-[13px] leading-5 text-fg-muted">
            What OASIS collects, which providers process it, and how long it is kept.
          </p>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
            <a href="/privacy" className="text-accent underline-offset-2 hover:underline">
              Privacy policy
            </a>
            <a href="/terms" className="text-accent underline-offset-2 hover:underline">
              Terms of service
            </a>
          </div>
        </section>

        <section className="rounded-xl border border-hairline bg-bg-panel px-4 py-4">
          <h2 className="text-sm font-semibold text-fg">Export or delete your data</h2>
          <p className="mt-1 text-[13px] leading-5 text-fg-muted">
            A person at OASIS handles export and deletion requests; there is no automatic button for either. Send the
            request through the support form, or write to the person in charge below.
          </p>
          <a
            href={SUPPORT_FORM_PATH}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block text-[13px] text-accent underline-offset-2 hover:underline"
          >
            Open the support form
          </a>
        </section>

        <section className="rounded-xl border border-hairline bg-bg-panel px-4 py-4">
          <h2 className="text-sm font-semibold text-fg">Person in charge of personal information</h2>
          <dl className="mt-2 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-fg-dim">{PRIVACY_OFFICER.title.en}</dt>
              <dd className="mt-0.5 text-fg">{PRIVACY_OFFICER.name}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-fg-dim">Email</dt>
              <dd className="mt-0.5 break-all text-fg">{PRIVACY_OFFICER.email}</dd>
            </div>
          </dl>
        </section>

        <section className="rounded-xl border border-hairline bg-bg-panel px-4 py-4">
          <h2 className="text-sm font-semibold text-fg">AI</h2>
          <p className="mt-1 text-[13px] leading-5 text-fg-muted">{AI_DISCLOSURE_NOTICE}</p>
        </section>
      </div>
    </PageFrame>
  );
}
