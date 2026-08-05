-- 134_marketing_asset_brands.sql — make the founders Marketing Library multi-brand.
-- OASIS is the operating company, but the library also holds work produced for
-- portfolio brands and clients. Campaign is not a brand identifier: campaigns
-- change, while brand attribution must remain stable for training and metrics.

alter table public.marketing_asset
  add column if not exists brand_slug text not null default 'oasis-ai',
  add column if not exists brand_name text not null default 'OASIS AI';

alter table public.marketing_asset
  drop constraint if exists marketing_asset_brand_slug_valid;
alter table public.marketing_asset
  add constraint marketing_asset_brand_slug_valid
  check (brand_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');

create index if not exists idx_marketing_asset_tenant_brand_created
  on public.marketing_asset (tenant_id, brand_slug, created_at desc);

-- A source key identifies one produced asset. Application checks provide the
-- friendly response; this index closes the concurrent-agent race.
create unique index if not exists marketing_asset_tenant_source_unique_idx
  on public.marketing_asset (tenant_id, source)
  where source is not null;
