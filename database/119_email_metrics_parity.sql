-- 119_email_metrics_parity.sql — bring the metrics layer to Constant Contact
-- parity + seed the Part B email-classification column.
--
-- (1) campaign_metric_snapshots: CC reports unique_clicks + a complaint_rate the
--     collector never captured. Add both so the Metrics tab's Constant Contact
--     source shows the same numbers CC does. Additive; table already has RLS
--     (mig 105/107).
-- (2) drip_sequences.email_class: 'transactional' | 'commercial' — drives whether
--     a sequence's email carries a visible unsubscribe footer (Part B). Default
--     'commercial' (opt-out shown) so nothing loses an opt-out until a sequence
--     is deliberately reclassified transactional.
-- Idempotent.

alter table public.campaign_metric_snapshots add column if not exists unique_clicks integer;
alter table public.campaign_metric_snapshots add column if not exists complaint_rate numeric(6,4);

alter table public.drip_sequences add column if not exists email_class text not null default 'commercial'
  check (email_class in ('transactional', 'commercial'));
