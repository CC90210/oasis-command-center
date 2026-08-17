-- ============================================================================
-- 145 — post_analytics.measured_at: "we have real numbers" vs "it just shipped"
--
-- WHY THIS EXISTS
-- Maven proposed closing the posting loop at the source: on dispatch, write a
-- post_analytics row per platform carrying the Late/Zernio ids and asset_id,
-- with metrics empty, so the hourly linker has an exact id to join on instead of
-- reconstructing the link from caption text. That is the right architecture —
-- it removes both of the linker's honest gaps at once (LinkedIn rewrites its
-- captions so there is no shared text; 13 assets have hooks too short to bet a
-- view count on).
--
-- It cannot be done safely against this table as it stood, and the reason is the
-- whole point of this migration:
--
--   impressions, views, likes, comments, shares, saves, clicks, follows
--     ARE ALL `not null default 0`
--
-- So a row inserted at publish time does not have "no metrics". It has ZERO
-- metrics, which is a measurement. And zero is already a REAL value here — 18 of
-- 103 live rows genuinely have views = 0, mostly LinkedIn. A freshly dispatched
-- post and a post nobody watched would be byte-identical.
--
-- The damage is not hypothetical. lib/founders-performance-core.ts `summarize()`
-- does `posts: acc.posts + 1` and sums every metric across all rows, so every
-- publish would immediately add a 0-view post to the totals, drag the averages,
-- and appear in "Most seen" at the bottom of the list. The Performance tab would
-- report a growing population of posts that failed, when what actually happened
-- is that nobody has asked the platform yet.
--
-- WHY NOT REUSE last_synced_at
-- It is `not null default now()`, so it stamps itself on insert and would read
-- "synced" the instant Maven writes the row. It answers "when did we last talk to
-- the API", which is a different question from "have real numbers ever arrived".
--
-- THE COLUMN
-- Nullable on purpose, and the null IS the signal: NULL means no measurement has
-- ever come back for this row. sync_post_analytics stamps it when it writes real
-- figures. Readers that total anything must exclude NULL rather than adding a
-- zero they were never told.
--
-- Existing rows are backfilled from last_synced_at because they demonstrably HAVE
-- been measured — they came from the analytics API in the first place. Backfilling
-- to NULL would invent an unmeasured state for 103 rows that are nothing of the
-- kind.
-- ============================================================================

alter table public.post_analytics
  add column if not exists measured_at timestamptz;

comment on column public.post_analytics.measured_at is
  'When real figures last came back from the platform. NULL means the row exists '
  'because the post was dispatched, and no measurement has arrived yet — which is '
  'NOT the same as zero views, a value 18 live rows genuinely hold. Anything that '
  'sums or averages must exclude NULL rather than counting a zero it was never told.';

-- Every row that predates this column arrived FROM the analytics API, so it has
-- been measured by definition. Idempotent: the WHERE makes a re-run a no-op.
update public.post_analytics
   set measured_at = last_synced_at
 where measured_at is null;

-- The Performance reader filters on it per tenant and window.
create index if not exists idx_post_analytics_measured
  on public.post_analytics (tenant_id, measured_at);
