-- bravo__223_public_funnel_booking_overlap_guard.sql
--
-- Serialize overlapping OASIS founder calls, not just calls with the same
-- start time. This matters for 45-minute COMMAND/FLEET discovery calls offered
-- on a 30-minute grid. SQLite/Turso evaluates these guards inside the write
-- transaction, before either caller proceeds to Google Calendar.

CREATE TRIGGER IF NOT EXISTS call_appointments_oasis_founder_overlap_insert
BEFORE INSERT ON call_appointments
WHEN NEW.tenant_id = 'ef8d389e-3f15-43f2-ae00-3660f69a1452'
  AND NEW.status = 'scheduled'
  AND NEW.meeting_kind = 'founder_audit'
  AND NEW.calendar_status IN ('creating', 'verified')
BEGIN
  SELECT RAISE(ABORT, 'founder_slot_overlap')
  WHERE EXISTS (
    SELECT 1
    FROM call_appointments AS existing
    WHERE existing.tenant_id = NEW.tenant_id
      AND existing.status = 'scheduled'
      AND existing.meeting_kind = 'founder_audit'
      AND existing.calendar_status IN ('creating', 'verified')
      AND julianday(existing.scheduled_for) <
          julianday(NEW.scheduled_for) + (COALESCE(NEW.duration_minutes, 15) / 1440.0)
      AND julianday(existing.scheduled_for) +
          (COALESCE(existing.duration_minutes, 15) / 1440.0) > julianday(NEW.scheduled_for)
  );
END;

CREATE TRIGGER IF NOT EXISTS call_appointments_oasis_founder_overlap_update
BEFORE UPDATE OF tenant_id, scheduled_for, duration_minutes, status, meeting_kind, calendar_status
ON call_appointments
WHEN NEW.tenant_id = 'ef8d389e-3f15-43f2-ae00-3660f69a1452'
  AND NEW.status = 'scheduled'
  AND NEW.meeting_kind = 'founder_audit'
  AND NEW.calendar_status IN ('creating', 'verified')
BEGIN
  SELECT RAISE(ABORT, 'founder_slot_overlap')
  WHERE EXISTS (
    SELECT 1
    FROM call_appointments AS existing
    WHERE existing.id <> NEW.id
      AND existing.tenant_id = NEW.tenant_id
      AND existing.status = 'scheduled'
      AND existing.meeting_kind = 'founder_audit'
      AND existing.calendar_status IN ('creating', 'verified')
      AND julianday(existing.scheduled_for) <
          julianday(NEW.scheduled_for) + (COALESCE(NEW.duration_minutes, 15) / 1440.0)
      AND julianday(existing.scheduled_for) +
          (COALESCE(existing.duration_minutes, 15) / 1440.0) > julianday(NEW.scheduled_for)
  );
END;
