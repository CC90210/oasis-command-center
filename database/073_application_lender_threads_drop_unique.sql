-- ============================================================================
-- Migration 073 — application_lender_threads: drop the (application_id,
-- lender_id) UNIQUE constraint so operators can re-shop the same lender
-- as many times as they want
--
-- The original constraint (migration 044 in SunBiz-Agent) stated:
--   UNIQUE (application_id, lender_id)
-- with the rationale "One thread per (application, lender) pair. Re-shop
-- creates a new application row (operator's choice) — we don't want to
-- re-pollute an existing thread with a second outreach."
--
-- That assumption broke CC's workflow on 2026-06-10: the operator wants
-- to fire multiple shop-outs to the same lender on the same application
-- (re-shop after a few days, follow-up with new context, testing) without
-- spinning up a duplicate application row. The constraint was making the
-- second click on "Send to N lenders" fail silently with a UNIQUE
-- violation — the dashboard UI showed "send once" as the observable
-- limit.
--
-- Removing the constraint allows N rows per (application, lender) pair.
-- Each row tracks its own outbound message (gmail_thread_id,
-- last_message_id, message_id_history, status). The reply classifier
-- daemon (migration 044 originally targeted) still works because it
-- updates by row id, not by (application, lender).
--
-- For consistent lookup performance, replace the unique constraint
-- with a plain index — same column set, same query plan, no uniqueness
-- enforcement.
--
-- Idempotent. Re-runnable.
-- ============================================================================

-- Drop the named UNIQUE constraint. Postgres auto-named it
-- <table>_<columns>_key per its standard convention.
ALTER TABLE public.application_lender_threads
    DROP CONSTRAINT IF EXISTS application_lender_threads_application_id_lender_id_key;

-- Same column set, kept as a plain index for the operator UI's
-- "show me every thread for this application + lender" lookups.
CREATE INDEX IF NOT EXISTS idx_lender_threads_application_lender
    ON public.application_lender_threads (application_id, lender_id, created_at DESC);

COMMENT ON INDEX public.idx_lender_threads_application_lender IS
  'Lookup index — replaces the dropped UNIQUE constraint. Multiple rows '
  'per (application, lender) are now permitted so operators can re-shop '
  'a lender without spinning a duplicate application row.';
