-- 173_scheduled_sends_claimed_at.sql
--
-- A scheduled send needs a worker-claim clock that is distinct from the time
-- it was due. Using scheduled_for for stale recovery lets an overlapping cron
-- reclaim a newly claimed overdue row while its first provider call is still
-- running, which can deliver the same message twice.

alter table public.scheduled_sends
  add column if not exists claimed_at timestamptz;

create index if not exists idx_scheduled_sends_status_channel_claimed
  on public.scheduled_sends (status, channel, claimed_at);

-- Existing in-flight rows get a fresh lease. If they are genuinely abandoned,
-- the dispatcher will classify them after the normal stale window; it must not
-- assume they are old merely because their scheduled time is old.
update public.scheduled_sends
   set claimed_at = now()
 where status = 'sending'
   and claimed_at is null;
