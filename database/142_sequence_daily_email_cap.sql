-- 142_sequence_daily_email_cap.sql
--
-- A per-sequence daily EMAIL cap, settable from the Drips tab.
--
-- Adon, 2026-08-11: "we need to be able to have a feature that's visual on how
-- many email drips are being sent out per sequence daily. You're able to see
-- that and change that from the SunBiz software."
--
-- WHAT EXISTED. governor.ts enforces per-BRAND daily/hourly ceilings and a
-- per-LEAD weekly cap, all from environment variables. Between "the whole
-- domain may send 150 today" and "this one merchant may get 2 this week" there
-- was nothing: one sequence could consume the entire brand allowance before
-- another sent a single email, and no operator could see it happen or stop it
-- without an env change and a deploy.
--
-- NULL MEANS NO CAP, and that is the default, so this migration changes the
-- behaviour of exactly nothing until someone sets a number. The brand ceilings
-- keep applying either way; this only ever makes a sequence send LESS.
--
-- ZERO IS A REAL VALUE distinct from NULL: "send nothing from this sequence",
-- a pause that does not disable the sequence and does not lose its enrolments.
-- The CHECK permits it deliberately.
--
-- No RLS clause here: drip_sequences already has RLS enabled with its
-- service-role policy from migration 043. Adding a column does not change that,
-- and re-declaring it would be noise. (This table holds sequence definitions,
-- not PII.)

alter table public.drip_sequences
  add column if not exists daily_email_cap integer;

-- 2000 is a typo guard, not a safety limit -- the brand ceiling is the safety
-- limit. Mirrors MAX_SEQUENCE_DAILY_CAP in lib/drips/sequence-volume-core.ts;
-- if you change one, change both.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'drip_sequences_daily_email_cap_sane'
  ) then
    alter table public.drip_sequences
      add constraint drip_sequences_daily_email_cap_sane
      check (daily_email_cap is null or (daily_email_cap >= 0 and daily_email_cap <= 2000));
  end if;
end $$;

comment on column public.drip_sequences.daily_email_cap is
  'Max drip emails this sequence may send per CALENDAR day in the operator timezone. '
  'NULL = uncapped (default). 0 = send nothing, without disabling the sequence. '
  'Counted from lead_interactions, the same source governor.ts enforces the brand caps against.';

-- Volume is attributed by metadata.sequence_id, which the email send path
-- already stamps (executor.ts) -- so nothing about sending changes here.
-- agent_source is 'sequence:<name>' and a name is editable, so keying on it
-- alone would mean a rename silently resets the day to zero. The name remains
-- the fallback for older rows. The id lives in metadata rather than a column
-- because lead_interactions is a shared audit table across every channel.
--
-- This index serves the per-sequence daily count.
create index if not exists lead_interactions_sequence_volume_idx
  on public.lead_interactions (created_at desc)
  where type = 'email_sent' and direction = 'outbound' and agent_source like 'sequence:%';
