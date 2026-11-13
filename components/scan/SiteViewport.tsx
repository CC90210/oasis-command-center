"use client";

import type { ScanEvent } from "@/lib/site-scan/events";

/**
 * What the agent is looking at: the address it has open and the pages it has read, in a browser
 * frame. As the runner walks the site in a real browser (a `screenshot` event per page, each with
 * our own stored picture's `url`), the frame shows each picture as it arrives, the home page first;
 * once the scan is finished it rests on the home page. Everything drawn is from the feed; nothing
 * is mocked up.
 */

type PageRead = { path: string; title: string | null; url: string | null; ok: boolean };

/** Only our own stored pictures of this scan are ever shown (GET /api/scan/:id/screenshot, /shot/:seq). */
const SHOT_PATH = /^\/api\/scan\/[0-9a-f-]{36}\/(?:screenshot|shot\/\d{1,2})$/;

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

function pagesOf(events: ScanEvent[]): PageRead[] {
  const out: PageRead[] = [];
  for (const ev of events) {
    if (ev.kind !== "page" || ev.data?.kind !== "site_page") continue;
    const status = typeof ev.data.status === "number" ? ev.data.status : null;
    out.push({
      path: typeof ev.data.path === "string" ? ev.data.path : "/",
      title: typeof ev.data.title === "string" ? ev.data.title : null,
      url: typeof ev.data.url === "string" ? ev.data.url : null,
      ok: status !== null && status >= 200 && status < 300,
    });
  }
  return out;
}

export function SiteViewport({ events, fallbackUrl, live }: { events: ScanEvent[]; fallbackUrl: string; live: boolean }) {
  const pages = pagesOf(events);
  const current = pages[pages.length - 1] ?? null;
  const shots = events.filter((e) => e.kind === "screenshot" && typeof e.data?.url === "string" && SHOT_PATH.test(e.data.url));
  const home = shots.find((e) => e.data?.seq === 0 || /\/screenshot$/.test(String(e.data?.url))) ?? shots[0] ?? null;
  const latest = shots[shots.length - 1] ?? null;
  // Live, the frame follows the walk; finished, it rests on the home page.
  const shot = live ? latest : (home ?? latest);
  const shotPage = typeof shot?.data?.page === "string" ? shot.data.page : null;
  const address = shotPage ?? current?.url ?? fallbackUrl;
  const onHome = !!shot && shot === home;
  return (
    <figure className="overflow-hidden border border-ops-edge bg-ops-panel">
      <div className="flex items-center gap-3 border-b border-ops-line px-3 py-2">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-ops-edge" />
          <span className="h-2.5 w-2.5 rounded-full bg-ops-edge" />
          <span className="h-2.5 w-2.5 rounded-full bg-ops-edge" />
        </span>
        <span className="min-w-0 flex-1 truncate border border-ops-line bg-ops-void px-3 py-1 font-data text-[11px] text-fg-muted" title={address}>
          {address}
        </span>
      </div>
      <div className="relative aspect-[16/10] overflow-hidden bg-ops-void">
        {shot ? (
          // eslint-disable-next-line @next/next/no-img-element -- our own stored picture of this scan (GET /api/scan/:id/screenshot or /shot/:seq), not an optimisable asset
          <img key={String(shot.data?.url)} src={String(shot.data?.url)} alt={`${onHome ? "The home page" : pathOf(address)} of ${fallbackUrl}, as the scanner saw it`} className="h-full w-full object-cover object-top" />
        ) : (
          <ol className="absolute inset-0 overflow-hidden p-4 font-data text-[11.5px] leading-relaxed">
            {pages.length === 0 ? <li className="text-fg-dim">Opening the site...</li> : null}
            {pages.slice(-7).map((p, i, arr) => (
              <li key={`${p.path}-${i}`} className={`truncate ${i === arr.length - 1 ? "text-fg" : "text-fg-dim"}`}>
                <span className={p.ok ? "text-signal" : "text-status-warm"}>{p.ok ? "read" : "skip"}</span> {p.path}
                {p.title ? <span className="text-fg-muted"> &middot; {p.title}</span> : null}
              </li>
            ))}
          </ol>
        )}
        {live ? <span className="scan-sweep pointer-events-none absolute inset-x-0 top-0 h-16" aria-hidden="true" /> : null}
      </div>
      <figcaption className="border-t border-ops-line px-3 py-2 font-data text-[10px] uppercase tracking-[0.2em] text-fg-dim">
        {shot ? (onHome ? "Home page, as the scanner saw it" : `Looking at ${pathOf(address)}`) : `${pages.filter((p) => p.ok).length} page${pages.filter((p) => p.ok).length === 1 ? "" : "s"} read`}
      </figcaption>
    </figure>
  );
}
