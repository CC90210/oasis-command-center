# HANDOFF — OASIS Founders Portal, Marketing Hub

**As of:** 2026-08-03
**Repo:** `CC90210/oasis-command-center` · deploys to Vercel project **`agent-dashboard`** → **oasisai.work**
**Owner:** Adon (operator) · built by APEX/Maven

---

## 1. What this is

A private **Founders Portal** inside the OASIS AI Command Center, at `/founders/marketing`.
It is OASIS's own marketing tooling — not a tenant product, never sold, invisible to SunBiz.

Its stated purpose, in Adon's words:

> "The dashboard is really just going to be putting your full power in a dashboard and really
> making it seem as if I'm able to train you in large quantities that will be automatically
> ingested by you over a reasonable period of time. **That's the majority of what this Marketing
> tab is going to be for.**"

So it is a **training instrument** first, a content dashboard second.

---

## 2. Current state

| Thing | State |
|---|---|
| Phase 1 (gate, schema, library) | **MERGED** to `main`, squash `32543e8` |
| Portal boundaries + chrome | **MERGED** in the same commit |
| Production deploy | **READY**, oasisai.work serving 200 |
| `FOUNDERS_TENANT_IDS` | **SET** to `ef8d389e-3f15-43f2-ae00-3660f69a1452` (CC's tenant) |
| Migration 133 | ✅ **APPLIED to production 2026-08-04.** Verified: 7 tables, RLS enabled + forced, 2 policies each, 0 grants to public roles. See §3 |
| Link ingestion (PR) | ✅ **MERGED** to `main` 2026-08-04, PR #120, squash `aa4dbb5` |
| Extraction worker | ❌ not built |
| Inspiration → ad generation | ❌ not built |
| Studio/Library visual upgrade | ❌ not built |

**Access:** log in at oasisai.work as `conaugh@oasisai.work`. A "Founders" group appears in the
sidebar with a Marketing tab.

⚠️ **There is no user profile for Adon.** All 41 profiles were searched for `adon` / `echelonx`;
only `conaugh@oasisai.work` exists on the founders tenant. Either log in as CC, or create a
profile on tenant `ef8d389e-…` and widen the allowlist.

---

## 3. ✅ RESOLVED — migration 133 is applied

**Applied 2026-08-04 by APEX**, not by hand. Verification output is at the end of this section.

Until it ran, nothing persisted: every reader degraded to an empty state, so the UI worked but
stored nothing, and the ingest API returned `503 migration_pending`.

**How to apply this or any future migration — do not paste into a dashboard:**

```
python scripts/apply_migration.py <repo>/database/<n>_<name>.sql \
  --project bravo --allow-privileges --allow-rls
```

from the **JARVIS repo, regular PowerShell**. It uses the Management API token in `.env.agents`.
`--allow-privileges` is required for the standard `revoke all ... from anon, authenticated` ritual;
it does **not** unlock irreversible verbs or any `grant ... to anon/authenticated/public`, both of
which the wrapper refuses under every flag.

**Target project:** **`phctllmtsogkovoilwos`** (the one containing `tenants`, `user_profiles`,
`drip_runs`, `funded_deals`).

The SQL below is kept for reference; the file of record is `database/133_marketing_hub.sql`.

Idempotent, additive, re-runnable. Touches nothing existing.

```sql
-- 133_marketing_hub.sql — Founders Portal Marketing Hub

create table if not exists public.marketing_asset (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  title          text not null,
  channel        text not null
                   check (channel in (
                     'organic-instagram','organic-facebook','organic-tiktok',
                     'organic-youtube','paid-meta','paid-google',
                     'seo-article','seo-landing','email')),
  -- GENERATED so track can never desync from channel.
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
  aspect         text,
  status         text not null default 'draft'
                   check (status in ('draft','in_review','approved','scheduled',
                                     'published','rejected','archived')),
  hook           text,
  body           text,
  cta            text,
  landing_url    text,
  campaign       text,
  duration_s     numeric(10,2),
  author_agent   text not null default 'human',
  source         text,
  scheduled_for  timestamptz,
  published_at   timestamptz,
  external_id    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  meta           jsonb not null default '{}'::jsonb,
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

create table if not exists public.marketing_asset_media (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  asset_id       uuid not null,
  kind           text not null
                   check (kind in ('video','poster','preview','thumb','audio','html','source','caption')),
  storage_bucket text not null default 'marketing-media',
  storage_path   text not null,
  mime           text,
  bytes          bigint,
  width          int,
  height         int,
  label          text,
  created_at     timestamptz not null default now(),
  unique (tenant_id, storage_bucket, storage_path),
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

create table if not exists public.marketing_review (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  asset_id       uuid not null,
  decision       text not null
                   check (decision in ('approve','approve_with_changes','request_changes','reject','comment')),
  note           text,
  reviewer       text not null default 'adon',
  reviewer_agent text,
  created_at     timestamptz not null default now(),
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
  claimed_by     text,
  response       text,
  created_at     timestamptz not null default now(),
  claimed_at     timestamptz,
  done_at        timestamptz,
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

create table if not exists public.marketing_corpus (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  kind           text not null
                   check (kind in ('media','link','metrics','lesson','verdict')),
  label          text not null default 'exemplar'
                   check (label in ('exemplar','counter_example','neutral')),
  title          text,
  source_url     text,
  storage_bucket text,
  storage_path   text,
  asset_id       uuid,
  transcript     text,
  extraction     jsonb not null default '{}'::jsonb,
  search_text    text,
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
  source         text not null,
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

create table if not exists public.marketing_event (
  id             bigserial primary key,
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  at             timestamptz not null default now(),
  actor          text not null,
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

create extension if not exists pg_trgm;
create index if not exists idx_marketing_corpus_search_trgm
  on public.marketing_corpus using gin (search_text gin_trgm_ops);
```

### Verify it worked

```sql
select table_name,
       (select count(*) from information_schema.columns c
         where c.table_schema='public' and c.table_name=t.table_name) as cols,
       (select relrowsecurity from pg_class where relname=t.table_name) as rls_on
from information_schema.tables t
where table_schema='public' and table_name like 'marketing_%'
order by table_name;
```

Expect **7 rows, all `rls_on = true`**: `marketing_asset` (22 cols), `marketing_asset_media` (12),
`marketing_corpus` (19), `marketing_event` (7), `marketing_metric_daily` (16),
`marketing_request` (15), `marketing_review` (9).

> These counts were 23/18/14/8 in an earlier revision of this doc, written before the CodeRabbit
> fix `1687ef0` reshaped the schema. **The counts above are the ones actually observed in
> production on 2026-08-04** and they match the migration file. If you hit the old numbers
> somewhere, the doc is stale, not the schema.

`rls_on = true` alone is a weak check — a table can have RLS enabled and still be readable
through a stray grant. The stronger query, which is what was actually run:

```sql
select c.relname as tbl,
       c.relrowsecurity as rls_on,
       c.relforcerowsecurity as rls_forced,
       (select count(*) from pg_policies p
          where p.schemaname='public' and p.tablename=c.relname) as policies,
       (select count(*) from information_schema.role_table_grants g
          where g.table_schema='public' and g.table_name=c.relname
            and g.grantee in ('anon','authenticated','PUBLIC')) as public_grants
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r' and c.relname like 'marketing\_%'
order by 1;
```

Expect all 7 rows: `rls_on=t`, `rls_forced=t`, `policies=2`, **`public_grants=0`**.

If `create extension pg_trgm` errors on permissions, **skip that one line** — it is almost
certainly already enabled (`find_similar_merchants` uses it). Everything else still applies.

---

## 4. Architecture decisions that must not be undone

**The founders gate keys on TENANT IDENTITY, never on role.**
`isAdmin` derives from `is_owner || team_role in ('admin','owner')`, and those flags are
**per-tenant** — SunBiz has its own owners. Gating on role would show the portal to every SunBiz
admin. The gate is an exact-UUID env allowlist (`FOUNDERS_TENANT_IDS`), empty-by-default, returning
**404 not 403** so a stranger never learns the route exists.
Code: `lib/founders-marketing-core.ts` (`isFounderTenant`), `lib/founders/gate.ts`.

**Why exact UUIDs and not a name/slug match:** the DB has **38 tenants and ~36 are named
"OASIS AI"** — they are public signups inheriting the default seed. Name matching would have
exposed the founders portal to ~36 strangers.

**The nav tab must not render in another tenant's shell.**
`app/layout.tsx` resolves the shell from `pathOverrideSlug ?? tenantProfileSlug`, so a founder
browsing `/t/sun/...` sees the SunBiz sidebar. `shouldShowFoundersNav()` adds an own-shell-only
condition. Without it, a Founders tab paints onto SunBiz's portal — no data leak, but it
advertises the portal exists.

**Portal boundaries are enforced, not conventional.**
`lib/portals/registry.ts` declares 3 portals + shared infra and what each owns.
`tests/portal-boundaries.test.ts` scans the whole tree and fails the build on a cross-portal
import (923 files, 2051 imports, 0 violations). See `docs/PORTALS.md`.

**`lib/portals/stage-hooks.ts` is a composition root.** It is the only file allowed to import
across portals, because something has to wire them. It uses a **static import list, not a
self-registering hook** — Next builds a module graph per route, so a handler nothing statically
imports is silently absent from that bundle, and the failure mode is merchants texted after they
convert.

**Two different things are called "marketing":**
| Path | Owner | What |
|---|---|---|
| `lib/marketing/`, `app/(marketing)/` | oasis | the PUBLIC website (`/home`, `/work`, `/fleet`) |
| `lib/founders-*`, `app/founders/marketing/` | founders | the private internal studio |

---

## 5. What is built

**Merged (`32543e8`):**
- `/founders/marketing` (Studio) and `/founders/marketing/library`
- `app/founders/layout.tsx` — portal chrome in OASIS cyan `#1FE3F0` (the CRM uses platform blue)
- Founders gate + 28 assertions
- `database/133_marketing_hub.sql` — 7 tables, composite tenant-scoped FKs, generated `track`
- Portal registry + boundary enforcement + `docs/PORTALS.md`

**Pushed, PR not yet opened — branch `apex/founders-marketing-v2`:**
- `lib/founders/ingest-core.ts` — pure link classifier: YouTube (watch/shorts/youtu.be/embed/m.),
  Instagram (reel/p/tv, `/<user>/reel/<code>`, bare profiles), TikTok (incl. unresolvable `vm.`
  short links), GitHub (deep links collapse to the repo), any article. Canonicalises, strips 20
  tracking params. Refuses `javascript:`/`data:`/`file:`/`ftp:` and single-label hosts (SSRF).
- `app/api/founders/marketing/ingest/route.ts` — founders-gated, parses and enqueues only.
  Returns `503 migration_pending` with what *would* have queued while §3 is outstanding.
- `components/founders/TrainDropzone.tsx` — drag/paste with a client-side preview of what each
  link is and what will be extracted, **before** committing.
- `app/founders/marketing/train/page.tsx`

**Gates on that branch:** `tsc` clean · `eslint` 0 errors · `test:sunbiz` **41 files pass** ·
`next build` exit 0.

---

## 6. Not built

1. **The extraction worker.** Links queue and sit. Nothing pulls a transcript or reads a repo.
   Needs `queueInfer` (`lib/bridge-infer.ts:73` — runs on the Max subscription, zero API cost)
   plus the APEX daemon. Follow the `database/104_document_extraction_jobs.sql` pattern: file in
   Storage → job row → daemon downloads → HMAC POST back to `/api/internal/...`.
2. **Inspiration → ad generation.** The classifier already marks reels/videos `inspirable: true`;
   nothing consumes it yet.
3. **Studio + Library visual upgrade.** Adon asked for "a lot nicer"; only the new Train screen
   was built.
4. **Instagram-first scoping** of the channel UI.

---

## 7. Honest limits — do not overstate these

- **No organic performance metrics exist anywhere in this repo** for Instagram, Facebook or
  TikTok. The hub shows what was *produced*, never how it performed. Never fabricate numbers.
- **Paid metrics are CSV-ingest only.** Meta API ingest is not built.
- **Retrieval is LEXICAL (pg_trgm), not vector.** There is no pgvector, and `claude -p` cannot
  emit embeddings, so the subscription seam does not cover embedding generation.
- **Gated, multi-week external queues if publishing expands:** Google Ads Basic Access, and the
  TikTok Content Posting audit (until it passes, every auto-posted TikTok is forced **private**).
  Instagram is the only channel where reading insights AND publishing both work today, ungated.
- **Unverified in production:** the `lib/manifest/data.ts` drip refactor shipped in `32543e8`.
  Behaviour is unit-pinned and byte-identical by inspection, but never exercised against live
  Supabase. If it regressed, the symptom is merchants texted after they convert. The check:
  move a test lead's stage, confirm its scheduled `drip_runs` go to `cancelled`.

---

## 8. Working rules for this repo

- Product repo with paying users. Evidence before claims; no proof, not done.
- Gates: `npm run typecheck` · `npm run lint` · `npm run test:sunbiz`.
  (`CLAUDE.md` says `npm test` — there is no such script.)
- **Every `getServiceSupabase()` query must manually `.eq("tenant_id", …)`** — service role
  bypasses RLS. A missing filter is a cross-tenant leak; the reviewer greps for it.
- **Commit email must be `214530671+CC90210@users.noreply.github.com`** or Vercel silently blocks
  the deploy.
- Auto-deploys on push to `main`. PR-first; Adon merges.
- **Never build in the `oasis-command-center` main checkout** — it carries other sessions'
  uncommitted work. Use a worktree off `origin/main`, branch `apex/<topic>`.
- Cross-session ledger: `~/.claude/projects/c--Users-echel-JARVIS/memory/ACTIVE_WORK.md`.

---

## 9. Immediate next steps

1. **Apply §3.** Nothing persists until then.
2. Log in as `conaugh@oasisai.work` at oasisai.work → Founders → Marketing.
3. Drop a link into Train and confirm it queues.
4. Open the PR on `apex/founders-marketing-v2` and merge.
5. Then: extraction worker → inspiration→ad → UI upgrade.
