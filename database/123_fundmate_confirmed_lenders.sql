-- Preserve the existing SunBiz lender records and create isolated FundMate
-- network entries only for contacts confirmed in the FundMate Sent mailbox.
INSERT INTO public.tenant_records (tenant_id, entity_type, data)
SELECT
  source.tenant_id,
  'lender',
  source.data || jsonb_build_object(
    'lender_network', 'funmate',
    'fundmate_source_lender_id', source.id::text,
    'active', true
  )
FROM public.tenant_records AS source
WHERE source.entity_type = 'lender'
  AND source.id IN (
    '4ae3bdc8-9532-53ab-95e4-79dc66c2a6c7'::uuid,
    'd5752959-1c0a-5bc0-9fc6-8b84df74b39b'::uuid
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.tenant_records AS existing
    WHERE existing.tenant_id = source.tenant_id
      AND existing.entity_type = 'lender'
      AND existing.data->>'lender_network' = 'funmate'
      AND existing.data->>'fundmate_source_lender_id' = source.id::text
  );
