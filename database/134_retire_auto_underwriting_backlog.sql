-- Retire the auto-enqueued underwriting backlog. Adon, 2026-08-04.
--
-- WHY THIS EXISTS. Until this release, oasis queued an underwriting run every
-- time a document-complete form step landed (`autoRunUnderwritingForLead`, now
-- deleted). Those rows sit in `application_underwriting` at status='pending'.
-- Removing the producer does not empty the queue, and the underwriting
-- orchestrator cron is still a live consumer — so without this, switching
-- anything on drains the backlog and bills a full bank-statement read per row,
-- for deals nobody asked about. That is the exact spend this change removes.
--
-- SAFE TO RUN, AND SAFE TO RUN TWICE. It only moves rows that are still
-- 'pending' AND were not requested by a person. It never touches a run an
-- operator asked for, never touches one already parsing/complete/error, and
-- never deletes anything. Re-running it is a no-op because the rows are no
-- longer 'pending'.
--
-- WHAT THE OPERATOR SEES AFTERWARDS. status='error' is deliberate: it is the
-- state the UI renders with a Re-run button, so each deal reappears as "needs
-- underwriting" and one click queues a fresh, attributed run. Nothing is lost.

-- ── 1. LOOK FIRST. Run this on its own and read the number. ──────────────
--
--   select count(*) as will_be_retired,
--          min(run_at) as oldest,
--          max(run_at) as newest
--     from public.application_underwriting
--    where status = 'pending'
--      and (triggered_by is distinct from 'manual' and triggered_by is distinct from 'rerun');
--
-- If that count is 0, there is no backlog and nothing below will change a row.

-- ── 2. Retire it. ────────────────────────────────────────────────────────
update public.application_underwriting
   set status = 'error',
       error_message =
         'Queued automatically by an older version of the intake flow, which no longer starts '
         || 'underwriting on its own. Nothing was read and nothing was charged. Press Start '
         || 'underwriting on this lead if you want it graded.',
       run_at = now()
 where status = 'pending'
   and (triggered_by is distinct from 'manual' and triggered_by is distinct from 'rerun');

-- `is distinct from` rather than `<> / not in`: triggered_by is nullable, and a
-- NULL comparison would evaluate to NULL, quietly leaving those rows pending
-- forever — the one shape this migration exists to clear.

-- ── 3. Verify. Expect 0. ─────────────────────────────────────────────────
--
--   select count(*) as still_pending_and_unrequested
--     from public.application_underwriting
--    where status = 'pending'
--      and (triggered_by is distinct from 'manual' and triggered_by is distinct from 'rerun');

-- ── ROLLBACK, if this was applied by mistake ─────────────────────────────
-- The rows are recoverable because the retirement message is unique to them:
--
--   update public.application_underwriting
--      set status = 'pending', error_message = null
--    where status = 'error'
--      and error_message like 'Queued automatically by an older version%';
--
-- Do NOT run the rollback while the orchestrator is live unless you intend to
-- pay for every one of those runs.
