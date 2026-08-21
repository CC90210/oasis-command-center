-- 155 — give the OASIS funnel leads the field names OASIS actually reads.
--
-- THIS IS THE FILE THAT ACTUALLY RUNS. Production is
-- EMPIRE_DATA_BACKEND=turso_cloud; the Postgres companion (database/155) is the
-- reference dialect.
--
-- ===========================================================================
-- WHAT WAS WRONG
-- ===========================================================================
-- app/api/forms/submit read contact-field names generously (a form may call a
-- field anything) but WROTE them rigidly: every tenant got SunBiz's vocabulary,
-- `contact_name` / `business_name`. OASIS's lead entity declares `name`
-- (REQUIRED) and `company` instead — lib/manifest/seeds.ts OASIS_SEED.
--
-- So an inbound funnel lead arrived in a shape the OASIS lead profile has no
-- field to render, and /pipeline's ?q= search — which matches d.name and
-- d.company — could never find one.
--
-- Measured on tenant oasis-ai-cc before this ran:
--     31,028 leads carry `name`
--          3 leads carry `contact_name`
-- Those 3 are the funnel leads. Everything else predates the funnel and is
-- already correct, which is why this read as "only the newest leads are
-- broken" — the most confusing possible shape for the bug.
--
-- The writer is fixed in the same change; this repairs the rows it already
-- wrote. Both halves are needed: fixing only the writer strands these three
-- forever, fixing only the data means the next submission recreates them.
--
-- ===========================================================================
-- WHY COALESCE AND NOT A BLIND OVERWRITE
-- ===========================================================================
-- A row could carry BOTH spellings — for instance a lead created by the funnel
-- and later edited through the OASIS record form. In that case `name` is the
-- value a human last confirmed through the UI, and it wins. json_patch only
-- supplies the fallback where the canonical key is absent, so this migration
-- can never overwrite a value someone typed.
--
-- The old keys are LEFT IN PLACE rather than removed. They are harmless, other
-- readers already tolerate both, and deleting source data to tidy a JSON blob
-- is not a trade worth making — especially for three rows.
--
-- Scoped to entity_type='lead' AND the two OASIS tenants by id. SunBiz's
-- `submissions` tenant genuinely uses contact_name/business_name as its
-- canonical names; running this there would corrupt its shape, not repair it.

UPDATE "tenant_records"
SET "data" = json_patch(
      "data",
      json_object(
        'name',    COALESCE(json_extract("data", '$.name'),    json_extract("data", '$.contact_name')),
        'company', COALESCE(json_extract("data", '$.company'), json_extract("data", '$.business_name'))
      )
    ),
    "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE "entity_type" = 'lead'
  AND "tenant_id" IN (
    'ef8d389e-3f15-43f2-ae00-3660f69a1452',  -- oasis-ai-cc  (the agency CRM)
    '42423fde-be8b-454f-932a-750e8c9b743d'   -- oasis-webdev (the website-sales book)
  )
  -- Only rows actually missing a canonical value AND holding a legacy one.
  -- Without this the statement would rewrite all 31k rows to their own values:
  -- a no-op in content, a full table write in cost, and 31k pointless
  -- updated_at bumps that would make every lead look freshly touched.
  AND (
    (json_extract("data", '$.name') IS NULL    AND json_extract("data", '$.contact_name')  IS NOT NULL)
    OR
    (json_extract("data", '$.company') IS NULL AND json_extract("data", '$.business_name') IS NOT NULL)
  );
