-- Retire the auto-enqueued underwriting backlog. Adon, 2026-08-04.
--
-- WHY THIS EXISTS. Until this release, oasis queued an underwriting run every
-- time a document-complete form step landed (`autoRunUnderwritingForLead`, now
-- deleted). Those rows sit in `application_underwriting` at status='pending'.
-- Removing the producer does not empty the queue, and the underwriting
-- orchestrator is still a live consumer — so without this, switching anything on
-- drains the backlog and bills a full bank-statement read per row, for deals
-- nobody asked about. That is the exact spend this change removes.
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
--
-- ══ ORDER MATTERS. STOP THE CONSUMER FIRST. ═════════════════════════════
--
-- The underwriting orchestrator is RUNNING while you read this, and it claims
-- pending rows by moving them to 'parsing'. If it claims one between the
-- snapshot and the update, that row is no longer 'pending', the update skips
-- it, and the statement read is billed anyway — the one outcome this exists to
-- prevent. The window is small and the spend is real, so do not gamble on it.
--
--   1. Turn OFF "SunBiz Underwriting Orchestrator" in the dashboard's
--      scheduled-jobs screen and confirm it reads disabled.
--   2. If the VPS orchestrator loop runs outside that switch, stop it there
--      too. Ask MCC — the VPS is theirs. This is the same stop the cutover
--      needs anyway; see JARVIS docs/UNDERWRITING_CUTOVER.md §0.
--   3. Only then run the steps below, in order.
--
-- Rows already at 'parsing' when you stop it are legitimately mid-run and are
-- left alone on purpose; they finish, or they get reclaimed. This is about the
-- queue, not about work in flight.

-- ── STEP 1. Snapshot, then look. ─────────────────────────────────────────
--
-- The snapshot is what makes the check in step 3 EXACT. Comparing counts before
-- and after cannot work: if baseline in-flight rows finish while the migration
-- runs, their departure masks newly claimed ones (5 finish, 3 get claimed, the
-- count falls and a real race reads as clean). Identity does not have that
-- problem — a row that was 'pending' at snapshot and is 'parsing' afterwards was
-- claimed during the window, whatever else moved.

drop table if exists public.uw_backlog_snapshot;

create table public.uw_backlog_snapshot as
select id,
       status as status_at_snapshot,
       run_at
  from public.application_underwriting
 where status in ('pending', 'parsing')
   and (triggered_by is distinct from 'manual' and triggered_by is distinct from 'rerun');

-- Operational scratch, dropped in step 4. It holds run ids only, no merchant
-- data — but it is locked down anyway rather than leaving the question open.
alter table public.uw_backlog_snapshot enable row level security;
revoke all on public.uw_backlog_snapshot from anon, authenticated;

-- Read the numbers:
--
--   select count(*) filter (where status_at_snapshot = 'pending') as will_be_retired,
--          count(*) filter (where status_at_snapshot = 'parsing') as already_in_flight,
--          min(run_at) as oldest,
--          max(run_at) as newest
--     from public.uw_backlog_snapshot;
--
-- `will_be_retired` = 0 means there is no backlog and step 2 changes nothing.

-- ── STEP 2. Retire it. ───────────────────────────────────────────────────
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

-- ── STEP 3. Verify. BOTH must be 0. ──────────────────────────────────────
--
-- (a) Nothing unrequested is still queued:
--
--   select count(*) as still_pending_and_unrequested
--     from public.application_underwriting
--    where status = 'pending'
--      and (triggered_by is distinct from 'manual' and triggered_by is distinct from 'rerun');
--
-- (b) EVERY row that was pending at snapshot actually got retired. Asked as
--     "does it carry the retirement message", not "is it parsing right now":
--     a row claimed during the window can reach complete or error before you
--     run this, and a status check would then report clean while the read was
--     billed. Outcome-based, so it holds however long you take to check:
--
--   select count(*) as escaped_the_retirement
--     from public.uw_backlog_snapshot s
--     join public.application_underwriting a on a.id = s.id
--    where s.status_at_snapshot = 'pending'
--      and (a.status <> 'error'
--           or coalesce(a.error_message, '') not like 'Queued automatically by an older version%');
--
-- (coalesce because `null not like ...` is NULL, not true — without it a row
--  with no message would slip through the very check meant to catch it.)
--
-- If (b) is non-zero, those rows escaped the update: the consumer was still
-- live and claimed them. Stop it, then list them and decide per row —
--
--   select a.id, a.application_id, a.status, a.run_at
--     from public.uw_backlog_snapshot s
--     join public.application_underwriting a on a.id = s.id
--    where s.status_at_snapshot = 'pending'
--      and (a.status <> 'error'
--           or coalesce(a.error_message, '') not like 'Queued automatically by an older version%');
--
-- — a row now 'complete' was already paid for and is best left alone; one back
-- at 'pending' is cleared by re-running step 2.

-- ── STEP 4. Clean up (only once step 3 reads 0 / 0). ─────────────────────
--
--   drop table public.uw_backlog_snapshot;

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
