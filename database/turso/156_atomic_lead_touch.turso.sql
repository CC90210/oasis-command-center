-- Every durable interaction is a touch. Keep the canonical lead fields in the
-- same database write boundary so a new contact path cannot silently forget
-- to update the Pipeline board/SLA clock.
--
-- julianday(NULL/invalid) is NULL, so malformed legacy timestamps never beat
-- a valid interaction timestamp. The strict greater-than comparison preserves
-- the newer value when late/out-of-order events are inserted.
CREATE TRIGGER IF NOT EXISTS "lead_interactions_contact_touch"
AFTER INSERT ON "lead_interactions"
WHEN NEW."lead_id" IS NOT NULL AND NEW."created_at" IS NOT NULL
BEGIN
  UPDATE "tenant_records"
     SET "data" = json_set(
           CASE
             WHEN json_valid("data") THEN
               CASE WHEN json_type("data") = 'object' THEN "data" ELSE '{}' END
             ELSE '{}'
           END,
           '$.last_contacted_at',
           CASE
             WHEN julianday(json_extract(
                    CASE WHEN json_valid("data") THEN "data" ELSE '{}' END,
                    '$.last_contacted_at'
                  )) > julianday(NEW."created_at")
               THEN json_extract(
                 CASE WHEN json_valid("data") THEN "data" ELSE '{}' END,
                 '$.last_contacted_at'
               )
             ELSE NEW."created_at"
           END
         ),
         "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE "id" = NEW."lead_id"
     AND "tenant_id" = NEW."tenant_id"
     AND "entity_type" = 'lead';
END;

CREATE TRIGGER IF NOT EXISTS "lead_interactions_call_touch"
AFTER INSERT ON "lead_interactions"
WHEN NEW."lead_id" IS NOT NULL
 AND NEW."created_at" IS NOT NULL
 AND lower(coalesce(NEW."channel", '')) = 'phone'
BEGIN
  UPDATE "tenant_records"
     SET "data" = json_set(
           CASE
             WHEN json_valid("data") THEN
               CASE WHEN json_type("data") = 'object' THEN "data" ELSE '{}' END
             ELSE '{}'
           END,
           '$.last_call_at',
           CASE
             WHEN julianday(json_extract(
                    CASE WHEN json_valid("data") THEN "data" ELSE '{}' END,
                    '$.last_call_at'
                  )) > julianday(NEW."created_at")
               THEN json_extract(
                 CASE WHEN json_valid("data") THEN "data" ELSE '{}' END,
                 '$.last_call_at'
               )
             ELSE NEW."created_at"
           END
         ),
         "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE "id" = NEW."lead_id"
     AND "tenant_id" = NEW."tenant_id"
     AND "entity_type" = 'lead';
END;
