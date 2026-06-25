-- 104_cold_outreach_sender_identity.sql
-- Per-rep Text Torrent blaster (2026-06-25): stamp the SENDER identity on each
-- cold-outreach campaign so the JARVIS drain worker (apex-rep-blaster) sends
-- every message AS that rep — acting-as the rep's own TextTorrent sub-account
-- (X-ACT-AS-USER), from the rep's own number. Without these, a sms_texttorrent
-- campaign has no per-rep identity and could only fall back to the tenant
-- owner's account, which defeats per-rep blasting for the team.
--
-- Additive + idempotent. cold_outreach_campaigns already carries tenant RLS;
-- these columns inherit the existing policy (no new table, no policy change).
-- The values are IDENTIFIERS only (a phone number + an account email), NOT
-- secrets — the TextTorrent master API key never leaves the worker. The worker
-- writes back per-campaign progress (sent_count/failed_count/status) and
-- per-recipient status to the columns cold_outreach_recipients already has
-- (status / sent_at / last_error), so no recipient-table change is needed.

alter table public.cold_outreach_campaigns
  add column if not exists sender_user_id      uuid,     -- the rep this blast sends AS (user_profiles.auth_user_id)
  add column if not exists sender_from_number  text,     -- the rep's own TT sending DID (E.164)
  add column if not exists sender_act_as_email text,     -- the rep's TT sub-account email (X-ACT-AS-USER, plain)
  add column if not exists sender_daily_limit  integer,  -- the rep's TT sub-account daily_sms_limit (optional ceiling)
  add column if not exists last_error          text;     -- worker-set reason a campaign was marked failed

comment on column public.cold_outreach_campaigns.sender_act_as_email is
  'TextTorrent sub-account email (X-ACT-AS-USER) the blaster acts-as — the rep''s own account, NOT a secret.';
comment on column public.cold_outreach_campaigns.sender_from_number is
  'The rep''s own TextTorrent sending number (E.164). Inbound replies thread back to this rep via the SMS webhook.';

-- Recipients can now come from sources OTHER than a cold_lead_list (a rep's
-- assigned pipeline leads, or an uploaded/pasted list). Those have no
-- cold_leads row, so cold_lead_id must be nullable. (No-op if already nullable.)
alter table public.cold_outreach_recipients
  alter column cold_lead_id drop not null;
