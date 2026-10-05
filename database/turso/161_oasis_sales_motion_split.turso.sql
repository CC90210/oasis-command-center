-- 161 - keep the cold calling engine separate from warm inbound forms.
--
-- The Pipeline is the cold outbound operating system. Form submissions remain
-- visible in Forms and retain website-sales context, but must never silently
-- enter an opener's claimed-lead queue. The application writers now stamp this
-- discriminator at source; these updates classify historical OASIS rows once.

UPDATE "tenant_records"
SET "data" = json_set("data", '$.sales_motion', 'inbound_warm'),
    "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE "entity_type" = 'lead'
  AND "tenant_id" IN (
    'ef8d389e-3f15-43f2-ae00-3660f69a1452',
    '42423fde-be8b-454f-932a-750e8c9b743d'
  )
  AND json_extract("data", '$.sales_motion') IS NULL
  AND json_extract("data", '$.created_from_form_id') IS NOT NULL;

UPDATE "tenant_records"
SET "data" = json_set("data", '$.sales_motion', 'cold_outbound'),
    "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE "entity_type" = 'lead'
  AND "tenant_id" IN (
    'ef8d389e-3f15-43f2-ae00-3660f69a1452',
    '42423fde-be8b-454f-932a-750e8c9b743d'
  )
  AND json_extract("data", '$.sales_motion') IS NULL
  AND json_extract("data", '$.created_from_form_id') IS NULL
  AND (
    json_extract("data", '$.claimed_at') IS NOT NULL
    OR json_extract("data", '$.webdev_source_business_id') IS NOT NULL
    OR json_extract("data", '$.stage') IN (
      'assigned', 'attempting_contact', 'connected', 'qualified',
      'founder_meeting_booked', 'demo_completed', 'proposal_sent', 'won',
      'lost', 'onboarding', 'in_build', 'client_review', 'launched'
    )
  );
