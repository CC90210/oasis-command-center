/**
 * Today for a workspace OASIS has not set up yet (plan D6).
 *
 * The rail already shows Today alone for such a workspace (lib/os/nav.ts,
 * provisioned: false); this is the page behind that row. It reads nothing and
 * names nothing — no pipeline, no team, no OASIS data — and says what happens
 * next. Wording follows UNPROVISIONED_SEED's own Today page
 * (lib/manifest/seeds.ts), which the manifest shells still render.
 *
 * Server component, no hooks, no reads.
 */
import Link from "next/link";
import { PageFrame } from "@/components/os/PageFrame";

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
    </PageFrame>
  );
}
