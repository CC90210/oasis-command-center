-- 244 - OASIS's invoice seller address: Montreal to Collingwood, ON (CC confirmed
-- 2026-10-27). Apply after 180 (founders finances).
--
-- Client invoices print the seller address stored in fin_settings
-- (invoices-io.ts -> invoice-pdf.ts). lib/founders-finances/chart.ts now seeds
-- 141 Sixth Street, Collingwood, ON L9Y 1Z1, but its seeds are INSERT OR IGNORE
-- and never overwrite a row, so a database seeded before the move keeps the
-- Montreal address. This moves the OASIS row ONLY while it still holds exactly
-- the old seed: an address a founder typed in Finances settings is kept
-- (Codex review of #753).
--
-- After applying, this must return no rows:
--
--   SELECT entity_id FROM fin_settings WHERE entity_id = 'fin_ent_oasis' AND address_line1 = '6993 Decarie Blvd';
--
-- Safe to run again: once the row has moved, the WHERE matches nothing.

UPDATE fin_settings
   SET address_line1 = '141 Sixth Street',
       city = 'Collingwood',
       region = 'ON',
       postal_code = 'L9Y 1Z1',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE entity_id = 'fin_ent_oasis'
   AND address_line1 = '6993 Decarie Blvd'
   AND COALESCE(address_line2, '') = ''
   AND city = 'Montreal'
   AND region = 'QC'
   AND postal_code = 'H3W 0B5'
   AND country = 'Canada';
