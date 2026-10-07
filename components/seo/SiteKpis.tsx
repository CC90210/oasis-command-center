import type { SeoRange, SiteSummary } from "@/lib/seo/types";
import { fmtCtr, fmtInt, fmtDate, fmtPos, pctChange, posChange, ppChange, PREV_LABEL, type Change } from "@/lib/seo/format";
import { ChangeCell, Missing } from "./Bits";

type Tile = { label: string; value: string | null; vsPrev: Change | null; vsYear: Change | null };

function TileView({ t, prevLabel, error }: { t: Tile; prevLabel: string | null; error: boolean }) {
  return (
    <div className="rounded-lg border border-hairline bg-bg-panel p-4">
      <div className="text-xs font-medium text-fg-muted">{t.label}</div>
      {error ? (
        <div className="mt-2 flex items-baseline gap-2">
          <span aria-hidden className="text-2xl font-semibold leading-8 text-fg-dim">{"—"}</span>
          <span className="text-sm font-medium text-status-warm">Couldn&rsquo;t load</span>
        </div>
      ) : (
        <>
          <div className="mt-2 text-2xl font-semibold leading-8 tabular-nums text-fg">{t.value ?? <Missing />}</div>
          {prevLabel ? (
            <dl className="mt-2 space-y-0.5 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-fg-dim">vs {prevLabel}</dt>
                <dd><ChangeCell change={t.vsPrev} none="no prior data" /></dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-fg-dim">vs a year earlier</dt>
                <dd>{t.vsYear ? <ChangeCell change={t.vsYear} /> : <span className="text-fg-dim">no prior year data</span>}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-2 text-xs text-fg-dim">no earlier 16 months to compare</p>
          )}
        </>
      )}
    </div>
  );
}

export function SiteKpis({ summary, range, error }: { summary: SiteSummary | null; range: SeoRange; error: boolean }) {
  const c = summary?.current ?? null;
  const p = summary?.previous ?? null;
  const y = summary?.prior_year ?? null;
  const tiles: Tile[] = [
    { label: "Clicks", value: fmtInt(c?.clicks), vsPrev: pctChange(c?.clicks, p?.clicks), vsYear: pctChange(c?.clicks, y?.clicks) },
    { label: "Impressions", value: fmtInt(c?.impressions), vsPrev: pctChange(c?.impressions, p?.impressions), vsYear: pctChange(c?.impressions, y?.impressions) },
    { label: "CTR", value: fmtCtr(c?.ctr), vsPrev: ppChange(c?.ctr, p?.ctr), vsYear: ppChange(c?.ctr, y?.ctr) },
    { label: "Avg position", value: fmtPos(c?.position), vsPrev: posChange(c?.position, p?.position), vsYear: posChange(c?.position, y?.position) },
  ];
  return (
    <section aria-label="Totals">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => <TileView key={t.label} t={t} prevLabel={PREV_LABEL[range]} error={error} />)}
      </div>
      {c && (
        <p className="mt-2 text-xs text-fg-dim">
          {fmtDate(c.start)} to {fmtDate(c.end)}
          {!c.complete && " (partial: history does not cover the whole period yet)"}
        </p>
      )}
    </section>
  );
}
