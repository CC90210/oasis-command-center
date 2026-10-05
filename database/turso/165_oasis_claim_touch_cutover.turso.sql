-- 165 - close the claim-touch cutover gap for OASIS cold leads.
--
-- The claim endpoint now records every successful claim in lead_interactions,
-- which also advances the canonical last_contacted_at clock through migration
-- 156's trigger. Claims made before that endpoint reached production still
-- have claimed_at/assigned_to on the lead but no ledger row, so they appear
-- stale immediately after a rep claims them. Backfill only that exact shape.
--
-- The deterministic id and NOT EXISTS predicate make this safe to re-run. The
-- tenant + sales_motion gates keep warm form leads and every non-OASIS tenant
-- out of the cold-sales ledger.
INSERT OR IGNORE INTO "lead_interactions" (
  "id",
  "tenant_id",
  "lead_id",
  "type",
  "channel",
  "direction",
  "agent_source",
  "actor_user_id",
  "subject",
  "content",
  "content_preview",
  "metadata",
  "created_at"
)
SELECT
  'oasis-claim-cutover:' || tr."tenant_id" || ':' || tr."id",
  tr."tenant_id",
  tr."id",
  'stage_changed',
  'system',
  'internal',
  'web_leads_claim_backfill',
  json_extract(tr."data", '$.assigned_to'),
  'Lead claimed',
  'Lead claimed and entered Assigned.',
  'Lead claimed and entered Assigned.',
  json_object(
    'action', 'claim',
    'to', 'assigned',
    'assigned_to', json_extract(tr."data", '$.assigned_to'),
    'backfilled', 1
  ),
  json_extract(tr."data", '$.claimed_at')
FROM "tenant_records" AS tr
WHERE tr."entity_type" = 'lead'
  AND tr."tenant_id" IN (
    'ef8d389e-3f15-43f2-ae00-3660f69a1452',
    '42423fde-be8b-454f-932a-750e8c9b743d'
  )
  AND json_extract(tr."data", '$.sales_motion') = 'cold_outbound'
  AND nullif(trim(json_extract(tr."data", '$.assigned_to')), '') IS NOT NULL
  AND nullif(trim(json_extract(tr."data", '$.claimed_at')), '') IS NOT NULL
  AND julianday(json_extract(tr."data", '$.claimed_at')) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "lead_interactions" AS li
    WHERE li."tenant_id" = tr."tenant_id"
      AND li."lead_id" = tr."id"
      AND (
        json_extract(li."metadata", '$.action') = 'claim'
        OR li."agent_source" IN ('web_leads_claim', 'web_leads_claim_backfill')
      )
  );
