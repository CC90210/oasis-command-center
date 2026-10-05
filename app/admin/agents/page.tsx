/**
 * /admin/agents — Admin › Fleet: every agent wired to the Command Center,
 * whether it is running, and what each one owns. Moved here from /agents,
 * which is now the AI Team for everyone (plan D4).
 *
 * GATE: requireOperator() as the FIRST statement — a platform operator by auth
 * user, standing on OASIS membership, or a 404 before any read. The old page
 * was gated by requireSystemSurface, which also admitted internal workers; the
 * fleet is platform machinery and now answers to the operator rule every Admin
 * page uses.
 *
 * The power chat that used to sit on top of this roster is Admin › Coding
 * harness (/agent); it is linked, not mounted a second time.
 */

import Link from "next/link";
import { requireOperator } from "@/lib/role-surfaces-session";
import { PageFrame } from "@/components/os/PageFrame";
import { AgentFleet, FleetSummaryTag } from "@/components/os/landings/AgentFleet";
import { loadFleet } from "@/components/os/landings/fleet-data";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fleet" };

export default async function AdminFleetPage() {
  await requireOperator();
  const fleet = await loadFleet();
  return (
    <PageFrame
      title="Fleet"
      subtitle="Every agent wired to your Command Center. Running means one of its processes on your computer checked in within 5 minutes; Last task is its own last tick."
      actions={
        <>
          <FleetSummaryTag fleet={fleet} />
          <Link href="/agent" prefetch={false} className="btn-secondary">
            Coding harness
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        {!fleet.signalsKnown && (
          <p role="alert" className="rounded-xl border border-status-warm/30 px-4 py-3 text-[13px] text-status-warm">
            Couldn&rsquo;t read agent heartbeats, so running status is unknown. The error has been logged.
          </p>
        )}
        <AgentFleet fleet={fleet} />
        <p className="text-right text-xs text-fg-muted">
          The live event tape is on{" "}
          <Link href="/operations#activity-tape" prefetch={false} className="text-accent hover:underline">
            Operations
          </Link>
          .
        </p>
      </div>
    </PageFrame>
  );
}
