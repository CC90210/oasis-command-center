-- ============================================================================
-- Migration 093 — Kixie call-lifecycle columns + idempotency index on
--                 lead_interactions
--
-- WHY: app/api/webhooks/kixie/route.ts upserts call events with
--   .upsert(patch, { onConflict: "kixie_call_id" })
-- and reads/writes recording_url, transcript_url, disposition, call_outcome,
-- call_duration_sec, kixie_call_id. The handler's header references "migration
-- 093" but no such migration existed in the repo — so on a fresh DB every call
-- webhook errors (unknown column / no matching ON CONFLICT target). Combined
-- with the handler returning 200 on DB error, every Kixie call event was being
-- SILENTLY DROPPED. This migration backs that contract.
--
-- IDEMPOTENCY INDEX CHOICE: a PLAIN (non-partial) unique index on the nullable
-- kixie_call_id column is deliberate and correct:
--   * Postgres treats NULLs as DISTINCT, so SMS/email rows (kixie_call_id IS
--     NULL) are unconstrained — unlimited NULLs allowed.
--   * Call-lifecycle events sharing one kixie_call_id collapse into one row.
--   * PostgREST `onConflict` CANNOT reliably target a PARTIAL unique index
--     (the codebase hit this before — see app/api/auth/pair/route.ts). A plain
--     unique index IS targetable. Do not "optimize" this into a partial index.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS.
-- Safe to apply whether or not the columns were added out-of-band already.
--
-- VERIFY AFTER APPLY (the handler is dead until this is true in live Supabase):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='lead_interactions'
--      AND column_name IN ('recording_url','transcript_url','disposition',
--                          'call_outcome','call_duration_sec','kixie_call_id');
--   SELECT indexname FROM pg_indexes
--    WHERE tablename='lead_interactions'
--      AND indexname='ux_lead_interactions_kixie_call_id';
-- ============================================================================

ALTER TABLE public.lead_interactions
  ADD COLUMN IF NOT EXISTS recording_url     text,
  ADD COLUMN IF NOT EXISTS transcript_url    text,
  ADD COLUMN IF NOT EXISTS disposition       text,
  ADD COLUMN IF NOT EXISTS call_outcome      text,
  ADD COLUMN IF NOT EXISTS call_duration_sec integer,
  ADD COLUMN IF NOT EXISTS kixie_call_id     text;

CREATE UNIQUE INDEX IF NOT EXISTS ux_lead_interactions_kixie_call_id
  ON public.lead_interactions (kixie_call_id);
