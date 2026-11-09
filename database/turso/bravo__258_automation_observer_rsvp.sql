-- RSVP facts survive provider outages, scoped to a tenant and invitation.
CREATE TABLE IF NOT EXISTS founder_meeting_rsvp_state (
  tenant_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  response TEXT CHECK (response IS NULL OR response IN ('accepted','declined','tentative','needsAction')),
  observed_at TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  PRIMARY KEY (tenant_id,appointment_id,revision,event_id)
);
CREATE INDEX IF NOT EXISTS idx_rsvp_tenant_observed ON founder_meeting_rsvp_state(tenant_id,observed_at);

ALTER TABLE health_alert_state ADD COLUMN recent_verdicts_json TEXT;
ALTER TABLE health_alert_state ADD COLUMN delivery_status TEXT;
ALTER TABLE health_alert_state ADD COLUMN delivery_updated_at TEXT;
ALTER TABLE health_alert_state ADD COLUMN delivery_claim_token TEXT;
ALTER TABLE health_alert_state ADD COLUMN delivery_receipts_json TEXT;
ALTER TABLE health_alert_state ADD COLUMN delivery_retry_at TEXT;

-- Claim the minute before reporting. The next minute supersedes a crashed pass.
CREATE TABLE IF NOT EXISTS automation_observer_ticks (
  tenant_id TEXT NOT NULL,
  tick_at TEXT NOT NULL,
  completed_at TEXT,
  verdict TEXT,
  PRIMARY KEY (tenant_id,tick_at)
);
