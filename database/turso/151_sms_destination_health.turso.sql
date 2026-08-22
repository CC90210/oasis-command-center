-- 151_sms_destination_health.turso.sql
--
-- Which merchant phone numbers can actually receive a text.
--
-- WHY A TABLE AND NOT A JOIN. sms_delivery_receipts stores only `to_last4`
-- (deliberate PII minimisation), which is far too coarse to key a phone number
-- on -- four digits collide constantly across a few thousand leads. The verdict
-- therefore has to be computed by joining a receipt back to its drip_run and
-- then to the lead's phone, which is too expensive to repeat on every
-- enrolment. This table is that join, materialised.
--
-- Last 10 digits, matching sunbiz_phone_suppressions. Comparing a formatted
-- number silently never matches, which is the single most repeated bug in this
-- estate.
--
-- THIS IS NOT A SUPPRESSION LIST. An opt-out is a legal instruction from a
-- person; this is a technical fact about a handset. They are kept apart on
-- purpose: conflating them would let a landline look like a withdrawal of
-- consent, and worse, would let a consent record be cleared by a carrier blip.

CREATE TABLE IF NOT EXISTS sms_destination_health (
  tenant_id     TEXT NOT NULL,
  phone_last10  TEXT NOT NULL,
  delivered     INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  -- Denormalised verdict so the enroller reads one boolean rather than
  -- re-deriving the rule. Recomputed by refreshDestinationHealth(); the rule
  -- itself lives in lib/sms/destination-health-core.ts and is the only writer.
  textable      INTEGER NOT NULL DEFAULT 1,
  reason        TEXT,
  last_seen_at  TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, phone_last10)
);

CREATE INDEX IF NOT EXISTS idx_sms_dest_health_untextable
  ON sms_destination_health (tenant_id, textable);
