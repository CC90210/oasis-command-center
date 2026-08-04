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

-- ══ ORDER MATTERS. STOP THE CONSUMER FIRST. ═════════════════════════════
--
-- The underwriting orchestrator is RUNNING while you read this, and it claims
-- pending rows by moving them to 'parsing'. If it claims one between step 1 and
-- step 2 below, that row is no longer 'pending', this update skips it, and the
-- statement read is billed anyway — the one outcome the migration exists to
-- prevent. The window is small and the spend is real, so do not gamble on it.
--
-- Before running anything below:
--
--   1. Turn OFF "SunBiz Underwriting Orchestrator" in the dashboard's
--      scheduled-jobs screen (the same switch the Cron tab exposes), and
--      confirm it reads disabled.
--   2. If the VPS orchestrator loop is running outside that switch, stop it
--      there too. Ask MCC — the VPS is theirs. See JARVIS
--      docs/UNDERWRITING_CUTOVER.md §0, which has to be resolved for the
--      cutover regardless; this is the same stop.
--   3. Only then run steps 1-3 here, and re-check step 3 before turning
--      anything back on.
--
-- Rows already at 'parsing' when you stop it are legitimately mid-run and are
-- deliberately left alone; they finish or they get reclaimed. This migration is
-- about the queue, not about work in flight.
--
-- ── 1. LOOK FIRST. Run this on its own and WRITE DOWN both numbers. ──────
--
--   select
--     count(*) filter (where status = 'pending') as will_be_retired,
--     count(*) filter (where status = 'parsing') as already_in_flight,
--     min(run_at) filter (where status = 'pending') as oldest,
--     max(run_at) filter (where status = 'pending') as newest
--   from public.application_underwriting
--   where status in ('pending','parsing')
--     and (triggered_by is distinct from 'manual' and triggered_by is distinct from 'rerun');
--
-- `will_be_retired` = 0 means there is no backlog and nothing below changes a
-- row. `already_in_flight` is the BASELINE for step 3 — those rows are
-- legitimately mid-parse and are left alone on purpose, so the check afterwards
-- compares against this number rather than expecting zero.

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

-- ── 3. Verify. Expect 0 for BOTH. ────────────────────────────────────────
--
--   select count(*) as still_pending_and_unrequested
--     from public.application_underwriting
--    where status = 'pending'
--      and (triggered_by is distinct from 'manual' and triggered_by is distinct from 'rerun');
--
-- And check nothing was claimed out from under the update while it ran. Compare
-- this against the `already_in_flight` number you wrote down in step 1 — NOT
-- against zero. Rows that were mid-parse before you started are expected and
-- are deliberately preserved; only an INCREASE means the consumer was still
-- live and is billing right now. If it went up: stop the consumer, let those
-- rows settle, then re-run step 2.
--
--   select count(*) as unrequested_in_flight_now
--     from public.application_underwriting
--    where status = 'parsing'
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
