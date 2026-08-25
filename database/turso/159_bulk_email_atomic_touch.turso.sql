-- Migration 156's AFTER INSERT trigger records canonical Last Touch inside the
-- same SQLite transaction as every interaction. Bulk queue rows additionally
-- fail closed when their target is not a real tenant lead, so the API can never
-- count a queued recipient whose touch update affected zero rows.
CREATE TRIGGER IF NOT EXISTS "require_bulk_email_touch_target"
BEFORE INSERT ON "lead_interactions"
WHEN NEW."agent_source" = 'dashboard_bulk_email_v2'
 AND (
   NEW."lead_id" IS NULL
   OR NEW."created_at" IS NULL
   OR NOT EXISTS (
     SELECT 1
       FROM "tenant_records"
      WHERE "id" = NEW."lead_id"
        AND "tenant_id" = NEW."tenant_id"
        AND "entity_type" = 'lead'
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'bulk_email_touch_target_missing');
END;
