/**
 * Today for a workspace OASIS has not set up yet (plan D6).
 *
 * The rail already shows Today alone for such a workspace (lib/os/nav.ts,
 * provisioned: false); this is the page behind that row. It names nothing
 * about anyone else's data: no pipeline, no team, no OASIS data. It says what
 * happens next, and (since 2026-09-30) shows the real setup steps OASIS has
 * recorded for THIS workspace and who to ask, through ProvisioningProgress,
 * which reads the viewer's own workspace from the session.
 *
 * Presentational itself: no reads here (tests/os-today.test.ts).
 */
import Link from "next/link";
import { PageFrame } from "@/components/os/PageFrame";
import { ProvisioningProgress } from "@/components/onboarding/ProvisioningProgress";

export function WorkspaceSetupPending() {
  return (
    <PageFrame title="Your workspace is being set up" subtitle="OASIS is setting up this workspace for you.">
      <section className="max-w-2xl rounded-xl border border-hairline bg-bg-panel p-4">
        <p className="text-sm leading-[22px] text-fg">
          Your pipeline, your team and your departments appear here once that is done. Nothing here needs your
          attention in the meantime.
        </p>
        <p className="mt-3 text-sm text-fg-muted">
          You can update your profile under{" "}
          <Link href="/settings" prefetch={false} className="font-medium text-accent hover:underline">
            Settings
          </Link>
          .
        </p>
      </section>
      <div className="mt-4">
        <ProvisioningProgress />
      </div>
    </PageFrame>
  );
}
