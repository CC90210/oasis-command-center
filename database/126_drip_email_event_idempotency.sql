-- A sequence run can produce only one successful email-send telemetry event.
-- This makes the live writer and reconciliation worker safe to run concurrently.
CREATE UNIQUE INDEX IF NOT EXISTS ux_drip_email_events_run
  ON public.drip_email_events (tenant_id, drip_run_id);
