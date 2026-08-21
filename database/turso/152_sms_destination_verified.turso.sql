-- 152_sms_destination_verified.turso.sql
--
-- Separate "we have positive evidence this number reaches a handset" from
-- "no reason to think it will fail".
--
-- sms_destination_health.textable already answers the second question and fails
-- OPEN on an unknown number, deliberately: a number cannot be learned about
-- without being tried once, and failing closed there would stop the channel.
--
-- That default is right in general and wrong for the backlog we are about to
-- send into. Measured 2026-08-20, the follow-up cohort is 347 leads and 100% of
-- their numbers came off an application form; that provenance has delivered 0
-- of 53. None of them has failed twice yet and none carries a line type, so
-- `textable` says yes to all 347 — correctly, by its own rule. Sending 40/day
-- into that fails nearly every message, and since 3 consecutive carrier
-- failures bench a line and 5 halt a wire, the programme would stop itself
-- inside an hour.
--
-- So `verified` is the stricter flag the sender uses while the lookup backlog
-- drains. Default 0: nothing is verified until something proves it, which is
-- the safe direction for a column that gates sending.

ALTER TABLE sms_destination_health ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;

-- The sender asks "give me the verified ones for this tenant" on every
-- dispatch, so it wants its own index rather than riding the textable one.
CREATE INDEX IF NOT EXISTS idx_sms_dest_health_verified
  ON sms_destination_health (tenant_id, verified);
