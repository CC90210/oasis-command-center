/**
 * /marketing — the marketing library, under Operations.
 *
 * Replaces the standalone showroom Vercel deployment (showroom-eta-red), which
 * made creative a separate island with its own URL and no relationship to the
 * rest of the operator surface. CC's call 2026-08-03: it belongs here, because
 * Adon's marketing suite is being built for this same Command Center and the
 * material should already be in place when it arrives.
 *
 * CONTRACT — public/marketing/manifest.json
 *   Written by CMO-Agent: scripts/publish_marketing_to_command_center.py.
 *   Read here, and deliberately stable so Adon's suite can consume the same
 *   file rather than inventing a second index of the same assets.
 *     { generated_at, count, total_bytes, brands[], kinds[],
 *       assets: [{ slug, file, poster, bytes, brand, kind, modified }] }
 *
 * Renders empty-but-honest when the manifest is absent — this page never
 * invents a placeholder reel.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { PageHeader } from "@/components/Card";
import { MarketingLibraryClient } from "@/components/marketing/MarketingLibraryClient";

export const dynamic = "force-dynamic";

export type MarketingAsset = {
  slug: string;
  file: string;
  poster: string | null;
  bytes: number;
  brand: string;
  kind: string;
  modified: string;
};

export type MarketingManifest = {
  generated_at: string;
  generated_by?: string;
  count: number;
  total_bytes: number;
  brands: string[];
  kinds: string[];
  assets: MarketingAsset[];
};

async function loadManifest(): Promise<MarketingManifest | null> {
  try {
    const p = path.join(process.cwd(), "public", "marketing", "manifest.json");
    return JSON.parse(await fs.readFile(p, "utf8")) as MarketingManifest;
  } catch {
    // Absent manifest is a real, expected state (nothing published yet).
    // Returning null lets the client render the honest empty case.
    return null;
  }
}

export default async function MarketingPage() {
  const manifest = await loadManifest();
  const mb = manifest ? Math.round(manifest.total_bytes / 1e5) / 10 : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Marketing"
        subtitle={
          manifest
            ? `${manifest.count} assets · ${mb} MB · synced ${new Date(
                manifest.generated_at,
              ).toLocaleString()}`
            : "No marketing material published yet."
        }
      />
      <MarketingLibraryClient manifest={manifest} />
    </div>
  );
}
