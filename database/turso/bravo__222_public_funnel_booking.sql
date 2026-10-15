-- bravo__222_public_funnel_booking.sql
--
-- Link a Google founder-audit appointment to each founder's private Schedule
-- mirror. The four columns are provider receipts/foreign identifiers, not a
-- second source of calendar truth. calendar_events keeps its existing owner
-- boundary: every read still filters tenant_id + user_id.

ALTER TABLE calendar_events ADD COLUMN lead_id TEXT;
ALTER TABLE calendar_events ADD COLUMN appointment_id TEXT;
ALTER TABLE calendar_events ADD COLUMN provider TEXT;
ALTER TABLE calendar_events ADD COLUMN provider_event_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_appointment_owner_uq
  ON calendar_events (tenant_id, user_id, appointment_id)
  WHERE appointment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS calendar_events_lead_idx
  ON calendar_events (tenant_id, lead_id)
  WHERE lead_id IS NOT NULL;

-- The appointment intent is written before Google is called, so this index is
-- also the slot lock. It closes the availability-read/create race without a
-- second table that could drift from cancellations. Cancelled rows fall out of
-- the predicate and naturally release their time. Scope this invariant to the
-- OASIS workspace: other tenants may intentionally run multiple founder-audit
-- calendars with separate hosts.
CREATE UNIQUE INDEX IF NOT EXISTS call_appointments_oasis_founder_slot_uq
  ON call_appointments (tenant_id, scheduled_for)
  WHERE tenant_id = 'ef8d389e-3f15-43f2-ae00-3660f69a1452'
    AND status = 'scheduled'
    AND meeting_kind = 'founder_audit'
    AND calendar_status IN ('creating', 'verified');
