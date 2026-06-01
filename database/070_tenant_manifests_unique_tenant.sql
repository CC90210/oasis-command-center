-- ============================================================================
-- Migration 070 — UNIQUE(tenant_id) on tenant_manifests
--
-- The POST /api/tenant/agents/toggle route uses upsert with
-- onConflict='tenant_id' to mutate the workspace's manifest. Without
-- a UNIQUE constraint that upsert errors with "no unique or exclusion
-- constraint matching the ON CONFLICT specification" -- the entire
-- agent-marketplace flow would crash at the first toggle.
--
-- Verified there are no duplicate tenant_id rows in the table before
-- adding the constraint (one row total today). The constraint also
-- prevents future code from accidentally inserting a second manifest
-- row per tenant -- the model is strictly one-to-one.
--
-- Idempotent (the `IF NOT EXISTS`-equivalent guard via DO block).
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'tenant_manifests_tenant_id_key'
       AND conrelid = 'public.tenant_manifests'::regclass
  ) THEN
    ALTER TABLE public.tenant_manifests
      ADD CONSTRAINT tenant_manifests_tenant_id_key UNIQUE (tenant_id);
  END IF;
END $$;
