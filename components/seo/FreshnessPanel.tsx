import type { Freshness } from "@/lib/seo/types";
import { fmtDate, fmtTimestamp } from "@/lib/seo/format";
import { Missing } from "./Bits";

function Item({ term, value }: { term: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-3 py-1">
      <dt className="text-fg-dim">{term}</dt>
      <dd className="text-right tabular-nums text-fg">{value ?? <Missing />}</dd>
    </div>
  );
}

export function FreshnessPanel({ f }: { f: Freshness }) {
  const backfill = f.backfill_done == null ? null : f.backfill_done ? "Complete" : "In progress";
  return (
    <section aria-label="Data freshness" className="rounded-lg border border-hairline bg-bg-panel p-4 text-sm">
      <h2 className="text-sm font-semibold text-fg">Data freshness</h2>
      <dl className="mt-2 divide-y divide-hairline">
        <Item term="Search Console property" value={f.property} />
        <Item term="Last pull" value={fmtTimestamp(f.last_attempt_at) && `${fmtTimestamp(f.last_attempt_at)} (${f.last_status ?? "unknown"})`} />
        <Item term="Settled through" value={fmtDate(f.settled_through)} />
        <Item term="History from" value={fmtDate(f.history_start)} />
        <Item term="Backfill" value={backfill} />
      </dl>
      {f.detail_capped && (
        <p className="mt-3 rounded-md border border-status-warm/40 px-3 py-2 text-xs text-fg">
          <span aria-hidden className="text-status-warm">{"▲"} </span>
          Detail capped: a pull in this range hit the 100,000-row limit, so the search and page tables can miss small rows. Totals are complete.
        </p>
      )}
      {f.last_error && <p className="mt-3 text-xs text-fg-muted">Last error: {f.last_error}</p>}
    </section>
  );
}
