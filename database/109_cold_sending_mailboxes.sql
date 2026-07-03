-- 109_cold_sending_mailboxes.sql
-- Cold/marketing sending mailbox POOL — the backend registry that lets the system
-- route COLD email blasts through SEPARATE domains (never the primary
-- sunbizfunding.com deal/lender domain). Each row is one sending mailbox on a
-- dedicated cold domain (app-password over SMTP for now; provider column leaves
-- room for API providers like Smartlead/Instantly later). The router in
-- lib/integrations/cold-sending.ts picks a ready+under-cap mailbox per send and
-- FAILS CLOSED (blocks the cold send) when the pool is empty — cold mail must
-- never fall back to the primary domain.
--
-- Secret handling: the mailbox app password is stored ENCRYPTED (AES-256-GCM via
-- lib/field-encryption, BRAVO_FIELD_ENCRYPTION_KEY) in app_password_enc. Never
-- store or return the plaintext.
--
-- House rule (RLS in the same migration): row level security ENABLED + FORCED,
-- anon/authenticated REVOKED, service-role-only policy — this is PII-adjacent
-- credential infrastructure, so no client role may ever read it directly.

CREATE TABLE IF NOT EXISTS cold_sending_mailboxes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  domain          text NOT NULL,
  address         text NOT NULL,
  provider        text NOT NULL DEFAULT 'app_password',   -- app_password | smartlead | instantly | ...
  app_password_enc text,                                  -- AES-256-GCM packed; null for API providers
  api_ref         text,                                   -- non-secret pointer for API providers
  daily_cap       integer NOT NULL DEFAULT 30,            -- per-mailbox per-day send ceiling (cold: keep low)
  sends_today     integer NOT NULL DEFAULT 0,
  sends_date      date,                                   -- the date sends_today is counted for; reset on rollover
  last_send_at    timestamptz,
  warmup_status   text NOT NULL DEFAULT 'warming'
                    CHECK (warmup_status IN ('warming', 'ready', 'paused')),
  active          boolean NOT NULL DEFAULT true,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, address)
);

CREATE INDEX IF NOT EXISTS idx_cold_mb_tenant_ready
  ON cold_sending_mailboxes (tenant_id, active, warmup_status, last_send_at);

-- RLS: service-role only. No anon/authenticated access to credential rows.
ALTER TABLE cold_sending_mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cold_sending_mailboxes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON cold_sending_mailboxes FROM anon, authenticated;

DROP POLICY IF EXISTS cold_sending_mailboxes_service_all ON cold_sending_mailboxes;
CREATE POLICY cold_sending_mailboxes_service_all
  ON cold_sending_mailboxes
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
