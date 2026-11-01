/** Meta connection health and stored delivery evidence are separate facts. */
import Link from "next/link";
import { Card } from "@/components/Card";
import { KpiTile, type KpiStatus } from "@/components/os/KpiTile";
import { PageFrame } from "@/components/os/PageFrame";
import { StatusLine } from "@/components/os/connections/StatusLine";
import { loadWorkspaceConnectorStatus } from "@/components/os/connections/connector-facts";
import { requireOsRoute } from "@/components/os/landings/page-gate";
import { resolveFounder } from "@/lib/founders/gate";
import { loadLibraryPage } from "@/lib/founders/marketing-queries";
import { AssetTile } from "@/components/founders/marketing-shared";
import { loadAdsReport } from "@/lib/marketing/ads-report";
import { setupHref } from "@/lib/setup-links";
import { ImportMetaDelivery } from "@/components/marketing/ImportMetaDelivery";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ads" };
const META_CONNECT_HREF = setupHref("connector:meta");
const amount = (value: number | null, currency: string | null) =>
  value === null || !currency ? null : `${currency} ${value.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function AdsPage() {
  const viewer = await requireOsRoute("/growth/ads");
  const canConnect = viewer.surface.persona === "founder";
  const founder = viewer.oasis ? await resolveFounder() : null;
  const [connection, report, library] = await Promise.all([
    loadWorkspaceConnectorStatus(viewer.surface.tenantId, "meta"),
    loadAdsReport(viewer.surface.tenantId),
    // The existing preview and asset actions belong to the founders library.
    founder ? loadLibraryPage(viewer.surface.tenantId, { channel: "paid-meta", pageSize: 12 }).catch(() => {
      console.error("[marketing.ads] creative previews unavailable", { tenantId: viewer.surface.tenantId });
      return null;
    }) : Promise.resolve(null),
  ]);
  const reportStatus: KpiStatus = report.error ? "error" : report.observations > 0 ? "live" : "no_data";
  const metrics = [
    { label: "Recorded spend 7d", value: amount(report.spend, report.currency), missing: "Currency or spend not recorded" },
    { label: "Cost per click 7d", value: amount(report.costPerClick, report.currency), missing: "Spend and clicks needed" },
    { label: "Recorded clicks 7d", value: report.clicks, missing: "Clicks not recorded" },
    { label: report.conversionKind === "leads" ? "Recorded leads 7d" : "Reported conversions 7d", value: report.conversions, missing: "Conversions not recorded" },
  ];
  return (
    <PageFrame title="Ads" subtitle="Meta connection status, delivery reports and creative previews."
      actions={canConnect ? <Link href={META_CONNECT_HREF} prefetch={false} className="btn-primary">Manage Meta connection</Link> : undefined}>
      <div className="space-y-6">
        <Card title="Meta Ads connection">
          <StatusLine status={connection ?? { kind: "unknown", label: "Status unavailable" }} />
          {connection?.detail && <p className="mt-2 text-[13px] leading-5 text-fg-muted">{connection.detail}</p>}
          <p className="mt-2 text-[13px] leading-5 text-fg-muted">
            Connecting verifies account access. It does not start ads or prove that delivery metrics have synced.
          </p>
          {!canConnect && <p className="mt-2 text-[13px] text-fg-muted">A workspace owner or admin manages the connection.</p>}
        </Card>
        <section aria-label="Ad numbers" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map((metric) => <KpiTile key={metric.label} label={metric.label} value={metric.value}
            status={reportStatus === "live" && metric.value === null ? "no_data" : reportStatus}
            emptyText={report.observations ? metric.missing : "No delivery metrics received"}
            hint={`${report.from} to ${report.through} (${report.reportingTimezone ?? "source reporting dates"})${report.stale ? " · Stored report is stale" : ""}`} />)}
        </section>
        <Card title="Delivery evidence">
          {report.error ? <p role="status" className="text-sm text-status-warm">Stored ad results could not be read. Refresh to retry; missing results are not zero spend.</p>
            : report.observations === 0 ? <p className="text-sm text-fg-muted">No Meta delivery reports have arrived for this period. Creative files below are preparation, not evidence of active campaigns or ad spend.</p>
              : <p className="text-sm text-fg-muted">{report.observations.toLocaleString("en-CA")} daily observations across {report.measuredAssets.toLocaleString("en-CA")} creatives.
                {report.lastCapturedAt ? ` Last received ${report.lastCapturedAt}.` : " Capture time was not recorded."}
                {report.stale ? " These stored results are not current." : ""}
                {report.conversionKind === "conversions" ? " Conversions keep the source's meaning; they are not labelled as leads or paying customers without that evidence." : ""}
              </p>}
          <p className="mt-2 text-[13px] leading-5 text-fg-muted">Import delivery reads Meta&apos;s reporting API for creatives linked to an actual ad ID. Campaign creation, budget changes and the retired ads automation remain separate.</p>
          {viewer.navInput.isOperator && <div className="mt-3"><ImportMetaDelivery /></div>}
        </Card>
        <Card title="Meta creative inventory" noPadding>
          {report.creatives.length === 0 ? <p className="p-4 text-sm text-fg-muted">{report.error ? "Creative inventory is unavailable." : "No Meta creatives saved yet."}</p>
            : <div className="overflow-x-auto"><table className="w-full text-left text-[13px]">
              <thead className="border-b border-hairline text-fg-muted"><tr><th scope="col" className="px-4 py-2 font-medium">Creative</th><th scope="col" className="px-4 py-2 font-medium">Campaign label</th><th scope="col" className="px-4 py-2 font-medium">Creative status</th></tr></thead>
              <tbody className="divide-y divide-hairline">{report.creatives.map((creative) => <tr key={creative.id}>
                <td className="px-4 py-2 text-fg">{founder ? <Link href={`/founders/marketing/asset/${encodeURIComponent(creative.id)}`} prefetch={false} className="hover:underline">{creative.title}</Link> : creative.title}</td>
                <td className="px-4 py-2 text-fg-muted">{creative.campaign || "Not assigned"}</td><td className="px-4 py-2 text-fg-muted">{creative.status.replaceAll("_", " ")}</td>
              </tr>)}</tbody>
            </table></div>}
          <p className="px-4 py-3 text-xs text-fg-dim">{report.creativesCapped ? "Showing the 100 most recently updated creatives. " : ""}Creative status describes the library review, not Meta campaign delivery.</p>
        </Card>
        {founder && !library && <p role="status" className="text-sm text-status-warm">Creative previews could not be loaded. Refresh to retry.</p>}
        {library && library.tiles.length > 0 && <section aria-label="Meta creative previews" className="space-y-3">
          <h2 className="text-sm font-semibold text-fg">Creative previews</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{library.tiles.map(({ asset, ...media }) => <AssetTile key={asset.id}
            id={asset.id} title={asset.title} brandName={asset.brand_name} channel={asset.channel} status={asset.status}
            publishedAt={asset.published_at} hook={asset.hook} aspect={asset.aspect} durationS={asset.duration_s}
            format={asset.format} platforms={asset.platforms} assetType={asset.asset_type} {...media} returnTo="/growth/ads" />)}</div>
        </section>}
        {founder && <p className="text-sm text-fg-muted">Organic post performance is separate. <Link href="/founders/marketing/performance" prefetch={false} className="text-accent hover:underline">Open content performance</Link></p>}
      </div>
    </PageFrame>
  );
}
