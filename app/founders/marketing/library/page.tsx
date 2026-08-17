/**
 * /founders/marketing/library — every artifact OASIS has produced, watchable in place.
 *
 * Adon: "Whenever you update or generate a new type of video, I'm able to watch
 * it seamlessly on there, whether that's an ad, whether that's HTML, whether
 * that's a video, short term, long form."
 *
 * FOUNDERS ONLY, same gate as /founders/marketing.
 *
 * Bytes live in Supabase Storage, not Postgres, so a 400 MB long-form video
 * never touches the database. Playback URLs are signed server-side per object
 * and expire in an hour; the browser never holds a service key.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE AXES, IN THE ORDER CC ACTUALLY WORKS (2026-08-16)
 *
 * He asked for brand tabs — "Oasis AI / CC / Adon / Music / stuff like that" —
 * and said the channel tiles read as confusing. Both complaints are the same
 * complaint: the page led with its least useful axis.
 *
 *   1. BRAND     — tabs. The first question asked of any asset. `brand_slug`.
 *   2. LIFECYCLE — pills. Needs review / Approved / Posted / Archived.
 *   3. CHANNEL   — demoted to a facet under "Refine". Still here, no longer the
 *                  headline, because it cannot tell the truth: `channel` holds
 *                  one value and a post goes to as many as six places, so 37 of
 *                  47 rows claim Instagram.
 *
 * THE LIFECYCLE AXIS, AND WHY IT IS NOT `status`.
 * CC, 2026-08-16: *"Are these videos that we haven't posted yet? ... Have they
 * not been posted at all, ever?"* He could not tell, and this page was the
 * reason: every tile read IN REVIEW, which looks like 41 things waiting on him.
 *
 * An earlier pass declined to build this filter at all, on the grounds that
 * `status` is unreliable — library_sync.py stamps `in_review` on registration.
 * That was the right diagnosis and the wrong conclusion. Refusing to organise
 * the page left CC staring at an undifferentiated wall, which is worse than
 * organising it on evidence.
 *
 * So the buckets do not trust `status` for the question it cannot answer.
 * Distribution comes from `published_at` — proof a platform took it — and
 * outranks review state, because the world is the authority, not our
 * bookkeeping. See lifecycleOf() in founders-marketing-core.
 *
 * ARCHIVED IS A BUCKET, NOT A HOLE. CC archived a video and reported it
 * "completely gone". The row was intact the whole time; the page simply had no
 * filter that could show it and no control that could return it. It is now a
 * pill with a count, and every archived tile carries Restore.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { Card, PageHeader } from "@/components/Card";
import { safe } from "@/lib/api-helpers";
import { resolveFounder } from "@/lib/founders/gate";
import {
  DEGRADED_MARKETING_FACETS,
  getMarketingAssets,
  getLifecycleCounts,
  getMarketingFacets,
  mediaKey,
  signMediaUrls,
  type MarketingAssetRow,
} from "@/lib/founders/marketing-queries";
import {
  BRAND_GROUPS,
  DEFAULT_BRAND_GROUP,
  LIFECYCLE,
  TRACKS,
  brandGroupFor,
  channelLabel,
  channelsForTrack,
  isAssetStatus,
  isBrandGroupKey,
  authorName,
  isLifecycle,
  lifecycleHint,
  lifecycleLabel,
  parseSlideUrls,
  isChannel,
  trackForChannel,
  trackLabel,
  type AssetStatus,
  type BrandGroupKey,
  type Channel,
  type Lifecycle,
  type Track,
} from "@/lib/founders-marketing-core";
import { AssetTile, MarketingEmpty } from "@/components/founders/marketing-shared";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Library · Marketing · OASIS",
};

function isTrack(v: string | undefined): v is Track {
  return !!v && (TRACKS as readonly string[]).includes(v);
}

export default async function MarketingLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{
    group?: string;
    track?: string;
    channel?: string;
    brand?: string;
    author?: string;
    status?: string;
    lifecycle?: string;
  }>;
}) {
  const founder = await resolveFounder();
  if (!founder) notFound();

  const sp = await searchParams;
  // An unknown ?group= falls back to the default tab rather than 404ing or
  // showing everything — a bad tab name is a typo, not a request for a wider view.
  const group: BrandGroupKey = isBrandGroupKey(sp.group) ? sp.group : DEFAULT_BRAND_GROUP;
  const track = isTrack(sp.track) ? sp.track : undefined;
  const channel = isChannel(sp.channel) ? (sp.channel as Channel) : undefined;
  const brand = typeof sp.brand === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sp.brand)
    ? sp.brand
    : undefined;
  const author = typeof sp.author === "string" && sp.author.length <= 320 ? sp.author : undefined;
  // Studio's pipeline tiles link here with ?status=; validated against the
  // canonical list so an arbitrary string never reaches the query.
  const status = isAssetStatus(sp.status) ? sp.status : undefined;
  // The primary organisation axis. Absent = the default working view, which
  // shows everything except archived.
  const lifecycle: Lifecycle | undefined = isLifecycle(sp.lifecycle) ? sp.lifecycle : undefined;

  // `null` rather than `[]` as the fallback: an empty array cannot say whether
  // the library is empty or the query failed, and the page renders very
  // different copy for those two. getMarketingAssets throws on a broken read and
  // returns [] only when the table genuinely is not there yet.
  const [assetsOrNull, facets, lc] = await Promise.all([
    safe<MarketingAssetRow[] | null>(
      "marketing.library",
      getMarketingAssets(founder.tenantId, {
        group, track, channel, brand, author, status, lifecycle,
      }),
      null,
    ),
    safe("marketing.library.facets", getMarketingFacets(founder.tenantId), DEGRADED_MARKETING_FACETS),
    safe("marketing.library.lifecycle", getLifecycleCounts(founder.tenantId, group), {
      counts: { needs_review: 0, approved: 0, live: 0, archived: 0 },
      degraded: true,
    }),
  ]);
  const lifecycleTotal = lc.degraded
    ? 0
    : LIFECYCLE.reduce((n, l) => n + lc.counts[l], 0);
  const libraryDegraded = assetsOrNull === null;
  const assets = assetsOrNull ?? [];

  // Tab counts, from the one reader that deliberately spans every brand.
  // A tab with no rows still renders — it is navigation, not a measurement, and
  // an absent tab is how CC ends up not knowing a brand exists. What it must NOT
  // do is print a confident 0 when the count simply failed to load.
  const countFor = (key: BrandGroupKey): number | null =>
    facets.degraded
      ? null
      : facets.brands
          .filter((b) => brandGroupFor(b.slug) === key)
          .reduce((n, b) => n + b.count, 0);

  /** Brands inside the current tab — the sub-filter, e.g. Warner within Clients. */
  const brandsInGroup = facets.brands.filter((b) => brandGroupFor(b.slug) === group);

  // ONE author means no choice to make, so the control is hidden rather than
  // rendered with a single dead option. Today every row carries the schema
  // default `conaugh@oasisai.work` — Maven has never stamped a second author —
  // so this row is invisible and lights up the moment that changes.
  const showAuthors = facets.authors.length > 1;

  // Pick the objects each tile needs, then sign them ALL in one batched call per
  // bucket. Signing per object was one Storage round-trip each — 400 sequential
  // requests on a full 200-asset library, which is the entire render time.
  const pick = (a: (typeof assets)[number]) => {
    const media = a.media || [];
    return {
      video: media.find((m) => m.kind === "video"),
      poster:
        media.find((m) => m.kind === "poster") ||
        media.find((m) => m.kind === "thumb") ||
        media.find((m) => m.kind === "preview") ||
        media.find((m) => m.kind === "image"),
    };
  };

  // Slides are signed too, in `media_urls` order. A carousel read out of order
  // is a different post, so the order recorded at migration time is the order
  // rendered — never re-derived from the media rows, whose row order means
  // nothing.
  const slidePaths = (a: (typeof assets)[number]): string[] =>
    parseSlideUrls(a.media_urls).filter(Boolean);

  const refs = assets.flatMap((a) => {
    const { video, poster } = pick(a);
    const base = [video, poster]
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map((m) => ({ bucket: m.storage_bucket, path: m.storage_path }));
    const slides = slidePaths(a).map((path: string) => ({ bucket: "marketing-media", path }));
    return [...base, ...slides];
  });
  const urls = await safe("marketing.library.sign", signMediaUrls(refs), new Map<string, string>());

  const signed = assets.map((a) => {
    const { video, poster } = pick(a);
    const shape = video ?? poster;
    return {
      asset: a,
      playbackUrl: video ? (urls.get(mediaKey(video.storage_bucket, video.storage_path)) ?? null) : null,
      posterUrl: poster ? (urls.get(mediaKey(poster.storage_bucket, poster.storage_path)) ?? null) : null,
      mediaW: shape?.width ?? null,
      mediaH: shape?.height ?? null,
      // ALL SLIDES OR NONE. Mapping then filtering silently renumbers a carousel
      // when one slide fails to sign — 1,2,4,5 rendered as "1/4..4/4" — and a
      // carousel read out of order is a different post. If we cannot show the
      // whole thing we show the cover instead, which is honest rather than
      // confidently wrong.
      slideUrls: (() => {
        const paths = slidePaths(a);
        const signedSlides = paths.map((path: string) =>
          urls.get(mediaKey("marketing-media", path)));
        return signedSlides.every(Boolean) ? (signedSlides as string[]) : [];
      })(),
    };
  });

  // Derive ONE supported-channel list and use it for row visibility, pill
  // rendering and active state. The earlier version made `activeChannels` a
  // length-1 array as soon as a channel was picked, so the channel row unmounted
  // and there was no way to switch or clear the filter — a dead end. It also
  // matched channels with startsWith(track), which happens to work only because
  // every channel name is currently prefixed by its track; channelsForTrack()
  // uses the real mapping and cannot drift.
  const activeTrack: Track | undefined = track ?? (channel ? trackForChannel(channel) : undefined);
  const channelOptions: Channel[] = activeTrack ? channelsForTrack(activeTrack) : [];
  // Every dimension is preserved unless explicitly overridden. `status` was
  // omitted here once while Studio's pipeline tiles link in WITH it, so arriving
  // on "In review" and then touching any pill — including "All" — silently
  // widened the view to every status while the page gave no sign it had. You
  // were reviewing, then you were not, and nothing said so.
  const filterHref = (next: {
    group?: BrandGroupKey;
    track?: Track | null;
    channel?: Channel | null;
    brand?: string | null;
    author?: string | null;
    status?: AssetStatus | null;
    lifecycle?: Lifecycle | null;
  }) => {
    const params = new URLSearchParams();
    const nextGroup = next.group ?? group;
    // Switching tabs CLEARS the brand sub-filter. `warner` is meaningless on the
    // OASIS tab — the reader would drop it anyway (brandFilterAllowed), but a URL
    // that still carries it describes a view the page is not showing, and the
    // next click would propagate the lie.
    const groupChanged = next.group !== undefined && next.group !== group;
    const nextTrack = next.track === undefined ? track : next.track || undefined;
    const nextChannel = next.channel === undefined ? channel : next.channel || undefined;
    const nextBrand = groupChanged
      ? undefined
      : next.brand === undefined ? brand : next.brand || undefined;
    const nextAuthor = next.author === undefined ? author : next.author || undefined;
    // ONE OR THE OTHER, NEVER BOTH. They filter the same column with different
    // vocabularies, so carrying both produces `status = 'draft' AND status IN
    // ('archived',...)` — an empty grid under pills that promise rows. Setting
    // either one drops the other, which is also what the operator means: picking
    // "Archived" is a request to see archived, not to intersect it with the
    // stage they arrived from.
    const settingLifecycle = next.lifecycle !== undefined;
    const settingStatus = next.status !== undefined;
    const nextStatus = settingLifecycle
      ? undefined
      : next.status === undefined ? status : next.status || undefined;
    const nextLifecycle = settingStatus
      ? undefined
      : next.lifecycle === undefined ? lifecycle : next.lifecycle || undefined;
    if (nextGroup !== DEFAULT_BRAND_GROUP) params.set("group", nextGroup);
    if (nextTrack) params.set("track", nextTrack);
    if (nextChannel) params.set("channel", nextChannel);
    if (nextBrand) params.set("brand", nextBrand);
    if (nextAuthor) params.set("author", nextAuthor);
    if (nextStatus) params.set("status", nextStatus);
    if (nextLifecycle) params.set("lifecycle", nextLifecycle);
    const query = params.toString();
    return `/founders/marketing/library${query ? `?${query}` : ""}`;
  };

  const activeGroup = BRAND_GROUPS.find((g) => g.key === group)!;
  const filtered = !!(track || channel || brand || author || status || lifecycle);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Library"
        // CC, 2026-08-16: "Are the posts in this library just stockpiled, and how
        // do we function with our automations? Are they taking from this library
        // when we post automatically?"
        //
        // They are not, and the page had never said so. The daily poster reads
        // data/post_queue/*.json and mirrors the result here as its LAST step —
        // this table is a record of what already shipped, never a queue anything
        // draws from. A page showing a Draft -> Scheduled -> Published pipeline
        // invites exactly the opposite reading, so it now states the direction.
        subtitle="A record of what has already been produced — the daily poster writes here, it never reads from here."
        action={
          <Link href="/founders/marketing" className="text-xs font-semibold text-accent hover:underline">
            Back to Studio
          </Link>
        }
      />

      {/* ── Axis 1: BRAND. Tabs, not pills — this is navigation between separate
          bodies of work, and it should not look like the facets that narrow
          within one. */}
      <div className="-mb-px flex flex-wrap items-end gap-1 border-b border-bg-border">
        {BRAND_GROUPS.map((g) => {
          const n = countFor(g.key);
          const active = g.key === group;
          return (
            <Link
              key={g.key}
              href={filterHref({ group: g.key })}
              aria-current={active ? "page" : undefined}
              className={
                "flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors " +
                (active
                  ? "border-accent font-semibold text-fg"
                  : "border-transparent font-medium text-fg-dim hover:border-bg-border hover:text-fg")
              }
            >
              {g.label}
              {/* `null` = the facet read failed. An em dash says "unknown"; a 0
                  would say "this brand has nothing", which is a different fact
                  and the one that stops CC opening the tab. */}
              <span className={active ? "text-accent" : "text-fg-dim"}>
                {n === null ? "—" : n}
              </span>
            </Link>
          );
        })}
      </div>

      {/* ── Axis 2: LIFECYCLE. The organisation CC asked for three times.
          Review state and distribution state are DIFFERENT questions and the
          single `status` column answered neither — see lifecycleOf(). */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterPill
          href={filterHref({ lifecycle: null })}
          label={`All ${lifecycleTotal || ""}`.trim()}
          active={!lifecycle}
        />
        {LIFECYCLE.map((l) => {
          const n = lc.degraded ? null : lc.counts[l];
          return (
            <FilterPill
              key={l}
              href={filterHref({ lifecycle: l })}
              label={`${lifecycleLabel(l)} ${n === null ? "—" : n}`}
              active={lifecycle === l}
            />
          );
        })}
      </div>

      {/* The sentence that answers "have these been posted at all, ever?".
          Rendered from the counts rather than written as a claim, so it cannot
          go stale the way a hardcoded roadmap note does. */}
      {!lc.degraded && lc.counts.live === 0 && lifecycleTotal > 0 && (
        <div className="rounded-lg border border-bg-border bg-bg-deep/40 px-4 py-3 text-xs leading-5 text-fg-muted">
          <span className="font-semibold text-fg">
            None of these {lifecycleTotal} have been posted.
          </span>{" "}
          This library holds produced creative. Your live posts come from the daily
          poster reading <code className="text-fg-dim">data/post_queue</code>, are a
          separate stream, and are counted in{" "}
          <Link href="/founders/marketing/performance" className="font-semibold text-accent hover:underline">
            Performance
          </Link>
          . Nothing here reaches an account until it is posted from the asset page.
        </div>
      )}

      {/* Sub-filter WITHIN the tab: Warner / Arthrisil / blyss inside Clients.
          Hidden when the tab holds a single brand, where it would be a control
          with one option. */}
      {brandsInGroup.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-dim">
            {activeGroup.label}
          </span>
          <FilterPill href={filterHref({ brand: null })} label="All" active={!brand} subtle />
          {brandsInGroup.map((item) => (
            <FilterPill
              key={item.slug}
              href={filterHref({ brand: item.slug })}
              label={`${item.name} ${item.count}`}
              active={brand === item.slug}
              subtle
            />
          ))}
        </div>
      )}

      {/* A status filter arrives from Studio's pipeline tiles, never from a pill
          here, so without this row the page silently showed a subset with no
          indication of why — and no way back. */}
      {status && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-dim">Stage</span>
          <FilterPill href={filterHref({})} label={status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())} active />
          <Link
            href={filterHref({ status: null })}
            className="text-[11px] font-semibold text-fg-dim transition-colors hover:text-fg"
          >
            Clear stage
          </Link>
        </div>
      )}

      {/* ── Axis 3: CHANNEL, demoted. Under a "Refine" label and rendered subtle,
          so it stops reading as the primary way into the library. */}
      <details className="group/refine" open={!!(track || channel || author)}>
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-dim transition-colors hover:text-fg-muted">
          Refine
          {filtered && !status && <span className="font-medium normal-case tracking-normal text-accent">· active</span>}
        </summary>

        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-dim">Channel</span>
            <FilterPill href={filterHref({ track: null, channel: null })} label="Any" active={!track && !channel} subtle />
            {TRACKS.map((t) => (
              <FilterPill
                key={t}
                href={filterHref({ track: t, channel: null })}
                label={trackLabel(t)}
                // Stays lit while drilled into one of its channels, so the view
                // always shows where you are.
                active={activeTrack === t}
                subtle
              />
            ))}
          </div>

          {channelOptions.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 pl-1">
              <FilterPill
                href={filterHref({ track: activeTrack as Track, channel: null })}
                label={`All ${trackLabel(activeTrack as Track)}`}
                active={!channel}
                subtle
              />
              {channelOptions.map((c) => (
                <FilterPill
                  key={c}
                  href={filterHref({ track: null, channel: c })}
                  label={channelLabel(c)}
                  active={channel === c}
                  subtle
                />
              ))}
            </div>
          )}

          {showAuthors && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-dim">By</span>
              <FilterPill href={filterHref({ author: null })} label="Anyone" active={!author} subtle />
              {facets.authors.map((a) => (
                <FilterPill
                  key={a.email}
                  href={filterHref({ author: a.email })}
                  // The local part is the readable half; the full address is the
                  // title, so two people at one domain are still distinguishable.
                  label={`${authorName(a.email)} ${a.count}`}
                  active={author === a.email}
                  subtle
                />
              ))}
            </div>
          )}
        </div>
      </details>

      {/* The count sits with the grid it describes rather than in the header,
          which now carries the "what this page IS" line. */}
      {assets.length > 0 && (
        <div className="px-1 text-xs text-fg-dim">
          {assets.length} {assets.length === 1 ? "asset" : "assets"}
          {channel ? ` · ${channelLabel(channel)}` : track ? ` · ${trackLabel(track)}` : ""}
        </div>
      )}

      {assets.length === 0 ? (
        <Card>
          <MarketingEmpty
            // Order matters: a failed read outranks everything, because when the
            // query broke we know nothing about what is in here. Then the
            // narrowest filter that could explain the emptiness, so the copy
            // names the thing to clear rather than declaring the library empty —
            // which was flatly false when only one stage was.
            // LIFECYCLE NEEDS A RUNG OF ITS OWN. Without one, clicking a pill
            // with a zero count — "Approved 0" — fell through to
            // "<brand> is empty", which is flatly false about a library holding
            // 43 assets, and is the exact lie this ladder exists to prevent. A
            // new filter added above the grid has to add a rung here in the same
            // change, or the most prominent control on the page produces the
            // most misleading empty state.
            headline={
              libraryDegraded
                ? "Couldn't load the library"
                : status
                ? "Nothing at this stage"
                : lifecycle
                  ? `Nothing ${lifecycleLabel(lifecycle).toLowerCase()}`
                  : track || channel
                    ? "Nothing in this channel yet"
                    : author
                      ? "Nothing from this author"
                      : brand
                        ? "Nothing under this brand yet"
                        : `${activeGroup.label} is empty`
            }
            detail={
              libraryDegraded
                ? "The query failed, so this is not a statement about what the library holds. Nothing has been lost — refresh, and if it persists the server log carries the reason under [marketing:assets]."
                : status
                ? "No assets are sitting at this stage right now. Clear the stage to see the rest of the library."
                : lifecycle
                  ? `Nothing in this tab is ${lifecycleHint(lifecycle)}. The library is not empty — pick another state above to see the rest.`
                  : track || channel
                    ? "No assets are registered for this channel. Produce something, or clear the filter to see everything."
                    : author
                      ? "Nobody has registered an asset under this address in this tab."
                      : brand
                        ? "This brand has no assets in the library yet."
                        : activeGroup.empty
            }
            hint="Drop links in the Train tab — they are fetched and analysed within a few minutes."
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {/* items-start: tiles now differ in height because each takes its asset's own
              shape. Without it the grid stretches every tile to the tallest in its row,
              leaving a 9:16 tile's worth of empty panel beside every 16:9 one — dead
              space created BY the fix. */}
          {signed.map(({ asset, playbackUrl, posterUrl, mediaW, mediaH, slideUrls }) => (
            <AssetTile
              key={asset.id}
              id={asset.id}
              title={asset.title}
              brandName={asset.brand_name}
              channel={asset.channel}
              status={asset.status}
              publishedAt={asset.published_at}
              hook={asset.hook}
              aspect={asset.aspect}
              durationS={asset.duration_s}
              format={asset.format}
              platforms={asset.platforms}
              assetType={asset.asset_type}
              slideUrls={slideUrls}
              playbackUrl={playbackUrl}
              posterUrl={posterUrl}
              mediaW={mediaW}
              mediaH={mediaH}
              openReviews={asset.open_reviews}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterPill({
  href,
  label,
  active,
  subtle = false,
}: {
  href: string;
  label: string;
  active: boolean;
  subtle?: boolean;
}) {
  const base = "px-3 py-1.5 rounded-full text-xs border transition-all";
  const cls = active
    ? "bg-accent-soft text-accent border-accent/30 font-semibold"
    : subtle
      ? "bg-bg-deep/40 text-fg-dim border-bg-border hover:bg-bg-hover font-medium"
      : "bg-bg-elev text-fg-muted border-bg-border hover:bg-bg-hover font-medium";
  return (
    <Link href={href} className={`${base} ${cls}`}>
      {label}
    </Link>
  );
}
