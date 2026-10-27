-- 245 - The finance audit trail for bravo__244 (OASIS's invoice address moved
-- from Montreal to Collingwood, ON; CC confirmed 2026-10-27). Apply after 244.
--
-- bravo__244 moved the address and advanced updated_at, but kept the row's
-- previous updated_by and wrote no fin_audit_log entry, so the invoice seller
-- changed with no trace and the row still named an earlier migration as its
-- last editor (Codex review of #753). bravo__244 is in the ledger and cannot
-- change, so this records it the way an edit in Finances > Settings would, as
-- bravo__199 does: updated_by set, and one settings.updated row.
--
-- WHICH ROW. Only the one bravo__244 moved: the business entity, holding the
-- new address exactly, whose updated_by still carries bravo__199's mark (the
-- production row on 2026-10-27). A row seeded with the new address has no mark
-- and was never moved, so nothing is recorded for it; a founder's own edit
-- replaces the mark and is left alone.
--
-- WHY THIS ORDER (as bravo__199). The statements run one at a time and the
-- ledger is written only when both succeed. The mark comes first; the audit
-- row is written only while the row carries this migration's mark AND no audit
-- row from it exists, so a re-run changes nothing twice and writes no second
-- audit row.

UPDATE fin_settings
   SET updated_by = 'migration bravo__244'
 WHERE entity_id = 'fin_ent_oasis'
   AND address_line1 = '141 Sixth Street'
   AND city = 'Collingwood'
   AND region = 'ON'
   AND postal_code = 'L9Y 1Z1'
   AND updated_by = 'migration bravo__199';

INSERT INTO fin_audit_log (id, entity_id, actor, action, object_type, object_id, detail_json)
SELECT 'aud_' || lower(hex(randomblob(16))),
       'fin_ent_oasis',
       'migration bravo__244',
       'settings.updated',
       'settings',
       'fin_ent_oasis',
       '{"address":{"from":"6993 Decarie Blvd, Montreal, QC H3W 0B5","to":"141 Sixth Street, Collingwood, ON L9Y 1Z1"},"reason":"OASIS moved to Collingwood, ON (CC confirmed 2026-10-27; OCC #753)"}'
 WHERE EXISTS (SELECT 1 FROM fin_settings
                WHERE entity_id = 'fin_ent_oasis'
                  AND address_line1 = '141 Sixth Street'
                  AND updated_by = 'migration bravo__244')
   AND NOT EXISTS (SELECT 1 FROM fin_audit_log
                    WHERE entity_id = 'fin_ent_oasis'
                      AND actor = 'migration bravo__244'
                      AND action = 'settings.updated');
