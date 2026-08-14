-- marketing_publish_intent — the operator says "put this on these channels",
-- and something that is allowed to send picks it up.
--
-- WHY A QUEUE AND NOT A DIRECT CALL
-- The Command Center runs on Vercel. The only sanctioned publisher is
-- CMO-Agent/scripts/publishers/base.publish(), which is Python, runs send_gateway
-- first (killswitch, daily caps, audit trail) and needs credentials that live on
-- the operator's machine. Those two cannot call each other.
--
-- The tempting shortcut is for the route to call Zernio's HTTP API itself. That
-- skips the killswitch, the caps and the audit row — the adapter's own docstring
-- calls doing so a bug — and it forks the per-platform knowledge (Instagram video
-- must declare contentType: reel, YouTube needs a <=95-char title) that took real
-- failures to learn. Two publishers drift, and one of them starts shipping broken
-- posts.
--
-- So the app records INTENT and the drainer, which lives where the gateway lives,
-- performs it. The dashboard stays a dashboard; the thing that can send is still
-- the only thing that sends.

create table if not exists public.marketing_publish_intent (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  asset_id      uuid not null,

  -- The channels asked for, as a JSON array of platform keys
  -- ("instagram","tiktok","youtube","twitter","threads","linkedin").
  -- Validated against CMO-Agent schedule_posts.ACCOUNTS by the drainer, which is
  -- the only place that knows which accounts are actually connected.
  platforms     jsonb not null,

  -- queued -> running -> done | failed. `running` exists so a slow publish (a
  -- 10 MB reel to five networks takes over a minute) cannot be picked up twice
  -- by an overlapping drain and posted twice. There is no unsending.
  state         text not null default 'queued'
                  check (state in ('queued','running','done','failed')),

  requested_by  text not null,
  note          text,

  -- What happened, per platform, once the drainer has been. Shaped
  -- {"instagram":{"ok":true,"post_id":"..."}, ...} so a partial success is
  -- legible instead of collapsing to one boolean.
  result        jsonb not null default '{}'::jsonb,
  error         text,

  attempts      int not null default 0,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,

  constraint marketing_publish_intent_asset_fk
    foreign key (tenant_id, asset_id) references public.marketing_asset (tenant_id, id) on delete cascade
);

-- The drainer's only query: oldest queued first.
create index if not exists idx_marketing_publish_intent_queued
  on public.marketing_publish_intent (state, created_at);

-- "has this asset already been sent anywhere" on the detail page.
create index if not exists idx_marketing_publish_intent_asset
  on public.marketing_publish_intent (tenant_id, asset_id, created_at desc);

alter table public.marketing_publish_intent enable row level security;
alter table public.marketing_publish_intent force row level security;
revoke all on public.marketing_publish_intent from anon, authenticated;

drop policy if exists marketing_publish_intent_service_role on public.marketing_publish_intent;
create policy marketing_publish_intent_service_role on public.marketing_publish_intent
  for all to service_role using (true) with check (true);

drop policy if exists marketing_publish_intent_tenant on public.marketing_publish_intent;
create policy marketing_publish_intent_tenant on public.marketing_publish_intent for all
  using (tenant_id in (select tenant_id from public.user_profiles where auth_user_id = auth.uid()));
