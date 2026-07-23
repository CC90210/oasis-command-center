-- backfill_b2717cbf.sql — documented, manual, idempotent reconciliation for
-- ONE known envelope: b2717cbf-1030-440c-ac33-879d580fa7df.
--
-- CONTEXT (B2, 2026-07-23): this envelope completed with signed_document_id
-- left NULL. Root cause traced to lib/esign/storage.ts::uploadEsignSignedPdf():
-- when an envelope has NO lead_id, the signed PDF is uploaded straight to the
-- Storage bucket (path `${tenantId}/esign/${envelopeId}/signed_<name>`)
-- WITHOUT creating a corresponding `lead_documents` row — so `documentId`
-- returned to the route is null, and app/api/sign/[token]/route.ts writes
-- that null straight into `esign_envelopes.signed_document_id`. The route's
-- FORWARD fix (this same commit) does not change this upload behavior for
-- lead-less envelopes (out of scope — would require deciding whether
-- lead-less signed PDFs should always get a lead_documents row, a bigger
-- product decision); it only stops the *silent* half of the bug by stamping
-- `unlinked_reason` when both lead_id and application_id are null.
--
-- This script does NOT run automatically and is NOT applied by
-- scripts/apply_migration.py (it is a one-off data reconciliation, not a
-- schema migration — hence it lives outside the numbered 1xx_*.sql series).
--
-- HOW TO RUN (CC, manual, after review):
--   1. Run PART 1 alone in the Supabase SQL editor. Read the single row it
--      returns. Confirm signed_storage_key actually points at a real object
--      in the `lead-documents` bucket (Storage → browse to that path) before
--      touching anything.
--   2. Only if PART 1 confirms the PDF exists in storage but has no
--      lead_documents row, decide whether to register one (PART 2, commented
--      out by default — uncomment deliberately).
--   3. PART 3 is safe to run unconditionally — it only stamps
--      unlinked_reason and only if lead_id/application_id are both null AND
--      the column is still null (idempotent — reruns are no-ops).

-- ============================================================
-- PART 1 — diagnostic read. Run this FIRST. Do not skip.
-- ============================================================
select
  id, tenant_id, status, lead_id, application_id, unlinked_reason,
  source_storage_key, signed_storage_key, signed_document_id, signed_pdf_sha256,
  completed_at, created_at
from public.esign_envelopes
where id = 'b2717cbf-1030-440c-ac33-879d580fa7df';

-- ============================================================
-- PART 2 — OPTIONAL, register the signed PDF as a lead_documents row so
-- signed_document_id can be backfilled. ONLY run this if:
--   (a) PART 1 shows signed_storage_key IS NOT NULL (the file was actually
--       uploaded), AND
--   (b) you have manually verified the object exists at that path in the
--       `lead-documents` Storage bucket, AND
--   (c) signed_document_id IS still NULL, AND
--   (d) you have confirmed `lead_documents.lead_id` accepts NULL in the live
--       schema (this repo's tracked migrations never CREATE TABLE
--       lead_documents — it predates the numbered migration series — so its
--       exact constraints must be checked live, e.g. via the Supabase table
--       editor or `\d lead_documents`, before relying on this INSERT).
-- Left commented out — uncomment and fill in <TENANT_ID>/<UPLOADED_BY> from
-- PART 1's output before running. lead_id is intentionally NOT set here
-- (this branch only exists because the envelope has no lead) — the new
-- lead_documents row is unattached, matching the same "standalone" shape
-- PART 3 stamps unlinked_reason for.
-- ============================================================
-- with new_doc as (
--   insert into public.lead_documents (
--     tenant_id, lead_id, storage_path, filename, mime_type, doc_type,
--     uploaded_by, size_bytes, metadata
--   )
--   select
--     e.tenant_id, null, e.signed_storage_key,
--     split_part(e.signed_storage_key, '/', -1),
--     'application/pdf', 'esigned_document',
--     e.created_by, 0, jsonb_build_object('esign_envelope_id', e.id, 'backfilled', true)
--   from public.esign_envelopes e
--   where e.id = 'b2717cbf-1030-440c-ac33-879d580fa7df'
--     and e.signed_document_id is null
--     and e.signed_storage_key is not null
--   returning id
-- )
-- update public.esign_envelopes
-- set signed_document_id = (select id from new_doc)
-- where id = 'b2717cbf-1030-440c-ac33-879d580fa7df'
--   and signed_document_id is null
--   and exists (select 1 from new_doc);

-- ============================================================
-- PART 3 — safe, idempotent. Stamps unlinked_reason if (and only if) this
-- envelope truly has no lead/application link and the column is still null.
-- Requires migration 124_esign_unlinked_reason.sql to already be applied.
-- ============================================================
update public.esign_envelopes
set unlinked_reason = 'standalone_document_no_lead_or_application'
where id = 'b2717cbf-1030-440c-ac33-879d580fa7df'
  and lead_id is null
  and application_id is null
  and unlinked_reason is null;
