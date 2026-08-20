-- 150_sms_receipt_purpose.turso.sql
--
-- Distinguish a CANARY send from a merchant-facing drip send.
--
-- The line-commissioning canary (lib/sms/canary-core.ts) deliberately reuses
-- sms_delivery_receipts rather than owning a private table, because the whole
-- point of the canary is to prove the RECEIPT PIPELINE works end to end. A
-- separate table would let the canary pass while the pipeline the drips depend
-- on stayed broken -- which is exactly the failure of 2026-08-16 to 08-20,
-- where receipts silently stopped resolving and every downstream guard went
-- blind while reporting healthy.
--
-- Defaulting to 'drip' keeps every existing row meaning what it already meant.
-- Canary rows carry lead_id NULL and drip_run_id NULL, so they never appear in
-- the per-sequence scoreboard (which joins on drip_run_id); they DO feed the
-- send breaker, and that is intended -- a canary the carrier refuses is real
-- evidence that the line is bad.

ALTER TABLE sms_delivery_receipts ADD COLUMN purpose TEXT NOT NULL DEFAULT 'drip';

-- The canary reads "every attempt on this line, newest first". Without this the
-- lookup is a full scan of a table that grows with every text ever sent.
CREATE INDEX IF NOT EXISTS idx_sms_receipts_purpose_line
  ON sms_delivery_receipts (tenant_id, purpose, from_number, sent_at DESC);
