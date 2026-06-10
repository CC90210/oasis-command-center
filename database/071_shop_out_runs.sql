-- ============================================================================
-- Migration 071 — shop_out_runs (per-fire audit table)
--
-- Adon's shop-out spec section 5 (2026-06-10). One row per operator-fired
-- shop-out run. The row tracks who fired it, which agents got CC'd, which
-- funders were targeted, and the per-funder send results. Append-only
-- once the run reaches a terminal status (completed / failed) so the
-- audit ledger can't be silently rewritten.
--
-- Distinct from existing application_lender_threads (migration 044 in
-- SunBiz-Agent) which tracks the LIVING per-(application, lender) state
-- the response classifier daemon updates. shop_out_runs is FROZEN history.
--
-- Distinct from shopping_threads (migration 088 here) which is the
-- legacy round-level References-anchor approach. Adon's flow uses
-- per-(application, lender) Gmail threading instead (one Gmail thread
-- per lender per deal), so shopping_threads is NOT extended here.
--
-- Idempotent. Re-runnable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.shop_out_runs (
    run_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    -- Application is a tenant_records row (entity_type='application');
    -- stored as text (no FK) since tenant_records is JSONB wide-row.
    application_id   text NOT NULL,
    -- Denormalized for the audit trail UI so renderers don't have to
    -- join tenant_records to display "shop-out for X" headers.
    merchant_name    text NOT NULL,
    -- Who clicked Send in the confirm modal. Email or full_name string
    -- depending on what the session resolves — kept loose so the audit
    -- never silently drops a value because a column constraint rejected it.
    initiated_by     text NOT NULL,
    -- "Jordan" / "SunBiz Submissions" — derived from the final CC list
    -- per Adon spec 2.4 (one agent ⇒ that agent signs; zero/multiple ⇒
    -- shared identity).
    signer_label     text NOT NULL,
    -- The post-checkbox CC list (operator may have unchecked entries
    -- from the derived list). Order is preserved so the audit shows
    -- exactly what shipped.
    agent_ccs        text[] NOT NULL DEFAULT '{}',
    -- Lender ids in the order the operator targeted them.
    funders_targeted text[] NOT NULL,
    -- Per-funder send result. Shape per Adon spec section 5:
    --   {
    --     "funder": "...",
    --     "lender_id": "...",
    --     "status": "sent" | "failed" | "dry_run",
    --     "gmail_thread_id": "...",
    --     "gmail_message_id": "...",
    --     "rfc822_message_id": "<...@mail.gmail.com>",
    --     "cc_emails": [...],
    --     "error": "..." | null,
    --     "ts": "<iso8601>"
    --   }
    -- Frozen once status transitions to completed or failed (trigger
    -- below). The dispatch loop appends entries as funders complete; a
    -- partial failure halts the loop and writes status='failed' with the
    -- successful entries preserved.
    results          jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Lifecycle:
    --   in_progress — dispatch loop is appending to results
    --   completed   — every targeted funder reached a terminal entry
    --   failed      — loop halted early (connection drop, missing fields
    --                 caught mid-flight, etc.). results[] still carries
    --                 whatever shipped before the halt.
    status           text NOT NULL DEFAULT 'in_progress'
                     CHECK (status IN ('in_progress','completed','failed')),
    initiated_at     timestamptz NOT NULL DEFAULT now(),
    completed_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_shop_out_runs_application
    ON public.shop_out_runs (application_id, initiated_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_out_runs_tenant
    ON public.shop_out_runs (tenant_id, initiated_at DESC);

-- Append-only trigger: once a row reaches terminal status (completed or
-- failed) results[] cannot be mutated. Catches malicious rewrites and
-- accidental partial-result truncation. Status itself can transition
-- (in_progress → completed/failed) once, but results cannot diverge after.
CREATE OR REPLACE FUNCTION public.shop_out_runs_results_append_only()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IN ('completed', 'failed')
       AND OLD.results IS DISTINCT FROM NEW.results THEN
        RAISE EXCEPTION
            'shop_out_runs.results is append-only after terminal status';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_shop_out_runs_results_append_only ON public.shop_out_runs;
CREATE TRIGGER trg_shop_out_runs_results_append_only
    BEFORE UPDATE ON public.shop_out_runs
    FOR EACH ROW EXECUTE FUNCTION public.shop_out_runs_results_append_only();

ALTER TABLE public.shop_out_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY shop_out_runs_tenant_all ON public.shop_out_runs
    FOR ALL USING (
        tenant_id IN (
            SELECT tenant_id FROM public.user_profiles
            WHERE auth_user_id = auth.uid()
        )
    );

COMMENT ON TABLE public.shop_out_runs IS
  'Per-fire audit log of shop-out runs (Adon spec 2026-06-10). One row '
  'per operator click on Send in the confirm modal. results[] is '
  'append-only after status reaches terminal (completed/failed) to '
  'prevent silent rewrites of historical sends.';
