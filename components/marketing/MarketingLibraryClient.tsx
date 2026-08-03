"use client";

/**
 * MarketingLibraryClient — the grid + filters + fullscreen player for
 * /marketing (Operations → Marketing).
 *
 * Design notes:
 *  - Posters are <img>, never an autoplaying <video> wall. A grid of 80
 *    simultaneously-decoding videos is what made the old standalone showroom
 *    crawl on a phone; playback is opt-in, one at a time, in the lightbox.
 *  - Filters derive from the manifest itself rather than a hardcoded brand
 *    list, so a new brand appears the moment CMO-Agent publishes one.
 *  - Empty state is honest: it names the command that fills this page instead
 *    of showing skeleton cards that imply content is loading.
 */

import { useMemo, useState, useCallback, useEffect } from "react";
import { Card } from "@/components/Card";
import type { MarketingManifest, MarketingAsset } from "@/app/marketing/page";

const ALL = "all";

function mb(bytes: number) {
  return `${Math.round(bytes / 1e5) / 10} MB`;
}

export function MarketingLibraryClient({
  manifest,
}: {
  manifest: MarketingManifest | null;
}) {
  const [brand, setBrand] = useState<string>(ALL);
  const [kind, setKind] = useState<string>(ALL);
  const [open, setOpen] = useState<MarketingAsset | null>(null);

  const assets = manifest?.assets ?? [];

  const shown = useMemo(
    () =>
      assets.filter(
        (a) => (brand === ALL || a.brand === brand) && (kind === ALL || a.kind === kind),
      ),
    [assets, brand, kind],
  );

  const close = useCallback(() => setOpen(null), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!manifest) {
    return (
      <Card title="Nothing published yet">
        <p className="text-sm text-slate-400">
          The marketing library is populated from CMO-Agent. Run:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900/70 p-3 text-xs text-cyan-300">
          python scripts/publish_marketing_to_command_center.py
        </pre>
        <p className="mt-3 text-xs text-slate-500">
          That writes <code>public/marketing/manifest.json</code> plus the assets. It does not
          deploy — pushing to <code>main</code> is a separate, deliberate step because this
          domain is production.
        </p>
      </Card>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Chips
          label="Brand"
          value={brand}
          options={manifest.brands}
          onChange={setBrand}
          counts={assets.map((a) => a.brand)}
        />
        <Chips
          label="Type"
          value={kind}
          options={manifest.kinds}
          onChange={setKind}
          counts={assets.map((a) => a.kind)}
        />
      </div>

      {shown.length === 0 ? (
        <Card title="No assets match those filters">
          <p className="text-sm text-slate-400">Clear a filter to see the full library.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map((a) => (
            <button
              key={a.slug}
              onClick={() => setOpen(a)}
              className="group overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50 text-left transition hover:border-cyan-500/60"
            >
              <div className="relative aspect-[9/16] w-full bg-slate-950">
                {a.poster ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={a.poster}
                    alt={a.slug}
                    loading="lazy"
                    className="h-full w-full object-cover opacity-90 transition group-hover:opacity-100"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-slate-600">
                    no poster
                  </div>
                )}
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-3xl text-white/80 opacity-0 transition group-hover:opacity-100">
                  ▶
                </span>
              </div>
              <div className="space-y-1 p-2">
                <div className="truncate text-xs font-medium text-slate-200">{a.slug}</div>
                <div className="flex items-center gap-1 text-[10px] text-slate-500">
                  <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-cyan-300">
                    {a.brand}
                  </span>
                  <span>{a.kind}</span>
                  <span className="ml-auto">{mb(a.bytes)}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={close}
          role="dialog"
          aria-modal="true"
          aria-label={open.slug}
        >
          <div className="flex max-h-full flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={open.file}
              poster={open.poster ?? undefined}
              controls
              autoPlay
              className="max-h-[82vh] rounded-lg shadow-2xl"
            />
            <div className="flex items-center gap-3 text-xs text-slate-400">
              <span className="font-medium text-slate-200">{open.slug}</span>
              <span>{open.brand}</span>
              <span>{mb(open.bytes)}</span>
              <a href={open.file} download className="text-cyan-400 hover:underline">
                download
              </a>
              <button onClick={close} className="text-slate-500 hover:text-slate-300">
                close (esc)
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Chips({
  label,
  value,
  options,
  onChange,
  counts,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  counts: string[];
}) {
  const tally = (k: string) => counts.filter((c) => c === k).length;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs uppercase tracking-wide text-slate-500">{label}</span>
      {[ALL, ...options].map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`rounded-full px-3 py-1 text-xs transition ${
            value === o
              ? "bg-cyan-500/20 text-cyan-200 ring-1 ring-cyan-500/50"
              : "bg-slate-800/60 text-slate-400 hover:text-slate-200"
          }`}
        >
          {o}
          {o !== ALL && <span className="ml-1 text-slate-500">{tally(o)}</span>}
        </button>
      ))}
    </div>
  );
}
