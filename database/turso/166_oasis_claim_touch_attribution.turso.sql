-- 166 - keep historical claim activity attributed to the opener.
--
-- Migration 165 reconstructs a missing claim event from the lead's current
-- assignment. That is exact for leads still in Assigned, but a progressed
-- lead may now belong to a founder or builder while attributed_rep_user_id
-- preserves the opener who actually claimed it. Migrations are immutable once
-- applied, so repair those reconstructed rows forward instead of rewriting the
-- 165 ledger entry.
UPDATE "lead_interactions" AS li
SET "actor_user_id" = (
      SELECT coalesce(
        nullif(trim(json_extract(tr."data", '$.attributed_rep_user_id')), ''),
        json_extract(tr."data", '$.assigned_to')
      )
      FROM "tenant_records" AS tr
      WHERE tr."tenant_id" = li."tenant_id"
        AND tr."id" = li."lead_id"
        AND tr."entity_type" = 'lead'
    ),
    "metadata" = json_set(
      CASE
        WHEN json_valid(li."metadata") AND json_type(li."metadata") = 'object'
          THEN li."metadata"
        ELSE '{}'
      END,
      '$.assigned_to',
      (
        SELECT coalesce(
          nullif(trim(json_extract(tr."data", '$.attributed_rep_user_id')), ''),
          json_extract(tr."data", '$.assigned_to')
        )
        FROM "tenant_records" AS tr
        WHERE tr."tenant_id" = li."tenant_id"
          AND tr."id" = li."lead_id"
          AND tr."entity_type" = 'lead'
      ),
      '$.attribution_repaired', 1
    )
WHERE li."agent_source" = 'web_leads_claim_backfill'
  AND li."tenant_id" IN (
    'ef8d389e-3f15-43f2-ae00-3660f69a1452',
    '42423fde-be8b-454f-932a-750e8c9b743d'
  )
  AND EXISTS (
    SELECT 1
    FROM "tenant_records" AS tr
    WHERE tr."tenant_id" = li."tenant_id"
      AND tr."id" = li."lead_id"
      AND tr."entity_type" = 'lead'
      AND nullif(trim(json_extract(tr."data", '$.attributed_rep_user_id')), '') IS NOT NULL
      AND json_extract(tr."data", '$.attributed_rep_user_id') <> coalesce(li."actor_user_id", '')
  );
