/**
 * /growth/ads — Growth › Marketing › Ads: Meta Ads, run by the Marketing
 * department.
 *
 * NOT CONNECTED IS THE WHOLE TRUTH TODAY. No workspace has a Meta connection
 * yet: the partner-access pilot and App Review are Phase 2 (plan pillar 12,
 * docs/os-revamp/03 §(c).1). So this page shows no numbers at all — every tile
 * says "Not connected", and the rest says what Marketing will do once it is.
 * A plausible spend figure on a page with no data source is the defect this
 * product promises not to ship.
 *
 * GATE, first statement: requireOsRoute("/growth/ads") — the rail's rule
 * (module `ads`; today OASIS's internal tier only). Connect links go to
 * Settings › Connections and only for owners/admins, who are the ones the rail
 * gives the Connections door to.
 */

import Link from "next/link";
import { Copy, Gauge, LineChart, PauseCircle, Rocket } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "@/components/Card";
import { KpiTile } from "@/components/os/KpiTile";
import { PageFrame } from "@/components/os/PageFrame";
import { requireOsRoute } from "@/components/os/landings/page-gate";
import { resolveFounder } from "@/lib/founders/gate";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ads" };

const CONNECTIONS_HREF = "/settings/connections";
const ICON = { size: 16, strokeWidth: 1.75 } as const;

const TILES = ["Ad spend 7d", "Cost per lead", "Leads from ads 7d", "Cost per paid customer"] as const;

const ONCE_CONNECTED: Array<{ icon: ReactNode; title: string; body: string }> = [
  {
    icon: <LineChart {...ICON} />,
    title: "Live campaigns",
    body: "Every campaign, ad set and ad with spend, cost per lead and cost per paying customer, synced from Meta.",
  },
  {
    icon: <PauseCircle {...ICON} />,
    title: "Changes with your approval",
    body: "Pause or resume, raise or lower a budget. Each change is a card you approve, showing projected spend against your monthly cap. Nothing changes until you say yes.",
  },
  {
    icon: <Copy {...ICON} />,
    title: "Duplicate what wins",
    body: "When an ad keeps turning into paying customers, Marketing proposes a copy to scale it, as another approval.",
  },
  {
    icon: <Rocket {...ICON} />,
    title: "New ads start paused",
    body: "A new ad is created paused. Putting it live is a second approval, so spend never starts on its own.",
  },
  {
    icon: <Gauge {...ICON} />,
    title: "Winning-ad report",
    body: "Creatives ranked by cost per paying customer rather than clicks, each with its sample size, and tired ads flagged before they waste budget.",
  },
];

export default async function AdsPage() {
  const viewer = await requireOsRoute("/growth/ads");
  const canConnect = viewer.surface.persona === "founder";
  // Founders only: OASIS's own organic performance lives in the founders
  // portal behind its own gate; the link is drawn only when that gate opens.
  const founder = viewer.oasis ? await resolveFounder() : null;

  return (
    <PageFrame
      title="Ads"
      subtitle="Meta ads, run by your Marketing department once your ad account is connected."
      actions={
        canConnect ? (
          <Link href={CONNECTIONS_HREF} prefetch={false} className="btn-primary">
            Connect Meta Ads Manager
          </Link>
        ) : undefined
      }
    >
      <div className="space-y-6">
        <section aria-label="Ad numbers" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {TILES.map((label) => (
            <KpiTile
              key={label}
              label={label}
              value={null}
              status="not_connected"
              connectHref={canConnect ? CONNECTIONS_HREF : undefined}
              hint="Meta Ads"
            />
          ))}
        </section>
        {!canConnect && (
          <p className="text-[13px] text-fg-muted">Connecting an ad account is done by a workspace owner or admin.</p>
        )}

        <Card title="What Marketing does once Meta is connected" noPadding>
          <ul className="divide-y divide-hairline">
            {ONCE_CONNECTED.map((item) => (
              <li key={item.title} className="flex gap-3 px-4 py-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-fg-muted">
                  {item.icon}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg">{item.title}</p>
                  <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">{item.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="How connecting works">
          <ol className="list-decimal space-y-2 pl-5 text-[13px] leading-5 text-fg-muted marker:text-fg-dim">
            <li>
              While Meta reviews the OASIS app, OASIS connects your ad account through partner access: in Meta Business
              Settings, under Partners, you add OASIS and share the ad account and your Page.
            </li>
            <li>
              Once the review is approved, you connect directly with your Facebook login in one step, and can remove
              OASIS as a partner.
            </li>
            <li>Either way, OASIS only reads your ads and proposes changes. Every change and every new ad waits for your approval.</li>
          </ol>
        </Card>

        {founder && (
          <Card title="OASIS's own marketing">
            <p className="text-[13px] leading-5 text-fg-muted">
              Organic performance of OASIS&rsquo;s published posts, collected from Zernio. It covers organic reach only;
              paid campaigns are not in it.{" "}
              <Link href="/founders/marketing/performance" prefetch={false} className="text-accent hover:underline">
                Open content performance
              </Link>
            </p>
          </Card>
        )}
      </div>
    </PageFrame>
  );
}
