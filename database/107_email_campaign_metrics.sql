-- 107_email_campaign_metrics.sql — email-blast support on the shared campaign
-- tables (migration 105). Additive; RLS is inherited from 105.
--
-- campaign_runs gains a `channel` (so Constant Contact blasts are distinguishable
-- from TextTorrent SMS) and `provider_activity_id` (the CC campaign_activity_id the
-- metrics collector polls). campaign_metric_snapshots gains the email-specific
-- counters the collector writes.

alter table public.campaign_runs add column if not exists channel text default 'texttorrent';
alter table public.campaign_runs add column if not exists provider_activity_id text;

alter table public.campaign_metric_snapshots add column if not exists opens int;
alter table public.campaign_metric_snapshots add column if not exists unique_opens int;
alter table public.campaign_metric_snapshots add column if not exists open_rate numeric;
alter table public.campaign_metric_snapshots add column if not exists clicks int;
alter table public.campaign_metric_snapshots add column if not exists click_rate numeric;
alter table public.campaign_metric_snapshots add column if not exists bounces int;
alter table public.campaign_metric_snapshots add column if not exists bounce_rate numeric;
alter table public.campaign_metric_snapshots add column if not exists optouts int;
alter table public.campaign_metric_snapshots add column if not exists complaints int;

create index if not exists idx_campaign_runs_channel on public.campaign_runs (tenant_id, channel, launched_at desc);
