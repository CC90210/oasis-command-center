-- 116_drip_runs_claimed_at.sql — add a claim-time column so the dispatch
-- stale-'sending' reclaim keys on HOW LONG A ROW HAS BEEN CLAIMED, not on
-- scheduled_for.
--
-- Bug this fixes (audit H3): the reclaim in lib/drips/executor.ts was
--   UPDATE ... SET status='scheduled' WHERE status='sending' AND scheduled_for < now()-15min
-- With no claim-time column, a row claimed SECONDS ago but whose scheduled_for
-- is >15 min in the past (normal whenever dispatch is backed up, after a
-- quiet-hours reschedule, or on a busy stage) is immediately eligible for
-- reclaim — so an overlapping dispatch invocation flips it back to 'scheduled'
-- out from under an in-flight send and sends it AGAIN. The CAS claim protects
-- against two claimers of the same 'scheduled' row, but not against the reclaim
-- resurrecting a row that is actively sending.
--
-- Fix: stamp claimed_at = now() at claim time; reclaim only rows whose
-- claimed_at is older than STALE_SENDING_MINUTES. A genuine crash-mid-send
-- still recovers (claimed_at ages out), but a fresh claim is never reclaimed.
--
-- Additive + idempotent. RLS is inherited from 115 (unchanged).

alter table public.drip_runs
  add column if not exists claimed_at timestamptz;

-- Reclaim scans 'sending' rows by claim age; a partial index keeps it cheap
-- (almost every row is terminal, only a handful are ever 'sending').
create index if not exists idx_drip_runs_sending_claimed
  on public.drip_runs (claimed_at)
  where status = 'sending';

-- Backfill any row that was already 'sending' at migration time: without a
-- claimed_at, `claimed_at < now()-15min` never matches NULL, so a genuinely
-- stuck 'sending' row would never be reclaimed — a silent permanent stall
-- against this repo's own no-silent-failure doctrine (review MED-1). Stamp it
-- now so the reclaim can recover it after the stale window.
update public.drip_runs set claimed_at = now()
  where status = 'sending' and claimed_at is null;
