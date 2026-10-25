-- bravo__235_revoke_former_oasis_operator.sql
--
-- OASIS AI Solutions became a sole proprietorship owned and operated by
-- Conaugh McKenna on 2026-10-21. Preserve the former operator grant as history,
-- but revoke it so a later profile/membership change cannot restore platform
-- authority by accident. Idempotent: an already-revoked row is unchanged.

UPDATE platform_operators
   SET revoked_at = '2026-10-21T18:15:00Z',
       note = 'Former OASIS collaborator; operator authority revoked 2026-10-21 when OASIS became CC sole proprietorship'
 WHERE auth_user_id = '67036c9a-de2e-47cd-89bd-af19004585b1'
   AND revoked_at IS NULL;

-- Remove the former collaborator from the live public-booking host list while
-- retaining every other setting CC selected. This is deliberately conditional
-- on the exact tenant and auth user id and is safe to re-run.
UPDATE booking_settings
   SET doc = json_set(
         doc,
         '$.hosts',
         json((
           SELECT json_group_array(json(host.value))
             FROM json_each(booking_settings.doc, '$.hosts') AS host
            WHERE COALESCE(json_extract(host.value, '$.userId'), '') <> '67036c9a-de2e-47cd-89bd-af19004585b1'
         ))
       ),
       version = version + 1,
       updated_at = '2026-10-21T18:15:00Z',
       updated_by = 'migration bravo__235'
 WHERE tenant_id = 'ef8d389e-3f15-43f2-ae00-3660f69a1452'
   AND EXISTS (
         SELECT 1
           FROM json_each(booking_settings.doc, '$.hosts') AS host
          WHERE json_extract(host.value, '$.userId') = '67036c9a-de2e-47cd-89bd-af19004585b1'
       );
