-- bravo__201_channel_accounts_twilio_lookup.sql
--
-- Twilio's webhooks find the workspace that owns a number by an index, not a
-- scan (W10a review R6, 2026-10-01).
--
-- An incoming text (/api/webhooks/twilio/sms-inbound) and a delivery report
-- (/api/webhooks/twilio/sms-status) name the workspace only by its Twilio
-- number (To / From) or its messaging service (MessagingServiceSid).
-- lib/sms/twilio-inbound.ts resolveTwilioInboundTenant looks that up in
-- channel_accounts, which lib/twilio/sender-route.ts now keeps in step with each
-- workspace's saved Twilio sender (one row per workspace, written on save,
-- Test and remove). The only index there today leads with tenant_id, which the
-- webhook does not know yet, so the lookup could not use it.
--
-- These two indexes let the lookup search by the number or the messaging
-- service directly. The lookup is an OR of the two, which SQLite answers with
-- one index per arm, so each index leads with its own column.
--
-- Additive only. The code works before this file is applied (the lookup reads
-- the same rows, unindexed) and after.

CREATE INDEX IF NOT EXISTS idx_channel_accounts_from_phone
  ON channel_accounts (from_phone);

CREATE INDEX IF NOT EXISTS idx_channel_accounts_twilio_mg
  ON channel_accounts (twilio_messaging_service_sid);
