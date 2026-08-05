-- 133_marketing_hub.sql — Founders Portal Marketing Hub
--
-- Design: docs/superpowers/specs/2026-08-02-founders-marketing-hub-design.md
--
-- WHY THIS EXISTS
-- The founders portal needs one place that holds every marketing artifact OASIS
-- produces, the verdicts founders pass on them, and the corpus those verdicts
-- train a CMO agent on. `lib/agents/library.ts` already declares Maven with
-- required_tools ["content_calendar_query","voice_samples","late_tool"] and a
-- base_prompt promising "Match the operator's voice samples on file" — none of
-- which had anything behind them. These tables are that backing.
--
-- FAILURE MODE THIS PREVENTS
-- Marketing artifacts scattered across a filesystem, a Remotion output dir and
-- an operator's memory cannot be retrieved at generation time, so the agent
-- relearns nothing and every draft starts cold. Worse, a rejection with a reason
-- ("the hook is too slow") is the single highest-value training signal available
-- and had nowhere to live at all.
--
-- TENANCY
-- Routing for /founders/marketing is founders-only via an env allowlist (see
-- lib/founders/gate.ts), NOT via these policies. tenant_id + RLS is
-- defence in depth: getServiceSupabase() bypasses RLS repo-wide, so every read
-- must still filter manually. Same five-line ritual as 110/121.
--
-- MULTI-AGENT
-- author_agent / reviewer_agent / contributed_by exist from day one because two
-- CMO agents (Adon's and CC's) will co-work this surface later, and retrofitting
-- identity onto live rows is a backfill migration.
--
-- Idempotent: re-runnable in full.

-- ─────────────────────────────────────────────────────────────── assets

create table if not exists public.marketing_asset (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,

  title          text not null,
  -- Closed taxonomy. An agent writes these rows; free text would drift.
  channel        text not null
                   check (channel in (
                     'organic-instagram','organic-facebook','organic-tiktok',
                     'organic-youtube','paid-meta','paid-google',
                     'seo-article','seo-landing','email')),
  -- GENERATED, not merely checked. An earlier draft had `track` as a plain
  -- column with its own CHECK, which let an 'organic-instagram' row declare
  -- track='paid' and satisfy both constraints independently — silently wrong
  -- grouping that no query would flag. Derived here so desync is impossible
  -- rather than improbable. Mirrors trackForChannel() in
  -- lib/founders-marketing-core.ts, which is the authority in TypeScript.
  -- Written out per-channel rather than by LIKE 'organic-%' so the mapping does
  -- not silently depend on channel names happening to be prefixed by track.
  track          text generated always as (
                   case channel
                     when 'organic-instagram' then 'organic'
                     when 'organic-facebook'  then 'organic'
                     when 'organic-tiktok'    then 'organic'
                     when 'organic-youtube'   then 'organic'
                     when 'paid-meta'         then 'paid'
                     when 'paid-google'       then 'paid'
                     when 'seo-article'       then 'seo'
                     when 'seo-landing'       then 'seo'
                     when 'email'             then 'email'
                   end
                 ) stored,
  format         text not null
                   check (format in ('video','image','carousel','html','article','copy','audio')),
  aspect         text,                       -- '9:16' | '1:1' | '4:5' | '16:9'
  status         text not null default 'draft'
                   check (status in ('draft','in_review','approved','scheduled',
                                     'published','rejected','archived')),

  hook           text,                       -- opening line / headline
  body           text,                       -- caption / script / copy
  cta            text,
  landing_url    text,
  campaign       text,
  duration_s     numeric(10,2),

  -- Which agent (or human) produced this. See MULTI-AGENT above.
  author_agent   text not null default 'human',
  source         text,                       -- 'remotion:OasisInstagramAd' | 'brief:<id>' | 'manual'

  scheduled_for  timestamptz,
  published_at   timestamptz,
  external_id    text,                       -- platform post/ad id once published
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  meta           jsonb not null default '{}'::jsonb,

  -- Target for the child tables' COMPOSITE foreign keys. Every marketing_*
  -- child references (tenant_id, asset_id) rather than the bare asset id, so a
  -- tenant-A row physically cannot attach to a tenant-B asset. This matters
  -- here more than in most codebases: getServiceSupabase() BYPASSES RLS, so
  -- tenant isolation is otherwise only an application-code convention, and a
  -- single missing .eq('tenant_id') would create the cross-tenant relation
  -- with nothing to object. The database now objects.
  constraint marketing_asset_tenant_id_key unique (tenant_id, id)
);
create index if not exists idx_marketing_asset_tenant_track
  on public.marketing_asset (tenant_id, track, status, created_at desc);
create index if not exists idx_marketing_asset_tenant_created
  on public.marketing_asset (tenant_id, created_at desc);
create index if not exists idx_marketing_asset_scheduled
  on public.marketing_asset (tenant_id, scheduled_for)
  where scheduled_for is not null;

alter table public.marketing_asset enable row level security;
alter table public.marketing_asset force row level security;
revoke all on public.marketing_asset from anon, authenticated;
drop policy if exists marketing_asset_service_role on public.marketing_asset;
create policy marketing_asset_service_role on public.marketing_asset for all to service_role using (true) with check (true);
drop policy if exists marketing_asset_tenant on public.marketing_asset;
create policy marketing_asset_tenant on public.marketing_asset for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));

-- ─────────────────────────────────────────────────────────────── media

-- Files backing an asset. Bytes live in Supabase Storage (same posture as
-- lead-documents / chat-attachments); this table holds only the pointer, so a
-- 400 MB long-form video never touches Postgres.
create table if not exists public.marketing_asset_media (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  asset_id       uuid not null,

  kind           text not null
                   check (kind in ('video','poster','preview','thumb','audio','html','source','caption')),
  storage_bucket text not null default 'marketing-media',
  storage_path   text not null,              -- {tenant_id}/{asset_id}/{ts}_{uuid}_{name}
  mime           text,
  bytes          bigint,
  width          int,
  height         int,
  label          text,
  created_at     timestamptz not null default now(),

  unique (tenant_id, storage_bucket, storage_path),
  -- Composite FK: a tenant's media cannot attach to another tenant's asset.
  constraint marketing_asset_media_asset_fk
    foreign key (tenant_id, asset_id) references public.marketing_asset (tenant_id, id) on delete cascade
);
create index if not exists idx_marketing_media_asset
  on public.marketing_asset_media (asset_id, kind);

alter table public.marketing_asset_media enable row level security;
alter table public.marketing_asset_media force row level security;
revoke all on public.marketing_asset_media from anon, authenticated;
drop policy if exists marketing_asset_media_service_role on public.marketing_asset_media;
create policy marketing_asset_media_service_role on public.marketing_asset_media for all to service_role using (true) with check (true);
drop policy if exists marketing_asset_media_tenant on public.marketing_asset_media;
create policy marketing_asset_media_tenant on public.marketing_asset_media for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));

-- ─────────────────────────────────────────────────────────── reviews

-- The training signal. Ranked by value: a request_changes NOTE beats a
-- rejection+reason beats real performance beats an approval. An approval says
-- "fine" and locates no boundary; "the hook is too slow" says exactly where it is.
create table if not exists public.marketing_review (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  asset_id       uuid not null,

  decision       text not null
                   check (decision in ('approve','approve_with_changes','request_changes','reject','comment')),
  -- Enforced in the API layer too, but stated here so the DB carries the rule:
  -- a verdict that rejects or asks for changes without saying why is worthless
  -- as training data.
  note           text,
  reviewer       text not null default 'adon',
  reviewer_agent text,                       -- set when an agent reviewed, null when human
  created_at     timestamptz not null default now(),
  -- Set when the agent has read and acted on this verdict.
  acted_on_at    timestamptz,

  constraint marketing_review_reason_required
    check (decision in ('approve','comment') or coalesce(btrim(note), '') <> ''),
  constraint marketing_review_asset_fk
    foreign key (tenant_id, asset_id) references public.marketing_asset (tenant_id, id) on delete cascade
);
create index if not exists idx_marketing_review_open
  on public.marketing_review (tenant_id, acted_on_at, created_at)
  where acted_on_at is null;
create index if not exists idx_marketing_review_asset
  on public.marketing_review (asset_id, created_at desc);

alter table public.marketing_review enable row level security;
alter table public.marketing_review force row level security;
revoke all on public.marketing_review from anon, authenticated;
drop policy if exists marketing_review_service_role on public.marketing_review;
create policy marketing_review_service_role on public.marketing_review for all to service_role using (true) with check (true);
drop policy if exists marketing_review_tenant on public.marketing_review;
create policy marketing_review_tenant on public.marketing_review for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));

-- ────────────────────────────────────────────────────────── requests

-- Operator -> agent work queue. "Make me 3 TikTok hooks for the system ad."
create table if not exists public.marketing_request (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,

  kind           text not null
                   check (kind in ('generate','variant','revise','research','question')),
  title          text not null,
  detail         text,
  channel        text,
  asset_id       uuid,
  priority       int not null default 50,
  status         text not null default 'open'
                   check (status in ('open','claimed','done','dropped')),
  requester      text not null default 'adon',
  claimed_by     text,                       -- which agent took it
  response       text,
  created_at     timestamptz not null default now(),
  claimed_at     timestamptz,
  done_at        timestamptz,
  -- Nullable asset_id: MATCH SIMPLE skips the check when asset_id is NULL,
  -- which is the intended "request not tied to an asset" case.
  constraint marketing_request_asset_fk
    foreign key (tenant_id, asset_id) references public.marketing_asset (tenant_id, id) on delete set null
);
create index if not exists idx_marketing_request_open
  on public.marketing_request (tenant_id, status, priority desc, created_at);

alter table public.marketing_request enable row level security;
alter table public.marketing_request force row level security;
revoke all on public.marketing_request from anon, authenticated;
drop policy if exists marketing_request_service_role on public.marketing_request;
create policy marketing_request_service_role on public.marketing_request for all to service_role using (true) with check (true);
drop policy if exists marketing_request_tenant on public.marketing_request;
create policy marketing_request_tenant on public.marketing_request for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));

-- ──────────────────────────────────────────────────────────── corpus

-- What the agent is trained on. Phase 2 fills this; Phase 4 retrieves from it.
--
-- Retrieval is LEXICAL for v1 (pg_trgm, already in use by find_similar_merchants).
-- There is no pgvector in this project and `claude -p` cannot emit embeddings, so
-- the subscription seam that makes every other LLM call free does not cover
-- embedding generation. search_text is the materialized haystack; an embedding
-- column can be added later without touching this shape.
create table if not exists public.marketing_corpus (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,

  kind           text not null
                   check (kind in ('media','link','metrics','lesson','verdict')),
  -- exemplar = do more of this. counter_example = never again. Both are training
  -- data; counter_examples are the scarcer and more valuable of the two.
  label          text not null default 'exemplar'
                   check (label in ('exemplar','counter_example','neutral')),

  title          text,
  source_url     text,
  storage_bucket text,
  storage_path   text,
  asset_id       uuid,

  transcript     text,
  extraction     jsonb not null default '{}'::jsonb,   -- hooks, pacing, on-screen text, teardown
  -- Materialized lexical haystack: title + transcript + flattened extraction.
  -- Written by the ingest worker, queried with pg_trgm similarity.
  search_text    text,

  -- Async ingest lifecycle. "Automatically ingested over a reasonable period of
  -- time" means this is a queue, not a request-blocking operation.
  state          text not null default 'queued'
                   check (state in ('queued','extracting','indexed','failed','skipped')),
  attempts       int not null default 0,
  last_error     text,

  contributed_by text not null default 'adon',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  indexed_at     timestamptz,
  constraint marketing_corpus_asset_fk
    foreign key (tenant_id, asset_id) references public.marketing_asset (tenant_id, id) on delete set null
);
create index if not exists idx_marketing_corpus_due
  on public.marketing_corpus (state, created_at)
  where state in ('queued','extracting');
create index if not exists idx_marketing_corpus_tenant
  on public.marketing_corpus (tenant_id, label, created_at desc);

-- AT MOST ONE UNFINISHED INGEST PER SOURCE, enforced by the database rather
-- than by a read-then-insert in the route. Two concurrent submits of the same
-- URL can both pass a SELECT-based check before either INSERT commits. Same
-- primitive as 121_phone_lookup_jobs.
create unique index if not exists marketing_corpus_one_in_flight_url_idx
  on public.marketing_corpus (tenant_id, source_url)
  where source_url is not null and state in ('queued','extracting');
create unique index if not exists marketing_corpus_one_in_flight_path_idx
  on public.marketing_corpus (tenant_id, storage_path)
  where storage_path is not null and state in ('queued','extracting');

alter table public.marketing_corpus enable row level security;
alter table public.marketing_corpus force row level security;
revoke all on public.marketing_corpus from anon, authenticated;
drop policy if exists marketing_corpus_service_role on public.marketing_corpus;
create policy marketing_corpus_service_role on public.marketing_corpus for all to service_role using (true) with check (true);
drop policy if exists marketing_corpus_tenant on public.marketing_corpus;
create policy marketing_corpus_tenant on public.marketing_corpus for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));

-- ─────────────────────────────────────────────────────────── metrics

-- Per-asset per-day performance. `source` is not optional: a number whose
-- provenance is unknown is a number that will eventually be wrong and
-- unfalsifiable. Metrics are recorded, never fabricated.
create table if not exists public.marketing_metric_daily (
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  asset_id       uuid not null,
  date           date not null,

  impressions    bigint,
  reach          bigint,
  views          bigint,
  clicks         bigint,
  saves          bigint,
  shares         bigint,
  comments       bigint,
  likes          bigint,
  spend          numeric(12,2),
  conversions    bigint,
  revenue        numeric(12,2),

  source         text not null,              -- 'meta-api' | 'ig-graph' | 'gsc-api' | 'csv-import' | 'manual'
  captured_at    timestamptz not null default now(),

  primary key (tenant_id, asset_id, date, source),
  constraint marketing_metric_daily_asset_fk
    foreign key (tenant_id, asset_id) references public.marketing_asset (tenant_id, id) on delete cascade
);
create index if not exists idx_marketing_metric_date
  on public.marketing_metric_daily (tenant_id, date desc);

alter table public.marketing_metric_daily enable row level security;
alter table public.marketing_metric_daily force row level security;
revoke all on public.marketing_metric_daily from anon, authenticated;
drop policy if exists marketing_metric_daily_service_role on public.marketing_metric_daily;
create policy marketing_metric_daily_service_role on public.marketing_metric_daily for all to service_role using (true) with check (true);
drop policy if exists marketing_metric_daily_tenant on public.marketing_metric_daily;
create policy marketing_metric_daily_tenant on public.marketing_metric_daily for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));

-- ───────────────────────────────────────────────────────────── events

create table if not exists public.marketing_event (
  id             bigserial primary key,
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  at             timestamptz not null default now(),
  actor          text not null,              -- 'adon' | 'cc' | 'maven-adon' | 'maven-cc' | 'system'
  verb           text not null,
  asset_id       uuid,
  detail         text,
  constraint marketing_event_asset_fk
    foreign key (tenant_id, asset_id) references public.marketing_asset (tenant_id, id) on delete set null
);
create index if not exists idx_marketing_event_at
  on public.marketing_event (tenant_id, at desc);

alter table public.marketing_event enable row level security;
alter table public.marketing_event force row level security;
revoke all on public.marketing_event from anon, authenticated;
drop policy if exists marketing_event_service_role on public.marketing_event;
create policy marketing_event_service_role on public.marketing_event for all to service_role using (true) with check (true);
drop policy if exists marketing_event_tenant on public.marketing_event;
create policy marketing_event_tenant on public.marketing_event for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));

-- pg_trgm powers Phase 4 lexical retrieval over marketing_corpus.search_text.
-- Already relied on elsewhere (find_similar_merchants), so this is a no-op on
-- an existing project and a safety net on a fresh one.
create extension if not exists pg_trgm;
create index if not exists idx_marketing_corpus_search_trgm
  on public.marketing_corpus using gin (search_text gin_trgm_ops);
