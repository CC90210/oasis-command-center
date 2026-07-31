-- Exact outbound email telemetry for loop/drip sequences.
CREATE TABLE IF NOT EXISTS public.drip_email_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  merchant_id uuid NOT NULL,
  sequence_id uuid NOT NULL REFERENCES public.drip_sequences(id) ON DELETE CASCADE,
  drip_run_id uuid REFERENCES public.drip_runs(id) ON DELETE SET NULL,
  step_index integer NOT NULL,
  recipient_email text NOT NULL,
  subject_line text NOT NULL,
  payload_text text NOT NULL,
  payload_html text NOT NULL,
  provider_message_id text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drip_email_events_tenant_sent
  ON public.drip_email_events (tenant_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_drip_email_events_merchant
  ON public.drip_email_events (tenant_id, merchant_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_drip_email_events_sequence
  ON public.drip_email_events (tenant_id, sequence_id, sent_at DESC);

ALTER TABLE public.drip_email_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY drip_email_events_tenant_select
  ON public.drip_email_events
  FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id
      FROM public.user_profiles
      WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY drip_email_events_service_insert
  ON public.drip_email_events
  FOR INSERT
  TO service_role
  WITH CHECK (true);

COMMENT ON TABLE public.drip_email_events IS
  'Immutable exact-payload telemetry for successfully dispatched loop-sequence emails.';
