ALTER TABLE public.application_lender_threads
  ADD COLUMN IF NOT EXISTS email_identity text NOT NULL DEFAULT 'sunbiz'
  CHECK (email_identity IN ('sunbiz', 'funmate'));

CREATE INDEX IF NOT EXISTS idx_application_lender_threads_email_identity
  ON public.application_lender_threads (tenant_id, email_identity, created_at DESC);

