import Link from "next/link";
import type { Loaded } from "@/lib/seo/client";
import type { SiteListRow, SitesList } from "@/lib/seo/types";
import { fmtInt, fmtPos, pctChange, posChange } from "@/lib/seo/format";
import { ChangeCell, Missing, StatusBadge, UnavailableBanner } from "./Bits";

const NUM = "h-9 px-3 text-right tabular-nums text-fg";
const HEAD = "h-9 px-3 font-medium";

function Num({ v }: { v: string | null }) {
  return <td className={NUM}>{v ?? <Missing />}</td>;
}

function Row({ s, base }: { s: SiteListRow; base: string }) {
  const cur = s.current;
  const prev = s.previous;
  return (
    <tr className="h-9 border-b border-hairline last:border-0 hover:bg-bg-elev">
      <th scope="row" className="max-w-[260px] px-3 text-left font-normal">
        <span className="flex min-w-0 items-center gap-2">
          <Link prefetch={false} href={`${base}/${s.id}`} title={s.domain ?? s.id} className="truncate text-fg hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
            {s.domain ?? s.display_name}
          </Link>
          {s.is_test && <span className="shrink-0 text-xs text-fg-dim">test</span>}
        </span>
      </th>
      <td className="px-3">
        <StatusBadge status={s.status} />
        {cur && !cur.complete && <span className="ml-2 text-xs text-fg-dim">partial history</span>}
      </td>
      <Num v={fmtInt(cur?.clicks)} />
      <td className={NUM}><ChangeCell change={pctChange(cur?.clicks, prev?.clicks)} /></td>
      <Num v={fmtInt(cur?.impressions)} />
      <td className={NUM}><ChangeCell change={pctChange(cur?.impressions, prev?.impressions)} /></td>
      <Num v={fmtPos(cur?.position)} />
      <td className={NUM}><ChangeCell change={posChange(cur?.position, prev?.position)} /></td>
    </tr>
  );
}

/**
 * The body only: no <header>, no outer width/padding wrapper. app/seo/page.tsx
 * renders this as PageFrame's children; PageFrame draws the title row and
 * MainShell's canvas owns the page width (PageFrame ruling, Adon 2026-10-07).
 */
export function SitesView({ loaded, base = "/seo" }: { loaded: Loaded<SitesList>; base?: string }) {
  if (loaded.state !== "ok") return <UnavailableBanner />;
  if (loaded.data.sites.length === 0) {
    return <p className="text-sm text-fg-muted">No sites yet. Add the first one.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-hairline bg-bg-panel">
      <table className="w-full min-w-[760px] text-sm">
        <caption className="sr-only">Every site, needs attention first, then by clicks</caption>
        <thead>
          <tr className="border-b border-hairline text-xs text-fg-muted">
            <th scope="col" className={`${HEAD} text-left`}>Site</th>
            <th scope="col" className={`${HEAD} text-left`}>Status</th>
            <th scope="col" className={`${HEAD} text-right`}>Clicks</th>
            <th scope="col" className={`${HEAD} text-right`}>vs prev</th>
            <th scope="col" className={`${HEAD} text-right`}>Impressions</th>
            <th scope="col" className={`${HEAD} text-right`}>vs prev</th>
            <th scope="col" className={`${HEAD} text-right`}>Avg position</th>
            <th scope="col" className={`${HEAD} text-right`}>vs prev</th>
          </tr>
        </thead>
        <tbody>
          {loaded.data.sites.map((s) => <Row key={s.id} s={s} base={base} />)}
        </tbody>
      </table>
    </div>
  );
}
