-- bravo__234_tenants_kixie_business_id_unique.sql - one workspace per Kixie business id (2026-10-20).
--
-- The Kixie receiver (app/api/webhooks/kixie) routes each call and SMS event to the one workspace whose
-- custom_fields.kixie_business_id matches, and answers 503 when two do. sync-webhooks links a workspace only
-- when no other holds the id, read twice (app/api/integrations/kixie/sync-webhooks), but two workspaces syncing
-- the same id at the same moment could both read "nobody" and both link it (review of #716). This index makes
-- the database refuse the second; the route answers that refusal with 409 business_id_in_use.
--
-- An empty id is no id, so it is left out, and so is a row whose custom_fields is not valid JSON: indexed, that
-- row's every write would fail on json_extract. Production held exactly one linked id, and no malformed row,
-- when this was written, so the index builds clean.
--
-- Additive only. Runs once: scripts/apply_turso_migration.py records it in its ledger and skips it after that.

CREATE UNIQUE INDEX IF NOT EXISTS "tenants_kixie_business_id_key"
  ON "tenants" (json_extract("custom_fields", '$.kixie_business_id'))
  WHERE json_valid("custom_fields")
    AND json_extract("custom_fields", '$.kixie_business_id') IS NOT NULL
    AND json_extract("custom_fields", '$.kixie_business_id') != '';
