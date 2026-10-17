/**
 * library-meta - the fields Maven stamps in marketing_asset.meta that the
 * Content Library reads: who a creative was made for (icp_segment), the pack of
 * hook variants it belongs to (pack_id), and the variant's own opening line,
 * number and style. Plus the two flags the offer pages already use
 * (offer_slug, burned_captions), shown as read-only badges.
 *
 * PURE: no React, no server imports, so tests/library-review.test.ts runs it
 * with no session and no database. The facet filters (queries) and the hook
 * comparison (page) both read through these, so a label or a validity rule is
 * defined once.
 *
 * WHY THE SEGMENT LIST IS A COPY. The ids come from the CMO repo's
 * config/icp_segments.json (icp_ecommerce, icp_ops_bottleneck,
 * icp_sales_bottleneck), plus brand_vsl, which Maven's 2026-10-08 content
 * handover names but that registry does not list. This app cannot read that
 * repo at runtime, so the ids are mirrored here. The registry carries ids and
 * landing pages only, no labels: the short labels below are built from the ids.
 * A segment that is not in this list shows its raw id, so a new segment is
 * visible the day Maven registers it and gets a nicer label when it is added
 * here.
 *
 * The one-line blurbs that handover attached to each segment are deliberately
 * not used anywhere: QA rejected them as unsourced claims.
 */

import { isAssetStatus, lifecycleOf, type AssetStatus, type Lifecycle } from "@/lib/founders-marketing-core";

export type IcpSegment = { id: string; label: string };

export const ICP_SEGMENTS: readonly IcpSegment[] = [
  { id: "icp_ops_bottleneck", label: "Ops bottleneck" },
  { id: "icp_sales_bottleneck", label: "Sales bottleneck" },
  { id: "icp_ecommerce", label: "E-commerce" },
  { id: "brand_vsl", label: "Brand VSL" },
];

/** The label for a segment id; an id this app does not know reads as itself. */
export function icpSegmentLabel(id: string): string {
  return ICP_SEGMENTS.find((s) => s.id === id)?.label ?? id;
}

/**
 * What a `?icp=` or `?pack=` value may look like. Both reach a bound query
 * parameter, never SQL text, so this is about not echoing junk into pills and
 * links rather than about injection. A pack id is
 * `<icp_segment>_<avatar>_<concept>` (CMO-Agent scripts/pack_ledger.py).
 */
const SEGMENT_ID = /^[a-z][a-z0-9_]{0,63}$/;
const PACK_ID = /^[a-z0-9][a-z0-9_-]{0,159}$/;

export function isSegmentId(v: unknown): v is string {
  return typeof v === "string" && SEGMENT_ID.test(v);
}

export function isPackId(v: unknown): v is string {
  return typeof v === "string" && PACK_ID.test(v);
}

/**
 * `meta` as an object, whatever shape the driver handed back. The Turso bridge
 * parses JSON text into an object; a malformed value stays a string, and a row
 * whose meta cannot be read still has to render. Never throws.
 */
export function parseAssetMeta(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(v: unknown, max = 400): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export type AssetMetaView = {
  icpSegment: string | null;
  packId: string | null;
  /** The variant's opening line (meta.hook). */
  hook: string | null;
  /** 'variant_3' as Maven writes it. */
  hookVariant: string | null;
  hookStyle: string | null;
  offerSlug: string | null;
  burnedCaptions: boolean;
};

export function assetMetaView(rawMeta: unknown): AssetMetaView {
  const meta = parseAssetMeta(rawMeta);
  const flag = meta.burned_captions;
  return {
    icpSegment: text(meta.icp_segment, 64),
    packId: text(meta.pack_id, 160),
    hook: text(meta.hook),
    hookVariant: text(meta.hook_variant, 64),
    hookStyle: text(meta.hook_style, 64),
    offerSlug: text(meta.offer_slug, 64),
    // The same reading as the offer pages (lib/offer-pages/store.ts): the flag
    // is true (Maven's tool writes a boolean) or 1, and anything else is no.
    burnedCaptions: flag === true || flag === 1,
  };
}

/** 'variant_3' -> 3; null for anything that is not a numbered variant. */
export function hookVariantNumber(v: string | null | undefined): number | null {
  const m = /^variant_(\d{1,3})$/.exec(v ?? "");
  return m ? Number(m[1]) : null;
}

/** 'variant_3' -> 'Variant 3'. Anything else reads as itself, underscores spaced. */
export function hookVariantLabel(v: string | null | undefined): string {
  const n = hookVariantNumber(v);
  if (n !== null) return `Variant ${n}`;
  return v ? v.replace(/[_-]+/g, " ") : "Variant";
}

/** A hook style as a short phrase: 'pattern_interrupt' -> 'pattern interrupt'. */
export function hookStyleLabel(v: string | null | undefined): string {
  return (v ?? "").replace(/[_-]+/g, " ").trim();
}

/**
 * A pack id as a person reads it: 'icp_sales_bottleneck_b2b-operator_leads-left-waiting'
 * -> 'b2b operator - leads left waiting'. The avatar and the concept are slugs
 * (hyphens, no underscores), so the last two underscore-separated parts are
 * always them, whatever the segment is called. Anything not in that shape reads
 * as the raw id.
 */
export function packLabel(id: string): string {
  const parts = id.split("_");
  // `icp_...` segments and the brand one (`brand_vsl`) both lead a pack id.
  if (parts.length >= 4 && (parts[0] === "icp" || parts[0] === "brand")) {
    const avatar = parts[parts.length - 2].replace(/-/g, " ");
    const concept = parts[parts.length - 1].replace(/-/g, " ");
    if (avatar && concept) return `${avatar} - ${concept}`;
  }
  return id;
}

/**
 * The most assets the hook comparison reads, signs and draws for one pack. A pack
 * is at most six variants today (CMO-Agent pack_ledger MAX_VARIANTS), so this is
 * headroom, not a page size: the comparison is never paged, and a pack larger
 * than this says "showing the first N of M" (loadPackComparison).
 */
export const PACK_COMPARE_CAP = 60;

/**
 * Variants in the order Maven numbered them. A variant with no number goes after
 * the numbered ones in the order it came in (Array.sort is stable), so a row
 * missing its hook_variant is shown, never dropped.
 */
export function sortByHookVariant<T>(items: readonly T[], variantOf: (item: T) => string | null | undefined): T[] {
  return [...items].sort((a, b) => {
    const na = hookVariantNumber(variantOf(a));
    const nb = hookVariantNumber(variantOf(b));
    if (na === null && nb === null) return 0;
    if (na === null) return 1;
    if (nb === null) return -1;
    return na - nb;
  });
}

export type SegmentFacet = { id: string; count: number };
export type PackFacet = { id: string; icp: string | null; count: number };

/**
 * Tally `(icp_segment, pack_id)` pairs read from the library into the two facet
 * lists. A value that is not a valid id is left out rather than offered as a
 * pill the page would then refuse. Known segments come first in the registry's
 * order, then any other segment by size; packs by size.
 */
export function tallyMetaFacets(
  rows: ReadonlyArray<{ icp_segment?: unknown; pack_id?: unknown }>,
): { segments: SegmentFacet[]; packs: PackFacet[] } {
  const segments = new Map<string, number>();
  const packs = new Map<string, PackFacet>();
  for (const row of rows) {
    const seg = isSegmentId(row.icp_segment) ? row.icp_segment : null;
    const pack = isPackId(row.pack_id) ? row.pack_id : null;
    if (seg) segments.set(seg, (segments.get(seg) ?? 0) + 1);
    if (pack) {
      const prev = packs.get(pack);
      if (prev) {
        prev.count += 1;
        if (!prev.icp && seg) prev.icp = seg;
      } else {
        packs.set(pack, { id: pack, icp: seg, count: 1 });
      }
    }
  }
  const known = new Map(ICP_SEGMENTS.map((s, i) => [s.id, i]));
  return {
    segments: [...segments.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => {
        const ka = known.get(a.id);
        const kb = known.get(b.id);
        if (ka !== undefined && kb !== undefined) return ka - kb;
        if (ka !== undefined) return -1;
        if (kb !== undefined) return 1;
        return b.count - a.count || a.id.localeCompare(b.id);
      }),
    packs: [...packs.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
  };
}

/** One variant in the hook comparison: everything a card draws, already plain. */
export type HookVariantCard = {
  id: string;
  title: string;
  status: AssetStatus;
  /** The Library's own bucket for it (Needs review, Approved, Posted, Archived). */
  lifecycle: Lifecycle;
  publishedAt: string | null;
  variantLabel: string;
  hookStyle: string | null;
  /** The opening line: meta.hook, else the asset's own hook column, else its title. */
  hook: string;
  playbackUrl: string | null;
  posterUrl: string | null;
  durationS: number | null;
  offerSlug: string | null;
  burnedCaptions: boolean;
  /** The asset page, carrying the Library view to come back to. */
  href: string;
};

type TileLike = {
  asset: {
    id: string;
    title: string;
    status: string;
    hook?: string | null;
    published_at?: string | null;
    duration_s?: number | string | null;
    meta?: unknown;
  };
  playbackUrl: string | null;
  posterUrl: string | null;
};

/** The cards for one pack, in variant order. `hrefFor` is the asset page link. */
export function hookVariantCards(tiles: readonly TileLike[], hrefFor: (id: string) => string): HookVariantCard[] {
  const withMeta = tiles.map((t) => ({ t, m: assetMetaView(t.asset.meta) }));
  return sortByHookVariant(withMeta, (x) => x.m.hookVariant).map(({ t, m }) => {
    const duration = Number(t.asset.duration_s);
    // A status this app does not know reads as a draft: not ready, no verdict.
    const status: AssetStatus = isAssetStatus(t.asset.status) ? t.asset.status : "draft";
    return {
      id: t.asset.id,
      title: t.asset.title,
      status,
      lifecycle: lifecycleOf({ status, published_at: t.asset.published_at ?? null }),
      publishedAt: t.asset.published_at ?? null,
      variantLabel: hookVariantLabel(m.hookVariant),
      hookStyle: m.hookStyle,
      hook: m.hook ?? (t.asset.hook && t.asset.hook.trim() ? t.asset.hook.trim() : t.asset.title),
      playbackUrl: t.playbackUrl,
      posterUrl: t.posterUrl,
      durationS: Number.isFinite(duration) && duration > 0 ? duration : null,
      offerSlug: m.offerSlug,
      burnedCaptions: m.burnedCaptions,
      href: hrefFor(t.asset.id),
    };
  });
}
