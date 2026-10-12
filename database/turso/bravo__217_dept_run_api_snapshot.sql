-- bravo__217_dept_run_api_snapshot.sql
--
-- Freeze the hosted account identity a department run was queued to use.
-- The selected computer runtime already occupies runtime_engine_kind/name;
-- these separate fields let an opted-in device fallback retain both its
-- primary runtime and the exact workspace API provider/model available when
-- the person sent the message.
--
-- Existing rows remain valid with NULL snapshots. Application code preserves
-- those legacy rows during rollout, but a newly promoted API fallback must
-- carry both fields and fails closed when the current account no longer
-- matches them.

ALTER TABLE dept_chat_runs ADD COLUMN runtime_api_provider TEXT;
ALTER TABLE dept_chat_runs ADD COLUMN runtime_api_model TEXT;

CREATE INDEX IF NOT EXISTS dept_chat_runs_runtime_api_idx
  ON dept_chat_runs (tenant_id, runtime_api_provider, runtime_api_model, status, created_at);
