-- bravo__199_fin_settings_support_contact.sql
--
-- support@oasisai.work is the client-facing contact (OCC PR #510). Client
-- invoice PDFs print the OASIS business entity's fin_settings.contact_email as
-- the seller contact (lib/founders-finances/invoices-io.ts -> invoice-pdf.ts).
-- The row was seeded with a founder's login address; the seed now uses
-- OASIS_SUPPORT_EMAIL (lib/founders-finances/chart.ts), and this updates the
-- existing row the way an edit in Finances > Settings would: updated_by set,
-- and a settings.updated row in fin_audit_log.
--
-- Guarded: both statements act only on the business entity, and only while it
-- still holds the old seeded value, so a contact a founder set by hand is left
-- alone and a re-run changes nothing. The audit row is written first, under
-- the same condition, so it can never describe a change that did not happen.
-- The founders' personal books (fin_ent_cc, fin_ent_adon) are identities and do
-- not change.

INSERT INTO fin_audit_log (id, entity_id, actor, action, object_type, object_id, detail_json)
SELECT 'aud_' || lower(hex(randomblob(16))),
       'fin_ent_oasis',
       'migration bravo__199',
       'settings.updated',
       'settings',
       'fin_ent_oasis',
       '{"contact_email":{"from":"conaugh@oasisai.work","to":"support@oasisai.work"},"reason":"support@ is the client-facing contact (OCC #510)"}'
 WHERE EXISTS (SELECT 1 FROM fin_settings
                WHERE entity_id = 'fin_ent_oasis' AND contact_email = 'conaugh@oasisai.work');

UPDATE fin_settings
   SET contact_email = 'support@oasisai.work',
       updated_by = 'migration bravo__199',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE entity_id = 'fin_ent_oasis'
   AND contact_email = 'conaugh@oasisai.work';
