-- ============================================================================
-- 144 — marketing_asset: where a post went, and what shape it is
--
-- The Postgres side of three changes that were applied to the live Turso
-- database as bravo__004 and bravo__005. Turso is the running backend
-- (EMPIRE_DATA_BACKEND=turso_cloud), but database/*.sql is the documented
-- schema, so a fresh Postgres environment would otherwise be missing the columns
-- the app now reads — the Library would fail on `platforms` before it rendered a
-- single tile.
--
-- Written to be idempotent: every statement is IF NOT EXISTS, so applying it to
-- an environment that has already been migrated is a no-op rather than an error.
--
-- ---------------------------------------------------------------------------
-- WHY platforms EXISTS AT ALL
-- CC: "it's only posting to Instagram." `channel` holds ONE value and a post
-- goes to as many as six places, so a six-platform post had no channel it could
-- honestly declare and took 'organic-instagram'. Widening the channel CHECK
-- could not fix that — one column still cannot hold six values — so `channel`
-- keeps its meaning as the PRIMARY channel and the input to the generated
-- `track` column, and `platforms` carries the distribution.
--
-- WHY asset_type IS NOT A CHECK
-- The live backend is SQLite, which cannot widen a CHECK without rebuilding the
-- table — seven indexes, a STORED generated column and seven child foreign keys.
-- marketing_asset.channel is already stuck that way. This vocabulary will grow
-- (story, reel, thread), so it is validated in lib/founders-marketing-core.ts
-- where it can change with a deploy. Kept unconstrained here too, deliberately,
-- so the two backends agree.
-- ============================================================================

alter table public.marketing_asset
  add column if not exists platforms    jsonb   not null default '[]'::jsonb,
  add column if not exists asset_type   text    not null default 'single_image',
  add column if not exists media_urls   jsonb   not null default '[]'::jsonb,
  add column if not exists slide_count  integer not null default 1,
  add column if not exists author_email text    not null default 'conaugh@oasisai.work';

comment on column public.marketing_asset.platforms is
  'Where the asset ACTUALLY went — JSON array of platform keys. Stamped by the '
  'publish drain with the networks that ACCEPTED the post; a refusal is not a '
  'distribution. `channel` remains the primary channel and feeds `track`.';

comment on column public.marketing_asset.asset_type is
  'video | single_image | carousel. Validated in lib/founders-marketing-core.ts, '
  'not by a CHECK — SQLite cannot widen one without a table rebuild.';

comment on column public.marketing_asset.media_urls is
  'Ordered storage paths, one per slide. ORDER IS THE PAYLOAD: a carousel read '
  'out of order is a different post. The media rows carry no rank, so this is '
  'the only record of which slide is which.';

comment on column public.marketing_asset.author_email is
  'Provenance. Two founders use this portal and a display name is not an '
  'identity you can argue with later.';

-- The Library reads carousels by type; the drain reads slide order.
create index if not exists idx_marketing_asset_type
  on public.marketing_asset (tenant_id, asset_type, created_at desc);

create index if not exists idx_marketing_asset_platforms
  on public.marketing_asset (tenant_id, published_at desc)
  where published_at is not null;
