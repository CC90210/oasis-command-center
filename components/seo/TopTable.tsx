import type { TopRows } from "@/lib/seo/types";
import { fmtCtr, fmtInt, fmtPos, fmtSignedInt, pagePath } from "@/lib/seo/format";
import { Missing } from "./Bits";

const NUM = "h-9 px-3 text-right tabular-nums text-fg";
const HEAD = "h-9 px-3 font-medium";

export function TopTable({ title, dim, data }: { title: string; dim: "query" | "page"; data: TopRows }) {
  return (
    <section aria-label={title} className="rounded-lg border border-hairline bg-bg-panel">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-3 py-2">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {data.approximate && <span className="text-xs text-fg-muted">Approximate: built from each month&rsquo;s top 1,000</span>}
      </header>
      {data.rollups_pending ? (
        <p className="px-3 py-4 text-sm text-fg-muted">Monthly totals are being rebuilt. This view fills in after the rebuild runs.</p>
      ) : !data.rows || data.rows.length === 0 ? (
        <p className="px-3 py-4 text-sm text-fg-muted">No {dim === "query" ? "searches" : "pages"} in this range yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <caption className="caption-bottom px-3 py-2 text-left text-xs text-fg-dim">{data.note}</caption>
            <thead>
              <tr className="border-b border-hairline text-xs text-fg-muted">
                <th scope="col" className={`${HEAD} text-left`}>{dim === "query" ? "Search" : "Page"}</th>
                <th scope="col" className={`${HEAD} text-right`}>Clicks</th>
                <th scope="col" className={`${HEAD} text-right`}>Impressions</th>
                <th scope="col" className={`${HEAD} text-right`}>CTR</th>
                <th scope="col" className={`${HEAD} text-right`}>Avg position</th>
                <th scope="col" className={`${HEAD} text-right`}>Clicks change</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const shown = dim === "page" ? pagePath(r.key) : r.key;
                return (
                  <tr key={r.key} className="h-9 border-b border-hairline last:border-0">
                    <th scope="row" className="max-w-[320px] px-3 text-left font-normal text-fg">
                      <span className="block truncate" title={r.key}>{shown}</span>
                    </th>
                    <td className={NUM}>{fmtInt(r.clicks)}</td>
                    <td className={NUM}>{fmtInt(r.impressions)}</td>
                    <td className={NUM}>{fmtCtr(r.ctr) ?? <Missing />}</td>
                    <td className={NUM}>{fmtPos(r.position) ?? <Missing />}</td>
                    <td className={NUM}>{fmtSignedInt(r.clicks_change) ?? <Missing label="no prior data" />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
